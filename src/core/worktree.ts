import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { logger } from './logger.js';

/** Normalizes a path for use in git CLI arguments (forward slashes on Windows). */
function gitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Stack marker → shared directories mapping.
 * Maven/Gradle/Cargo intentionally excluded — their dep caches live
 * machine-globally (~/.m2, ~/.gradle/caches, ~/.cargo/registry).
 */
const STACK_MARKERS: Array<{ markers: string[]; paths: string[] }> = [
  { markers: ['package.json'], paths: ['node_modules'] },
  { markers: ['requirements.txt', 'pyproject.toml', 'Pipfile'], paths: ['venv', '.venv'] },
  { markers: ['Gemfile'], paths: ['vendor/bundle'] },
  { markers: ['go.mod'], paths: ['vendor'] },
  { markers: ['composer.json'], paths: ['vendor'] },
  { markers: ['mix.exs'], paths: ['deps'] },
];

/**
 * Detects which directories should be symlinked into worktrees based on
 * stack markers found in `projectRoot`.
 *
 * Returns a deduplicated list of relative directory names.
 */
export function detectStackSharedPaths(projectRoot: string): string[] {
  const result = new Set<string>();
  for (const { markers, paths } of STACK_MARKERS) {
    const hasMarker = markers.some((m) => fs.existsSync(path.join(projectRoot, m)));
    if (hasMarker) {
      for (const p of paths) result.add(p);
    }
  }
  return [...result];
}

/**
 * pln#523 — read declared monorepo workspace globs from npm/yarn/bun
 * `workspaces` (package.json) and pnpm-workspace.yaml. Returns the raw
 * patterns (e.g. "packages/*", "apps/api"); empty when the project is not a
 * workspace root or the manifests are absent/invalid.
 */
export function readWorkspacePatterns(projectRoot: string): string[] {
  const patterns: string[] = [];
  // npm / yarn / bun: package.json "workspaces" (array, or { packages: [...] })
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) patterns.push(...ws);
    else if (ws && Array.isArray(ws.packages)) patterns.push(...ws.packages);
  } catch { /* no / invalid package.json — not a node workspace root */ }
  // pnpm: pnpm-workspace.yaml "packages"
  try {
    const parsed = yaml.parse(
      fs.readFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'utf-8'),
    ) as { packages?: string[] } | null;
    if (parsed && Array.isArray(parsed.packages)) patterns.push(...parsed.packages);
  } catch { /* no pnpm workspace file */ }
  return [...new Set(patterns)];
}

/**
 * pln#523 — resolve monorepo workspace globs to the per-package `node_modules`
 * directories that actually exist on disk. Hoisted monorepos (all deps at the
 * root) need only the root link from detectStackSharedPaths; this additionally
 * covers packages that keep a LOCAL node_modules (pnpm, nohoist, partial
 * hoisting) so a dispatched worker can build/typecheck a sub-package, not just
 * the root — the exact gap behind a worker stalling on `tsc` in a worktree.
 *
 * Pattern shapes supported without a glob dependency (zero-runtime-dep policy):
 *   - exact dir:       "apps/api"
 *   - single wildcard: "packages/*"   → immediate child directories
 *   - deep wildcard:   "packages/**"  → treated as one level ("packages/*")
 * Negations ("!pkg/excluded") are skipped — they only narrow coverage and a
 * missing link degrades gracefully to central validation.
 *
 * Returns relative paths with forward slashes (e.g. "apps/api/node_modules").
 */
