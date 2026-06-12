/**
 * Pre-merge conflict detection for worktree-based parallel execution
 * (pln#396). Before lanes are merged back, surface which worktrees touch
 * overlapping files — the textual-conflict risk — and which claim / session /
 * agent owns each side, so the operator (or the merge path) sees the danger
 * before `git merge`, not after.
 *
 * This is a *risk signal*, not a merge engine: file-level overlap is a
 * necessary-not-sufficient predictor (two lanes editing the same file usually
 * conflict; disjoint hunks sometimes don't). It deliberately over-reports
 * rather than miss — a flagged non-conflict costs a glance; a missed conflict
 * costs the trp_merge_wipes_node_modules / parasitic-deletion class of pain.
 */
import { spawnSync } from 'node:child_process';
import { listWorktrees, type WorktreeInfo } from './worktree.js';
import { listClaims } from './claims.js';
import { logger } from './logger.js';

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Paths never counted as conflict risk: store-internal + birth noise. */
function isIgnorablePath(file: string): boolean {
  return file === '.gitignore'
    || file.startsWith('.brainclaw/')
    || file.startsWith('.git/');
}

export interface LaneChange {
  branch: string;
  path: string;
  session_id?: string;
  agent?: string;
  /** Active claim owning this worktree, if one is matched. */
  claim_id?: string;
  claim_scope?: string;
  /** Files changed by committed work since the base ref (branch...base). */
  committed_files: string[];
  /** Tracked, uncommitted files in the worktree (a worker spawns from HEAD — these never merge). */
  dirty_files: string[];
  /** Union of committed + dirty, minus ignorable paths. */
  changed_files: string[];
}

export interface FileOverlap {
  file: string;
  /** Branch names that all touch this file (≥2). */
  branches: string[];
  /** Owning claim ids for those branches (deduped, present ones only). */
  claims: string[];
}

export interface MergeRiskReport {
  base_ref: string;
  lanes: LaneChange[];
  overlaps: FileOverlap[];
  has_risk: boolean;
  summary: string;
}

export interface MergeRiskOptions {
  /** Ref each lane is diffed against (default: the main worktree's current branch, else 'master'). */
  baseRef?: string;
  /** Include uncommitted tracked changes per worktree (default true). */
  includeDirty?: boolean;
  /** Only analyze these branches (default: all non-main linked worktrees). */
  branches?: string[];
}

function committedChangedFiles(mainPath: string, baseRef: string, branch: string): string[] {
  // base...branch = changes on `branch` since it diverged from baseRef.
  // --no-renames: a committed rename old→new must surface BOTH paths so a lane
  // that EDITS `old` overlaps with a lane that RENAMES `old`→`new` (otherwise
  // the rename-vs-modify conflict is invisible to overlap detection). Default
  // rename detection collapses this to the destination only.
  const r = git(['diff', '--name-only', '--no-renames', `${baseRef}...${branch}`], mainPath);
  if (r.ok) {
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }
  // Three-dot diff requires a merge base; an unrelated-history branch errors
  // out (`fatal: no merge base`). Fall back to a plain two-arg diff, which
  // works across unrelated histories and yields the union of touched paths —
  // over-reporting (every file in either tree) rather than silently missing
  // the real divergence with an empty list.
  const fallback = git(['diff', '--name-only', '--no-renames', baseRef, branch], mainPath);
  if (fallback.ok) {
    logger.warn(`[merge-risk] no merge base between ${baseRef} and ${branch}; falling back to two-arg diff (over-reports rather than miss).`);
    return fallback.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }
  logger.warn(`[merge-risk] git diff failed for ${branch} vs ${baseRef}: ${r.stderr.trim() || fallback.stderr.trim()}`);
  return [];
}

function dirtyTrackedFiles(worktreePath: string): string[] {
  const r = git(['status', '--short', '--untracked-files=no'], worktreePath);
  if (!r.ok) return [];
  return r.stdout.split('\n')
    .filter(Boolean)
    .map(line => line.slice(3).trim()) // strip the XY status prefix
    // a rename shows "old -> new"; keep the destination path
    .map(p => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
    .filter(Boolean);
}

/**
 * Analyze pre-merge conflict risk across the parallel worktree lanes.
 * Pure read: runs only `git diff`/`git status` (no lock, no mutation).
 */
export function analyzeMergeRisk(mainWorktreePath: string, options: MergeRiskOptions = {}): MergeRiskReport {
  const includeDirty = options.includeDirty ?? true;

  // Resolve the base ref: explicit, else the main worktree's current branch, else master.
  let baseRef = options.baseRef;
  if (!baseRef) {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], mainWorktreePath);
    baseRef = head.ok && head.stdout.trim() && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : 'master';
  }

  const claims = listClaims(mainWorktreePath).filter(c => c.status === 'active');
  const claimByWorktree = new Map<string, { id: string; scope: string }>();
  for (const c of claims) {
    if (c.worktree_path) claimByWorktree.set(normalizePath(c.worktree_path), { id: c.id, scope: c.scope });
  }

  const worktrees = listWorktrees(mainWorktreePath).filter((w: WorktreeInfo) =>
    !w.is_main && w.branch !== '(detached)' && w.branch !== '(bare)'
    && (!options.branches || options.branches.includes(w.branch)),
  );

  const lanes: LaneChange[] = [];
  for (const w of worktrees) {
    const committed = committedChangedFiles(mainWorktreePath, baseRef, w.branch).filter(f => !isIgnorablePath(f));
    const dirty = includeDirty ? dirtyTrackedFiles(w.path).filter(f => !isIgnorablePath(f)) : [];
    const changed = [...new Set([...committed, ...dirty])].sort();
    const claim = claimByWorktree.get(normalizePath(w.path));
    lanes.push({
      branch: w.branch,
      path: w.path,
      session_id: w.session_id,
      agent: w.agent,
      claim_id: claim?.id,
      claim_scope: claim?.scope,
      committed_files: committed.sort(),
      dirty_files: dirty.sort(),
      changed_files: changed,
    });
  }

  // File → lanes touching it; an overlap is any file in ≥2 lanes.
  const fileToLanes = new Map<string, LaneChange[]>();
  for (const lane of lanes) {
    for (const file of lane.changed_files) {
      const arr = fileToLanes.get(file) ?? [];
      arr.push(lane);
      fileToLanes.set(file, arr);
    }
  }
  const overlaps: FileOverlap[] = [];
  for (const [file, touching] of fileToLanes) {
    if (touching.length < 2) continue;
    overlaps.push({
      file,
      branches: touching.map(l => l.branch),
      claims: [...new Set(touching.map(l => l.claim_id).filter((x): x is string => !!x))],
    });
  }
  overlaps.sort((a, b) => b.branches.length - a.branches.length || a.file.localeCompare(b.file));

  const hasRisk = overlaps.length > 0;
  const summary = lanes.length === 0
    ? 'No parallel worktree lanes to analyze.'
    : hasRisk
      ? `${overlaps.length} file(s) touched by multiple lanes across ${lanes.length} lane(s) — review before merge.`
      : `${lanes.length} lane(s), no overlapping files — lanes are disjoint, safe to merge in any order.`;

  return { base_ref: baseRef, lanes, overlaps, has_risk: hasRisk, summary };
}

function normalizePath(p: string): string {
  // Slash + trailing-slash normalisation is universal. Case-folding only on
  // win32: POSIX filesystems are case-sensitive, so lowercasing `/Users/Foo`
  // and `/users/foo` would collapse two genuinely distinct directories and
  // mis-attribute a claim to the wrong lane.
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
