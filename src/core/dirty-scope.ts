/**
 * Scope-aware dirty-working-tree guard for dispatch (pln#520 Tier 2, trp#371).
 *
 * The original guard (can_30c295b4) refused review/assign/consult/ideate the
 * moment ANY uncommitted file existed in the source repo — repo-global, no
 * comparison to the dispatch scope. In multi-agent use (codex/claude leave
 * uncommitted files around) that hard-blocks legitimate dispatches, and the
 * coordination store itself (`.brainclaw/`) is rewritten on every dispatch so
 * a second `bclaw_coordinate` in the same session ALWAYS saw a dirty tree.
 *
 * This helper makes the decision scope-aware. The cardinal rule (converged
 * across the Tier 2 ideation loop lop_5fc24cc8707992ea): never turn a noisy,
 * visible false-positive (block a legitimate dispatch) into a SILENT
 * false-negative (let a worker review/edit stale code with no signal). So
 * when the scope cannot be proven disjoint from the dirty files, we still
 * block — `allow_dirty=true` remains the explicit, auditable override.
 *
 * Empirical grounding: of ~450 real claim scopes in the store, only 4 contain
 * a glob and ~60% are not resolvable to paths at all (plan-ids, loop-refs,
 * prose). So the resolver optimises for the path-prefix case and treats
 * anything ambiguous as `unknown` (→ conservative block when dirty), rather
 * than building a glob engine. The rare real globs are delegated to git.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type DirtyGuardDecision = 'allow' | 'warn' | 'block';

export type ScopeResolution =
  | { kind: 'pathspecs'; pathspecs: string[] }
  | { kind: 'unknown'; reason: string };

/** Runs `git -C <cwd> <args>` and reports success + stdout. Injectable for tests. */
export type GitStatusRunner = (cwd: string, args: string[]) => { ok: boolean; stdout: string };

export interface AssessDirtyDispatchInput {
  /** Repo to probe — the dispatch TARGET (dispatchCwd), not the source cwd. */
  cwd: string;
  /** The dispatch scope (free string). May be undefined. */
  scope?: string;
  /** Tier-1 override. When true the guard never blocks (may still warn). */
  allowDirty?: boolean;
  /**
   * When set, the dispatch builds its worktree from this explicit ref instead
   * of HEAD+working-tree, so uncommitted working-tree changes are intentionally
   * out of scope and the guard allows the dispatch. (pln#520 P2c.)
   */
  checkoutRef?: string;
  /** Injectable git runner (defaults to spawnSync). */
  runGit?: GitStatusRunner;
}

export interface AssessDirtyDispatchResult {
  decision: DirtyGuardDecision;
  reason: string;
  /** Count of dirty files after excluding system paths (.brainclaw/, .git/). */
  dirtyCount: number;
  /** Dirty files that overlap the resolved scope (empty unless resolvable). */
  overlapping: string[];
  /** Dirty system files excluded from the decision (.brainclaw/, .git/). */
  ignoredSystemDirty: string[];
  /** Whether the scope resolved to pathspecs or stayed unknown. */
  scopeResolution: ScopeResolution['kind'];
}

/** Top-level directories that read as code paths even when not yet on disk. */
const KNOWN_TOP_LEVEL = new Set([
  'src', 'lib', 'docs', 'doc', 'test', 'tests', 'packages', 'app', 'apps',
  'scripts', 'bin', 'public', 'assets', 'examples', 'config',
]);

/** Entity-id / loop-ref prefixes that are never file paths. */
const ENTITY_ID_RE = /^(pln|clm|asg|asgn|run|lop|dec|cst|con|trp|han|can|rtn|rn|seq|sess|agt|art|lsl)[_#]/i;

function defaultRunGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const probe = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
    if (probe.status !== 0 || typeof probe.stdout !== 'string') {
      return { ok: false, stdout: '' };
    }
    return { ok: true, stdout: probe.stdout };
  } catch {
    // Never block a dispatch because git hiccuped — surface as "not probeable".
    return { ok: false, stdout: '' };
  }
}

/** True for coordination/store paths that are dirty as a side effect of dispatching. */
export function isSystemDirtyPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return norm === '.brainclaw'
    || norm.startsWith('.brainclaw/')
    || norm === '.git'
    || norm.startsWith('.git/');
}