export function detectWorkspaceNodeModules(projectRoot: string): string[] {
  const patterns = readWorkspacePatterns(projectRoot);
  if (patterns.length === 0) return [];
  const result = new Set<string>();
  const addIfHasNodeModules = (relPkgDir: string): void => {
    const rel = `${relPkgDir.replace(/\\/g, '/').replace(/\/+$/, '')}/node_modules`;
    if (fs.existsSync(path.join(projectRoot, rel))) result.add(rel);
  };
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('!')) continue;
    const wildcardIdx = pattern.indexOf('*');
    if (wildcardIdx === -1) {
      addIfHasNodeModules(pattern);
      continue;
    }
    // Base dir = the path segment before the first wildcard.
    const base = pattern.slice(0, wildcardIdx).replace(/\/+$/, '');
    let children: string[] = [];
    try {
      children = fs
        .readdirSync(path.join(projectRoot, base), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch { /* base dir absent — skip this pattern */ }
    for (const child of children) {
      addIfHasNodeModules(base ? `${base}/${child}` : child);
    }
  }
  return [...result];
}

export interface WorktreeInfo {
  /** Absolute path to the worktree root. */
  path: string;
  /** Git branch checked out in this worktree. */
  branch: string;
  /** HEAD commit hash. */
  commit: string;
  /** Whether this is the main (primary) worktree. */
  is_main: boolean;
  /** Brainclaw session ID associated with this worktree, if any. */
  session_id?: string;
  /** Brainclaw agent name associated with this worktree, if any. */
  agent?: string;
  /** OS user who created this worktree (from sidecar). */
  user?: string;
}

function canonicalizeScopePath(target: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(target);
  } catch {
    resolved = path.resolve(target);
  }

  const normalized = path.normalize(resolved);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Returns the base directory where brainclaw-managed worktrees are placed.
 * ~/.brainclaw/worktrees/<project-hash>/
 *
 * Using a hash of the main worktree path ensures distinct directories per
 * project even when two projects share the same repo name.
 */
export function worktreesBaseDir(mainWorktreePath: string): string {
  const hash = crypto.createHash('sha1').update(mainWorktreePath).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.brainclaw', 'worktrees', hash);
}

/**
 * Resolves the path where a new worktree will be placed.
 * Pattern: ~/.brainclaw/worktrees/<project-hash>/<branchSlug>
 */
export function resolveWorktreePath(mainWorktreePath: string, branchName: string): string {
  const slug = branchName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return path.join(worktreesBaseDir(mainWorktreePath), slug);
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Returns true if the given path is a bare git repository.
 * Bare repos have no working tree, so worktree add is not applicable.
 */
export function isBareRepo(cwd: string): boolean {
  const result = runGit(['rev-parse', '--is-bare-repository'], cwd);
  return result.ok && result.stdout.trim() === 'true';
}

/**
 * Returns true if git has an index lock in this worktree
 * (another git process is active — worktree operations would fail).
 */
export function hasGitLock(cwd: string): boolean {
  const gitDir = runGit(['rev-parse', '--git-dir'], cwd);
  if (!gitDir.ok) return false;
  const lockPath = path.join(gitDir.stdout.trim(), 'index.lock');
  return fs.existsSync(lockPath);
}

/**
 * Re-points an EXISTING worktree to `ref` via a hard reset of its checked-out
 * branch + working tree. Used when a dispatch reuses an existing claim/worktree
 * but pins a base ref: the worktree must reflect that ref, not stale state,
 * otherwise the dirty-guard ref bypass would let the worker run on stale code
 * (pln#520 Tier 2 / codex r2). Returns ok=false (with stderr) rather than
 * throwing, so callers surface a visible warning instead of a hard failure.
 */
export function resetWorktreeToRef(worktreePath: string, ref: string): { ok: boolean; stderr: string } {
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, stderr: `worktree path does not exist: ${worktreePath}` };
  }
  if (hasGitLock(worktreePath)) {
    return { ok: false, stderr: 'git index.lock present — another git operation is in progress' };
  }
  const res = runGit(['reset', '--hard', ref], worktreePath);
  if (!res.ok) {
    return { ok: false, stderr: res.stderr };
  }

  // `reset --hard` realigns HEAD + tracked files, but leaves UNTRACKED residue
  // from a prior use of the worktree — files the worker could still compile or
  // test against even though they don't exist at the pinned ref (codex r3).
  // We do NOT auto-delete (a blind `git clean` would also remove the brainclaw
  // sidecar and gitignored shared symlinks); instead we detect non-system
  // untracked files and report them so the caller surfaces a visible warning
  // rather than letting the stale state pass silently. Ignored files (e.g.
  // node_modules) are not listed by --untracked-files=normal, so the symlinked
  // shared paths are unaffected.
  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], worktreePath);
  if (!status.ok) {
    // The reset succeeded but we cannot confirm the worktree is residue-free -
    // surface it rather than silently reporting a clean reset (cardinal rule).
    return {
      ok: false,
      stderr: `reset to ${ref} succeeded but the untracked-residue check (git status) failed: ${status.stderr.trim()}`,
    };
  }
  if (status.stdout.length > 0) {
    const residue = status.stdout
      .split('\0')
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3))
      .filter((p) => {
        const norm = p.replace(/\\/g, '/');
        return norm !== '.brainclaw-worktree.json'
          && !norm.startsWith('.brainclaw/')
          && !norm.startsWith('.git/');
      });
    if (residue.length > 0) {
      const sample = residue.slice(0, 5).join(', ');
      return {
        ok: false,
        stderr: `reset to ${ref} succeeded but ${residue.length} untracked file(s) remain from prior worktree use (e.g. ${sample}) — the worker may see state absent at the ref. Remove them or dispatch with a fresh scope.`,
      };
    }
  }
  return { ok: true, stderr: '' };
}

