import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
    } catch {
      // Non-fatal - shared paths are an optimization for agent worktrees
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
  const detected = detectStackSharedPaths(mainWorktreePath);
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

export function removeWorktree(
  mainWorktreePath: string,
  worktreePath: string,
  options: { force?: boolean } = {},
): void {
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