/**
 * Parse `git status --porcelain=v1 -z` output into a flat list of paths.
 *
 * NUL-separated entries avoid the quoting/newline pitfalls of line parsing.
 * Rename/copy entries (`R`/`C`) carry the NEW path in the status field and the
 * ORIGINAL path in the following NUL field — we keep BOTH, because a move out
 * of scope that creates a file in scope (or vice versa) is a relevant change.
 */
export function parsePorcelainZ(stdout: string): string[] {
  const parts = stdout.split('\0').filter((p) => p.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue; // malformed; "XY p" is the minimum
    const status = entry.slice(0, 2);
    const newPath = entry.slice(3); // skip "XY " (2 status chars + 1 separator)
    paths.push(newPath);
    if (status[0] === 'R' || status[0] === 'C') {
      const origPath = parts[i + 1];
      if (origPath !== undefined) {
        paths.push(origPath);
        i++; // consume the original-path field
      }
    }
  }
  return paths;
}

/**
 * Resolve a free-string scope into git pathspecs, or `unknown` when it cannot
 * be proven to denote file paths. All-or-nothing across comma-separated
 * tokens: a single unresolvable token marks the whole scope unknown, so the
 * guard never blocks on a partial (and therefore misleading) view.
 */
export function resolveScopeToPathspecs(scope: string | undefined, cwd: string): ScopeResolution {
  if (!scope || !scope.trim()) {
    return { kind: 'unknown', reason: 'no scope provided' };
  }
  const tokens = scope.split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return { kind: 'unknown', reason: 'empty scope' };
  }
  const pathspecs: string[] = [];
  for (const token of tokens) {
    if (ENTITY_ID_RE.test(token) || /^review-loop:/i.test(token)) {
      return { kind: 'unknown', reason: `token "${token}" is an entity id, not a path` };
    }
    if (/\s/.test(token)) {
      return { kind: 'unknown', reason: `token "${token}" contains whitespace (prose, not a path)` };
    }
    const normalized = token.replace(/\\/g, '/').replace(/^\.\//, '');
    if (/[*?[\]]/.test(normalized)) {
      // Delegate the rare real glob to git's native pathspec matcher.
      pathspecs.push(`:(glob)${normalized}`);
      continue;
    }
    const exists = fs.existsSync(path.resolve(cwd, normalized));
    const topLevel = normalized.split('/')[0];
    if (exists || KNOWN_TOP_LEVEL.has(topLevel)) {
      pathspecs.push(normalized);
      continue;
    }
    return {
      kind: 'unknown',
      reason: `token "${token}" is not a resolvable path (no such file/dir and not a known top-level)`,
    };
  }
  return { kind: 'pathspecs', pathspecs };
}

/** Cap a file list for human-readable messages. */
function summariseFiles(files: string[], max = 10): string {
  if (files.length <= max) return files.join(', ');
  return `${files.slice(0, max).join(', ')} (and ${files.length - max} more)`;
}

/**
 * Decide whether a dispatch may proceed given the source repo's dirty state and
 * the dispatch scope. See the module header for the cardinal rule.
 */