export interface SharedCheckoutRisk {
  /** True if multiple brainclaw-session sidecars are found in the same worktree directory. */
  has_conflict: boolean;
  /** Paths that share the same worktree root but belong to different sessions. */
  conflicting_paths: string[];
}

/**
 * Detects whether multiple distinct brainclaw sessions are using the same
 * physical worktree directory (shared-checkout risk).
 *
 * Only worktrees with a `.brainclaw-worktree.json` sidecar are examined,
 * since those are the ones brainclaw actively manages.
 */
export function detectSharedCheckoutRisk(mainWorktreePath: string): SharedCheckoutRisk {
  const worktrees = listWorktrees(mainWorktreePath);
  const sessionsByPath = new Map<string, string[]>();

  for (const wt of worktrees) {
    if (!wt.session_id) continue;
    const existing = sessionsByPath.get(wt.path) ?? [];
    existing.push(wt.session_id);
    sessionsByPath.set(wt.path, existing);
  }

  const conflicting: string[] = [];
  for (const [wtPath, sessions] of sessionsByPath) {
    if (sessions.length > 1) conflicting.push(wtPath);
  }

  return {
    has_conflict: conflicting.length > 0,
    conflicting_paths: conflicting,
  };
}

export function findWorktreePathForBranch(
  worktrees: WorktreeInfo[],
  branchName: string,
): string | undefined {
  return worktrees.find((worktree) => worktree.branch === branchName)?.path;
}

/**
 * Creates a git linked worktree at the computed placement path.
 *
 * - If `branchName` does not exist locally, creates it from HEAD.
 * - If the target directory already exists, throws to avoid silent overwrites.
 *
 * Returns the absolute path to the newly created worktree.
 */
