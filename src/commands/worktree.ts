import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  pruneWorktrees,
  cleanMergedWorktrees,
  mergeWorktreeBranch,
  worktreesBaseDir,
  type WorktreeInfo,
} from '../core/worktree.js';
import { analyzeMergeRisk, type MergeRiskReport } from '../core/merge-risk.js';
import { memoryExists } from '../core/io.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';

export interface WorktreeCreateOptions {
  branch: string;
  sessionId?: string;
  agent?: string;
  cwd?: string;
  store?: StoreTarget;
}

export interface WorktreeRemoveOptions {
  path: string;
  force?: boolean;
  cwd?: string;
  store?: StoreTarget;
}

export interface WorktreeListOptions {
  cwd?: string;
  store?: StoreTarget;
}

export function runWorktreeCreate(options: WorktreeCreateOptions): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
    const worktreePath = createWorktree(cwd, options.branch, {
      sessionId: options.sessionId,
      agent: options.agent,
    });
    console.log(`✔ Worktree created: ${worktreePath}`);
    console.log(`  Branch: ${options.branch}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function runWorktreeList(options: WorktreeListOptions): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const worktrees = listWorktrees(cwd);
  if (worktrees.length === 0) {
    console.log('No worktrees found.');
    return;
  }

  const managed = worktreesBaseDir(cwd);
  console.log(`Worktrees (managed under ${managed}):\n`);

  for (const wt of worktrees) {
    const tag = wt.session_id ? ` [session: ${wt.session_id}]` : '';
    const agentTag = wt.agent ? ` [agent: ${wt.agent}]` : '';
    console.log(`  ${wt.path}`);
    console.log(`    branch: ${wt.branch}  commit: ${wt.commit.slice(0, 8)}${tag}${agentTag}`);
  }
}

export function runWorktreeRemove(options: WorktreeRemoveOptions): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
    removeWorktree(cwd, options.path, { force: options.force });
    console.log(`✔ Worktree removed: ${options.path}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function runWorktreePrune(options: { cwd?: string; store?: StoreTarget }): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
  pruneWorktrees(cwd);
  console.log('✔ Worktree stale entries pruned.');
}

export interface WorktreeCleanOptions {
  force?: boolean;
  dryRun?: boolean;
  cwd?: string;
  store?: StoreTarget;
}

export function runWorktreeClean(options: WorktreeCleanOptions): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  const result = cleanMergedWorktrees(cwd, {
    force: options.force,
    dryRun: options.dryRun,
  });

  if (result.removed.length === 0 && result.skipped.length === 0) {
    console.log('✔ No merged or orphan worktrees to clean.');
    return;
  }

  const verb = options.dryRun ? 'Would remove' : 'Removed';
  for (const p of result.removed) {
    console.log(`${options.dryRun ? '  (dry-run)' : '  ✔'} ${verb}: ${p}`);
  }
  for (const s of result.skipped) {
    console.log(`  ⚠ Skipped: ${s.path} (${s.reason})`);
  }
  console.log(`\n${verb} ${result.removed.length} worktree(s), skipped ${result.skipped.length}.`);
}

export interface WorktreeMergeOptions {
  branch: string;
  message?: string;
  dryRun?: boolean;
  cwd?: string;
  store?: StoreTarget;
}

export function runWorktreeMerge(options: WorktreeMergeOptions): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  // Pre-merge conflict reflex (pln#396): warn if another live lane overlaps
  // the files this branch would land. Advisory — never blocks the merge.
  try {
    const risk = analyzeMergeRisk(cwd, { branches: undefined });
    const conflicting = risk.overlaps.filter(o => o.branches.includes(options.branch));
    if (conflicting.length > 0) {
      console.warn(`⚠ Pre-merge risk: ${options.branch} overlaps ${conflicting.length} file(s) with other live lane(s):`);
      for (const o of conflicting.slice(0, 10)) {
        console.warn(`    ${o.file} — also in ${o.branches.filter(b => b !== options.branch).join(', ')}`);
      }
      console.warn('  Run `brainclaw worktree check` for the full picture. Proceeding with merge.');
    }
  } catch { /* advisory only — never block the merge on the risk probe */ }

  const result = mergeWorktreeBranch(cwd, options.branch, {
    message: options.message,
    dryRun: options.dryRun,
  });

  if (!result.merged) {
    if (options.dryRun) {
      console.log(`(dry-run) Would merge ${options.branch}: ${result.filesChanged} files changed, ${result.filesRestored} parasitic deletions restored.`);
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  console.log(`✔ Merged ${options.branch} → ${result.commitHash}`);
  console.log(`  ${result.filesChanged} files changed, ${result.filesRestored} parasitic deletion(s) auto-restored.`);
}

export interface WorktreeCheckOptions {
  baseRef?: string;
  json?: boolean;
  cwd?: string;
  store?: StoreTarget;
}

/**
 * `brainclaw worktree check` (pln#396) — pre-merge conflict detection across
 * the parallel lanes. Exit 0 when lanes are disjoint, 3 when overlaps exist
 * (a distinct non-error code so a supervisor script can gate a batch merge
 * without treating "risk found" as a crash).
 */
export function runWorktreeCheck(options: WorktreeCheckOptions): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
  const report = analyzeMergeRisk(cwd, { baseRef: options.baseRef });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (report.has_risk) process.exitCode = 3;
    return;
  }

  printMergeRiskReport(report);
  if (report.has_risk) process.exitCode = 3;
}

function printMergeRiskReport(report: MergeRiskReport): void {
  console.log(`Pre-merge conflict check (base: ${report.base_ref})`);
  console.log(`  ${report.summary}`);
  if (report.lanes.length === 0) return;

  console.log('\nLanes:');
  for (const lane of report.lanes) {
    const who = lane.claim_id
      ? `${lane.agent ?? 'unknown'} · claim ${lane.claim_id}`
      : (lane.agent ?? lane.session_id ?? 'unclaimed');
    const dirtyNote = lane.dirty_files.length ? ` (+${lane.dirty_files.length} uncommitted)` : '';
    console.log(`  • ${lane.branch} [${who}] — ${lane.changed_files.length} file(s)${dirtyNote}`);
  }

  if (report.overlaps.length > 0) {
    console.log('\n⚠ Overlapping files (potential conflicts on merge):');
    for (const o of report.overlaps) {
      console.log(`  ${o.file}`);
      console.log(`      lanes: ${o.branches.join(', ')}`);
      if (o.claims.length) console.log(`      claims: ${o.claims.join(', ')}`);
    }
    console.log('\nMerge protocol: merge one overlapping lane, then rebase/re-check the others');
    console.log('before merging them. Disjoint lanes can merge in any order. See');
    console.log('docs/concepts/parallel-merge-protocol.md.');
  }
}

/** Returns WorktreeInfo[] for use by MCP tools. */
export function getWorktrees(cwd: string): WorktreeInfo[] {
  return listWorktrees(cwd);
}