export function assessDirtyDispatchGuard(input: AssessDirtyDispatchInput): AssessDirtyDispatchResult {
  const runGit = input.runGit ?? defaultRunGit;
  const resolution = resolveScopeToPathspecs(input.scope, input.cwd);

  // 1. Global probe — is the tree dirty at all (ignoring the coordination store)?
  const global = runGit(input.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (!global.ok) {
    return {
      decision: 'allow',
      reason: 'source cwd is not a git repo (or git is unavailable) — dirty guard skipped',
      dirtyCount: 0,
      overlapping: [],
      ignoredSystemDirty: [],
      scopeResolution: resolution.kind,
    };
  }
  const allPaths = parsePorcelainZ(global.stdout);
  const ignoredSystemDirty = allPaths.filter(isSystemDirtyPath);
  const realDirty = allPaths.filter((p) => !isSystemDirtyPath(p));

  if (realDirty.length === 0) {
    return {
      decision: 'allow',
      reason: ignoredSystemDirty.length > 0
        ? `working tree clean apart from ${ignoredSystemDirty.length} coordination-store file(s) (.brainclaw/, .git/) which the worker rebuilds itself`
        : 'working tree clean',
      dirtyCount: 0,
      overlapping: [],
      ignoredSystemDirty,
      scopeResolution: resolution.kind,
    };
  }

  // 2. Explicit ref → the worktree is built from that ref (the dispatch path
  //    forces resetExistingWorktreeBranch so a pre-existing branch is reset to
  //    the ref, not silently reused), so uncommitted working-tree changes are
  //    intentionally out of scope. Only bypass when the ref actually resolves —
  //    a bogus/unresolvable ref must NOT widen the allow; fall through to the
  //    scope-aware check below so a dirty in-scope file still blocks.
  if (input.checkoutRef) {
    const refResolves = runGit(input.cwd, ['rev-parse', '--verify', '--quiet', `${input.checkoutRef}^{commit}`]).ok;
    if (refResolves) {
      return {
        decision: 'allow',
        reason: `dispatch builds its worktree from explicit ref "${input.checkoutRef}"; ${realDirty.length} uncommitted working-tree file(s) are intentionally out of scope`,
        dirtyCount: realDirty.length,
        overlapping: [],
        ignoredSystemDirty,
        scopeResolution: resolution.kind,
      };
    }
    // else: ref does not resolve → continue to the scope-aware evaluation.
  }

  // 3. Scope-aware intersection (delegated to git for glob + segment-boundary correctness).
  if (resolution.kind === 'pathspecs') {
    const scoped = runGit(input.cwd, [
      'status', '--porcelain=v1', '-z', '--untracked-files=normal',
      '--', ...resolution.pathspecs, ':(exclude).brainclaw/', ':(exclude).git/',
    ]);
    // If the scoped probe fails for any reason, fall back conservatively:
    // treat the whole real-dirty set as potentially overlapping.
    const overlapping = scoped.ok ? parsePorcelainZ(scoped.stdout).filter((p) => !isSystemDirtyPath(p)) : realDirty;
    if (overlapping.length === 0) {
      return {
        decision: 'allow',
        reason: `${realDirty.length} uncommitted file(s) but none overlap the dispatch scope`,
        dirtyCount: realDirty.length,
        overlapping: [],
        ignoredSystemDirty,
        scopeResolution: resolution.kind,
      };
    }
    if (input.allowDirty) {
      return {
        decision: 'warn',
        reason: `allow_dirty=true: proceeding despite ${overlapping.length} dirty file(s) overlapping the dispatch scope: ${summariseFiles(overlapping)}`,
        dirtyCount: realDirty.length,
        overlapping,
        ignoredSystemDirty,
        scopeResolution: resolution.kind,
      };
    }
    return {
      decision: 'block',
      reason: `${overlapping.length} uncommitted file(s) overlap the dispatch scope and the worker spawns from HEAD, so it will not see them: ${summariseFiles(overlapping)}. Commit or stash these, or pass allow_dirty=true to override.`,
      dirtyCount: realDirty.length,
      overlapping,
      ignoredSystemDirty,
      scopeResolution: resolution.kind,
    };
  }

  // 4. Scope not resolvable to paths → cannot prove disjointness → conservative.
  if (input.allowDirty) {
    return {
      decision: 'warn',
      reason: `allow_dirty=true: proceeding despite ${realDirty.length} uncommitted file(s); dispatch scope is not resolvable to paths (${resolution.reason}) so overlap could not be ruled out`,
      dirtyCount: realDirty.length,
      overlapping: [],
      ignoredSystemDirty,
      scopeResolution: resolution.kind,
    };
  }
  return {
    decision: 'block',
    reason: `${realDirty.length} uncommitted file(s) and the dispatch scope is not resolvable to file paths (${resolution.reason}), so overlap cannot be ruled out; the worker spawns from HEAD and will not see them: ${summariseFiles(realDirty)}. Commit or stash, pass a resolvable file scope, or pass allow_dirty=true to override.`,
    dirtyCount: realDirty.length,
    overlapping: [],
    ignoredSystemDirty,
    scopeResolution: resolution.kind,
  };
}