export function createWorktree(
  mainWorktreePath: string,
  branchName: string,
  options: {
    sessionId?: string;
    agent?: string;
    /** Git ref used when creating a new branch, or resetting a stale existing branch. Defaults to HEAD. */
    baseRef?: string;
    /** Reset an existing local branch to baseRef before adding the worktree. */
    resetExistingBranch?: boolean;
    /** Additional paths to symlink (additive to auto-detected). */
    sharedPaths?: string[];
    /** Paths to exclude from symlinking even if auto-detected. */
    excludeShared?: string[];
  } = {},
): string {
  const symlinkWarnings: string[] = [];
  const trySymlinkSharedPath = (entryName: string): void => {
    const sourcePath = path.join(mainWorktreePath, entryName);
    const linkPath = path.join(targetPath, entryName);

    if (!fs.existsSync(sourcePath) || fs.existsSync(linkPath)) {
      return;
    }

    try {
      // Ensure parent dir exists for nested paths like vendor/bundle
      const parentDir = path.dirname(linkPath);
      if (parentDir !== targetPath) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.symlinkSync(sourcePath, linkPath, 'junction');
    } catch (err) {
      // pln#523: do NOT swallow silently. A missing node_modules junction is
      // exactly what leaves a dispatched worker unable to build/typecheck in its
      // worktree (it then stalls on `tsc` or npm scripts). Record a structured
      // warning — surfaced in the worktree sidecar + logger — instead of an
      // invisible degradation. Linking remains best-effort (non-fatal).
      const sameVolume =
        path.parse(sourcePath).root.toLowerCase() === path.parse(targetPath).root.toLowerCase();
      const reason = err instanceof Error ? err.message : String(err);
      const hint = sameVolume
        ? ''
        : ' (source and worktree are on different volumes — directory junctions require the same volume; deps cannot be linked here, validate builds centrally)';
      const msg = `Failed to link '${entryName}' into worktree: ${reason}${hint}`;
      symlinkWarnings.push(msg);
      logger.warn(`[worktree] ${msg}`);
    }
  };

  // Guard: bare repos have no working tree
  if (isBareRepo(mainWorktreePath)) {
    throw new Error('Cannot create a brainclaw worktree in a bare git repository.');
  }

  // Guard: active git operation lock
  if (hasGitLock(mainWorktreePath)) {
    throw new Error(
      'Git index.lock detected — another git operation is in progress. Wait for it to complete before creating a worktree.',
    );
  }

  const targetPath = resolveWorktreePath(mainWorktreePath, branchName);

  if (fs.existsSync(targetPath)) {
    throw new Error(
      `Worktree path already exists: ${targetPath}. Remove it first with 'brainclaw worktree remove'.`,
    );
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // Check if branch exists locally
  const branchCheck = runGit(['rev-parse', '--verify', branchName], mainWorktreePath);
  const branchExists = branchCheck.ok;
  const baseRef = options.baseRef ?? 'HEAD';

  if (branchExists && options.resetExistingBranch) {
    const attachedWorktreePath = findWorktreePathForBranch(listWorktrees(mainWorktreePath), branchName);
    if (attachedWorktreePath) {
      throw new Error(
        `Cannot reset branch ${branchName}: it is checked out in worktree ${attachedWorktreePath}. Remove or merge that worktree first.`,
      );
    }

    const reset = runGit(['branch', '--force', branchName, baseRef], mainWorktreePath);
    if (!reset.ok) {
      throw new Error(`git branch --force failed for ${branchName}: ${reset.stderr.trim()}`);
    }
  }

  // Use forward-slash paths for git on Windows
  const gitTargetPath = gitPath(targetPath);
  const worktreeArgs = branchExists
    ? ['worktree', 'add', gitTargetPath, branchName]
    : ['worktree', 'add', '-b', branchName, gitTargetPath, baseRef];

  const result = runGit(worktreeArgs, mainWorktreePath);
  if (!result.ok) {
    throw new Error(`git worktree add failed: ${result.stderr.trim()}`);
  }

  // After successful worktree creation, add to git safe.directory for cross-user agents (e.g. Codex)
  try {
    runGit(['config', '--global', '--add', 'safe.directory', gitPath(targetPath)], mainWorktreePath);
  } catch {
    // Non-fatal - safe.directory may already be set or not needed
  }

  // pln#480: auto-detect shared paths from stack markers + config overrides.
  // `dist` intentionally excluded — build outputs must be per-worktree
  // (EBUSY during clean:dist when MCP/extension holds a handle on junction target).
  // pln#523: also link per-package node_modules for JS/TS monorepos so workers
  // can build/typecheck sub-packages, not just the root. Set
  // BRAINCLAW_NO_LINK_DEPS=1 to disable auto dependency linking (e.g. when the
  // worktree lives on a different volume and central validation is preferred);
  // explicit options.sharedPaths are still honored.
  const linkDepsDisabled = process.env.BRAINCLAW_NO_LINK_DEPS === '1';
  const detected = linkDepsDisabled
    ? []
    : [...detectStackSharedPaths(mainWorktreePath), ...detectWorkspaceNodeModules(mainWorktreePath)];
  const extra = options.sharedPaths ?? [];
  const excluded = new Set(options.excludeShared ?? []);
  const sharedPaths = [...new Set([...detected, ...extra])].filter((p) => !excluded.has(p));
  for (const entry of sharedPaths) {
    trySymlinkSharedPath(entry);
  }
  // NOTE: .brainclaw/ is intentionally NOT symlinked.
  // Symlinking .brainclaw/ causes hooks and session_start to trigger on the
  // shared store, creating session conflicts and potentially blocking agents
  // (especially Claude CLI which auto-detects .brainclaw/ presence).

  const mainGitignorePath = path.join(mainWorktreePath, '.gitignore');
  const targetGitignorePath = path.join(targetPath, '.gitignore');
  if (fs.existsSync(mainGitignorePath)) {
    fs.copyFileSync(mainGitignorePath, targetGitignorePath);
  }

  // Write brainclaw metadata sidecar inside the worktree
  const meta = {
    session_id: options.sessionId,
    agent: options.agent,
    user: process.env.USER || process.env.USERNAME || undefined,
    created_at: new Date().toISOString(),
    main_worktree_path: mainWorktreePath,
    base_ref: baseRef,
    reset_existing_branch: options.resetExistingBranch === true,
    git_advice: 'git add ONLY specific files, NEVER git add -A.',
    // pln#523: surface any shared-path link failures (e.g. node_modules junction
    // that could not be created) so the worker / supervisor can see why a build
    // might fail, instead of an invisible degradation.
    ...(symlinkWarnings.length > 0 ? { symlink_warnings: symlinkWarnings } : {}),
  };
  fs.writeFileSync(
    path.join(targetPath, '.brainclaw-worktree.json'),
    JSON.stringify(meta, null, 2),
  );

  return targetPath;
}

/**
 * Lists all git worktrees for the given repo and enriches them with
 * brainclaw metadata if available.
 */
export function listWorktrees(mainWorktreePath: string): WorktreeInfo[] {
  const result = runGit(['worktree', 'list', '--porcelain'], mainWorktreePath);
  if (!result.ok) return [];

  const infos: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> & { raw_branch?: string; is_first?: boolean } = {};
  let isFirst = true;

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        infos.push(finaliseWorktree(current));
      }
      current = { path: line.slice('worktree '.length).trim(), is_first: isFirst };
      isFirst = false;
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      // refs/heads/branchname → branchname
      current.raw_branch = line.slice('branch '.length).trim();
      current.branch = current.raw_branch.replace(/^refs\/heads\//, '');
    } else if (line.startsWith('bare')) {
      current.branch = '(bare)';
    } else if (line === '') {
      // blank line = end of stanza
    }
  }
  if (current.path) {
    infos.push(finaliseWorktree(current));
  }

  return infos;
}

function finaliseWorktree(
  raw: Partial<WorktreeInfo> & { raw_branch?: string; is_first?: boolean },
): WorktreeInfo {
  const wt: WorktreeInfo = {
    path: raw.path ?? '',
    branch: raw.branch ?? '(detached)',
    commit: raw.commit ?? '',
    is_main: raw.is_first === true,
  };

  // Try to read brainclaw sidecar
  const sidecarPath = path.join(wt.path, '.brainclaw-worktree.json');
  if (fs.existsSync(sidecarPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      wt.session_id = meta.session_id;
      wt.agent = meta.agent;
      wt.user = meta.user;
      wt.is_main = false;
    } catch {
      // ignore parse errors
    }
  }

  return wt;
}

/**
 * Removes a linked git worktree.
 *
 * Passes `--force` only if `force` is explicitly set, to avoid accidentally
 * removing worktrees with uncommitted changes.
 */
/**
 * pln#477 — Path-prefix gate for the worktree GC.
 *
 * Worktree cleanup operations call `fs.rmSync(recursive: true)` which on
 * Windows can follow directory junctions into the main repo and wipe
 * `node_modules/` or `dist/` (trap_merge_wipes_node_modules). Defense
 * in depth: refuse to operate on any path outside the brainclaw-managed
 * scope. Resolves symlinks via `realpath` so a junction pointing OUT of
 * scope is also caught.
 *
 * Allowed roots:
 *   - `<userHome>/.brainclaw/worktrees/**`     — brainclaw-managed worktrees
 *   - `<projectRoot>/.brainclaw/coordination/runtime/**` — runtime artifacts
 */
export function assertPathInWorktreesScope(target: string, projectRoot: string): void {
  const resolvedTarget = canonicalizeScopePath(target);
  const worktreesRoot = canonicalizeScopePath(path.join(os.homedir(), '.brainclaw', 'worktrees'));
  const runtimeRoot = canonicalizeScopePath(path.join(projectRoot, '.brainclaw', 'coordination', 'runtime'));

  const isUnderWorktrees = resolvedTarget.startsWith(worktreesRoot + path.sep) || resolvedTarget === worktreesRoot;
  const isUnderRuntime = resolvedTarget.startsWith(runtimeRoot + path.sep) || resolvedTarget === runtimeRoot;

  if (!isUnderWorktrees && !isUnderRuntime) {
    throw new Error(
      `Refusing to remove path outside brainclaw worktree scope: ${target} (resolves to ${resolvedTarget}). ` +
      `Allowed roots: ${worktreesRoot}, ${runtimeRoot}`,
    );
  }
}

/**
 * pln#477 — Safe recursive directory removal that does NOT follow symlinks
 * or directory junctions. Required because brainclaw worktrees contain
 * `node_modules` and `dist` as junctions to the main repo — a naive
 * `fs.rmSync(recursive: true)` would wipe those targets.
 *
 * Walks via `lstat` so links are detached without descending into them.
 */
export function safeRemoveWorktreeDir(dirPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dirPath);
  } catch {
    return; // Already gone
  }

  // Symlink (file or directory): unlink only, do not follow.
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(dirPath);
    } catch {
      // Windows directory symlinks/junctions sometimes need rmdir
      try { fs.rmdirSync(dirPath); } catch { /* best effort */ }
    }
    return;
  }

  // Regular directory: recurse via readdir + lstat-based dispatch.
  if (stat.isDirectory()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      safeRemoveWorktreeDir(path.join(dirPath, entry.name));
    }
    try {
      fs.rmdirSync(dirPath);
    } catch {
      // Last-ditch: try unlink for stubborn junction parents.
      try { fs.unlinkSync(dirPath); } catch { /* best effort */ }
    }
    return;
  }

  // Regular file
  try { fs.unlinkSync(dirPath); } catch { /* best effort */ }
}

/**
 * pln#498 — Detach top-level symlinks/junctions from a worktree before any
 * recursive removal. On Windows, `git worktree remove` performs its own
 * recursive rm and historically (git ≤ 2.38) followed NTFS junctions into
 * the main repo, wiping `node_modules`. Unlinking the junction entries
 * first leaves git only regular files/dirs to walk.
 *
 * Only top-level entries are inspected — that's where shared paths are
 * symlinked at worktree birth (see createWorktree.trySymlinkSharedPath).
 */
export function detachWorktreeJunctions(worktreePath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return; // worktree already gone or unreadable
  }

  for (const entry of entries) {
    const child = path.join(worktreePath, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(child);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    try {
      fs.unlinkSync(child);
    } catch {
      try { fs.rmdirSync(child); } catch { /* best effort */ }
    }
  }
}

export function removeWorktree(
  mainWorktreePath: string,
  worktreePath: string,
  options: { force?: boolean } = {},
): void {
  // pln#498: detach junctions BEFORE git's own recursive rm runs. On Windows
  // (git ≤ 2.38) `git worktree remove` follows NTFS junctions into the main
  // repo and wipes node_modules. Removing the symlink entries first means
  // git only walks regular files and dirs.
  if (fs.existsSync(worktreePath)) {
    detachWorktreeJunctions(worktreePath);
  }

  const args = ['worktree', 'remove', worktreePath];
  if (options.force) args.push('--force');

  const result = runGit(args, mainWorktreePath);
  if (!result.ok) {
    throw new Error(`git worktree remove failed: ${result.stderr.trim()}`);
  }

  // Remove brainclaw metadata directory if it sits under ~/.brainclaw/worktrees.
  // pln#477: use safeRemoveWorktreeDir to avoid following junctions into the
  // main repo (node_modules / dist symlinks created at worktree birth).
  const base = path.join(os.homedir(), '.brainclaw', 'worktrees');
  if (worktreePath.startsWith(base) && fs.existsSync(worktreePath)) {
    assertPathInWorktreesScope(worktreePath, mainWorktreePath);
    safeRemoveWorktreeDir(worktreePath);
  }
}

/**
 * Prunes stale worktree administrative files from `.git/worktrees/`.
 * Equivalent to `git worktree prune`.
 */
export function pruneWorktrees(mainWorktreePath: string): void {
  runGit(['worktree', 'prune'], mainWorktreePath);
}

export interface CleanResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  pruned: boolean;
}

/**
 * Removes worktrees whose branch has been fully merged into the current branch
 * (typically master/main after a merge). Also removes brainclaw-managed
 * worktree directories that no longer have a corresponding git worktree entry
 * (orphan dirs left behind by force-deleted branches).
 *
 * Safe by default: skips worktrees with uncommitted changes unless `force` is set.
 */
export function cleanMergedWorktrees(
  mainWorktreePath: string,
  options: { force?: boolean; dryRun?: boolean } = {},
): CleanResult {
  const result: CleanResult = { removed: [], skipped: [], pruned: false };

  // First prune stale git worktree admin entries
  pruneWorktrees(mainWorktreePath);
  result.pruned = true;

  // Get branches already merged into HEAD
  const mergedOutput = runGit(['branch', '--merged', 'HEAD'], mainWorktreePath);
  const mergedBranches = new Set(
    mergedOutput.ok
      ? mergedOutput.stdout
          .split('\n')
          .map((b) => b.replace(/^[*+]?\s+/, '').trim())
          .filter(Boolean)
      : [],
  );

  const worktrees = listWorktrees(mainWorktreePath);

  for (const wt of worktrees) {
    if (wt.is_main) continue;

    const isMerged = mergedBranches.has(wt.branch);
    if (!isMerged) {
      continue;
    }

    // Check for uncommitted changes
    if (!options.force) {
      const status = runGit(['status', '--porcelain'], wt.path);
      if (status.ok && status.stdout.trim().length > 0) {
        result.skipped.push({ path: wt.path, reason: 'uncommitted changes' });
        continue;
      }
    }

    if (options.dryRun) {
      result.removed.push(wt.path);
      continue;
    }

    try {
      removeWorktree(mainWorktreePath, wt.path, { force: options.force });
      result.removed.push(wt.path);
    } catch {
      result.skipped.push({ path: wt.path, reason: 'removal failed' });
    }
  }

  // Clean orphan brainclaw worktree directories (no matching git worktree)
  cleanOrphanWorktreeDirs(mainWorktreePath, worktrees, result, options.dryRun);

  return result;
}

/**
 * Removes brainclaw-managed worktree directories under ~/.brainclaw/worktrees/
 * that no longer have a corresponding git worktree entry.
 */
function cleanOrphanWorktreeDirs(
  mainWorktreePath: string,
  activeWorktrees: WorktreeInfo[],
  result: CleanResult,
  dryRun?: boolean,
): void {
  const base = worktreesBaseDir(mainWorktreePath);
  if (!fs.existsSync(base)) return;

  const activePaths = new Set(activeWorktrees.map((wt) => path.resolve(wt.path)));

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.resolve(path.join(base, entry.name));
    if (activePaths.has(dirPath)) continue;

    // This directory is not referenced by any git worktree — it's orphaned
    if (dryRun) {
      result.removed.push(dirPath);
    } else {
      try {
        // pln#477: scope gate + junction-safe walk avoid wiping the main
        // repo's node_modules/dist via junction-following.
        assertPathInWorktreesScope(dirPath, mainWorktreePath);
        safeRemoveWorktreeDir(dirPath);
        result.removed.push(dirPath);
      } catch {
        result.skipped.push({ path: dirPath, reason: 'orphan dir removal failed' });
      }
    }
  }
}

export interface MergeWorktreeResult {
  merged: boolean;
  filesChanged: number;
  filesRestored: number;
  commitHash?: string;
  error?: string;
}

/**
 * Merges a worktree branch into the current branch with automatic
 * selective merge — detects and restores files that were deleted by
 * worktree divergence (present on target, absent in worktree branch).
 *
 * This eliminates the manual --no-commit + checkout HEAD dance.
 */
export function mergeWorktreeBranch(
  mainWorktreePath: string,
  branchName: string,
  options: { message?: string; dryRun?: boolean } = {},
): MergeWorktreeResult {
  // Step 1: Get list of files on current HEAD before merge
  const headFiles = runGit(['ls-tree', '-r', '--name-only', 'HEAD'], mainWorktreePath);
  const currentFiles = new Set(
    headFiles.ok ? headFiles.stdout.trim().split('\n').filter(Boolean) : [],
  );

  // Step 2: Merge with --no-commit
  const merge = runGit(['merge', branchName, '--no-ff', '--no-commit'], mainWorktreePath);
  if (!merge.ok) {
    // Check for conflicts
    if (merge.stderr.includes('CONFLICT')) {
      return { merged: false, filesChanged: 0, filesRestored: 0, error: 'Merge conflicts detected. Resolve manually.' };
    }
    return { merged: false, filesChanged: 0, filesRestored: 0, error: merge.stderr.trim() };
  }

  // Step 3: Detect parasitic deletions — files that exist on HEAD but are deleted by the merge
  const staged = runGit(['diff', '--cached', '--name-status'], mainWorktreePath);
  const deletions = staged.ok
    ? staged.stdout.trim().split('\n')
        .filter((line) => line.startsWith('D\t'))
        .map((line) => line.slice(2))
        .filter((file) => currentFiles.has(file))
    : [];

  // Step 4: Restore parasitic deletions
  let filesRestored = 0;
  for (const file of deletions) {
    const restore = runGit(['checkout', 'HEAD', '--', file], mainWorktreePath);
    if (restore.ok) filesRestored++;
  }

  // Step 5: Count real changes
  const realDiff = runGit(['diff', '--cached', '--stat'], mainWorktreePath);
  const filesChanged = realDiff.ok
    ? (realDiff.stdout.match(/\d+ file/)?.[0]?.match(/\d+/)?.[0] ?? '0')
    : '0';

  if (options.dryRun) {
    runGit(['merge', '--abort'], mainWorktreePath);
    return { merged: false, filesChanged: parseInt(filesChanged, 10), filesRestored, error: 'dry-run' };
  }

  // Step 6: Commit
  const msg = options.message ?? `Merge branch '${branchName}'`;
  const commit = runGit(['commit', '--no-edit', '-m', msg], mainWorktreePath);
  if (!commit.ok) {
    return { merged: false, filesChanged: parseInt(filesChanged, 10), filesRestored, error: commit.stderr.trim() };
  }

  const hash = runGit(['rev-parse', '--short', 'HEAD'], mainWorktreePath);

  return {
    merged: true,
    filesChanged: parseInt(filesChanged, 10),
    filesRestored,
    commitHash: hash.ok ? hash.stdout.trim() : undefined,
  };
}
