import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { logger } from './logger.js';
import { parsePorcelainZ, isSystemDirtyPath } from './dirty-scope.js';

/** Normalizes a path for use in git CLI arguments (forward slashes on Windows). */
function gitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * can_45316d5c — sanitize a scope-derived slug into a valid git branch
 * component (`git check-ref-format` rules). Scopes like `.github/workflows`
 * produced `feat/.github-workflows`, which git rejects (component starting
 * with a dot), failing the whole worktree creation.
 *
 * Rules covered: no leading dots/dashes, no trailing dots, no `..`, no
 * `@{`, no control/space/`~^:?*[\\` characters, no trailing `.lock`.
 *
 * Order matters: the 48-char length cap is applied BEFORE the trailing-dot/dash
 * and `.lock` strips — never after. Dogfood 1.10.1: a multi-file scope ending in
 * `…IntegrationHubPage.astro` sanitized fine, but the final `.slice(0, 48)` cut
 * landed on the dot before `astro`, yielding `…IntegrationHubPage.` — a trailing
 * dot git rejects (`fatal: not a valid branch name`). Truncating first, then
 * stripping, guarantees the cap can never re-introduce an invalid ref.
 */
export function sanitizeBranchComponent(raw: string, fallback = 'scope'): string {
  let slug = raw
    .replace(/[\s~^:?*[\]\\]/g, '-')   // chars forbidden by check-ref-format
    .replace(/@\{/g, '-')               // reflog syntax
    .replace(/\.\.+/g, '.')             // no double dots
    .replace(/[^a-zA-Z0-9._-]/g, '-')   // conservative whitelist for the rest
    .replace(/-+/g, '-')                // collapse dashes
    .replace(/^[.-]+/, '')              // no leading dot/dash
    .slice(0, 48)                       // length cap BEFORE the trailing strips
    .replace(/[.-]+$/, '');             // no trailing dot/dash (cut may have made one)
  if (/\.lock$/i.test(slug)) slug = slug.slice(0, -'.lock'.length).replace(/[.-]+$/, '');
  if (!slug) slug = fallback;
  return slug;
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
  let stablePath = path.resolve(mainWorktreePath);
  try {
    stablePath = fs.realpathSync.native(stablePath);
  } catch { /* path may not exist yet; path.resolve is still deterministic */ }
  if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(mainWorktreePath)) {
    stablePath = stablePath.toLowerCase();
  }
  const hash = crypto.createHash('sha1').update(stablePath).digest('hex').slice(0, 12);
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

/**
 * Default timeout for quick git metadata queries (rev-parse, status, branch…).
 * `git worktree add` is the exception — it materialises the entire working tree
 * and on a large repo / Windows (Defender) easily exceeds this, so it passes an
 * explicit, much larger timeout (see resolveWorktreeAddTimeoutMs).
 *
 * Dogfood 1.10.1: a 662-file site checkout was SIGTERM-killed at ~94% by this
 * flat 15s cap, surfacing as a misleading "git worktree add failed: …Updating
 * files: 94%" — the branch name was fine; the checkout simply ran out of time.
 */
const GIT_QUERY_TIMEOUT_MS = 15000;

/**
 * Timeout for `git worktree add` (full working-tree checkout). Defaults to 120s;
 * override with BRAINCLAW_WORKTREE_ADD_TIMEOUT_MS (milliseconds) for very large
 * repos or slow filesystems.
 */
export function resolveWorktreeAddTimeoutMs(): number {
  const raw = process.env.BRAINCLAW_WORKTREE_ADD_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_QUERY_TIMEOUT_MS,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: timeoutMs });
  // spawnSync kills on timeout (SIGTERM) and sets error.code=ETIMEDOUT; the raw
  // stderr is then just partial progress ("Updating files: …%"), which reads as
  // a cryptic failure. Surface the real cause — the timeout — instead.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    const hint = args[0] === 'worktree' ? ' (large checkout? raise BRAINCLAW_WORKTREE_ADD_TIMEOUT_MS)' : '';
    return {
      ok: false,
      stdout: result.stdout ?? '',
      stderr: `git ${args[0]} timed out after ${timeoutMs}ms and was killed${hint}.`,
    };
  }
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
 * True when `worktreePath` is a LINKED git worktree (created by `git worktree
 * add`), NOT the main repository. The key invariant for pln#534's commit-on-
 * behalf: brainclaw must NEVER commit into the integration repo, only into the
 * isolated worktree it dispatched.
 *
 * Detection uses the canonical, platform-stable signal: in a linked worktree
 * the entry at `<worktree>/.git` is a FILE (a `gitdir: …` pointer into the main
 * repo's `.git/worktrees/<name>`), whereas the main repository's `.git` is a
 * DIRECTORY. (An earlier implementation compared `git rev-parse
 * --absolute-git-dir` against `--git-common-dir`, but those returned
 * differently-normalized paths on the Windows CI runner — short 8.3 names /
 * drive-letter case — so the main repo was misread as linked. The file-vs-dir
 * check needs no path normalization.)
 */
export function isLinkedWorktree(worktreePath: string): boolean {
  if (!fs.existsSync(worktreePath)) return false;
  try {
    const dotGit = path.join(worktreePath, '.git');
    const st = fs.statSync(dotGit);
    // main repo → .git is a directory; linked worktree → .git is a file pointer.
    return st.isFile();
  } catch {
    return false; // no .git entry → not a git worktree
  }
}

export interface CommitOnBehalfResult {
  committed: boolean;
  sha?: string;
  files_changed: string[];
  /** Human-readable reason for the outcome (committed, clean, or refused). */
  reason: string;
}

/**
 * pln#534 (worktree-as-contract) — commit the uncommitted diff of a dispatched
 * worktree ON BEHALF of a worker that cannot commit itself (a sandboxed agent
 * whose root excludes `.git`, i.e. `dispatchCanCommit=false`). The worker's only
 * contract is "edit files in this worktree + drop LANE-RESULT.json"; brainclaw
 * carries the commit so the code lands on the lane branch and propagates.
 *
 * GUARDS (defence-in-depth, since this writes git history):
 *   - the path must exist and be a LINKED worktree — NEVER the main repo;
 *   - no commit when an index.lock is present (concurrent git op);
 *   - no commit when the worktree is clean;
 *   - all git runs are `spawnSync('git', [...])` with `-C <worktree>` semantics
 *     (cwd-scoped, no shell) so nothing can escape the worktree.
 * Returns a structured result instead of throwing so callers degrade gracefully.
 */
export function commitWorktreeOnBehalf(
  worktreePath: string,
  message: string,
  options: { authorName?: string; authorEmail?: string } = {},
): CommitOnBehalfResult {
  if (!fs.existsSync(worktreePath)) {
    return { committed: false, files_changed: [], reason: `worktree path does not exist: ${worktreePath}` };
  }
  if (!isLinkedWorktree(worktreePath)) {
    return { committed: false, files_changed: [], reason: `refusing to commit: ${worktreePath} is not a linked git worktree (main-repo guard)` };
  }
  if (hasGitLock(worktreePath)) {
    return { committed: false, files_changed: [], reason: 'git index.lock present — another git operation is in progress' };
  }

  const status = runGit(['status', '--porcelain'], worktreePath);
  if (!status.ok) {
    return { committed: false, files_changed: [], reason: `git status failed: ${status.stderr.trim()}` };
  }
  if (status.stdout.trim().length === 0) {
    return { committed: false, files_changed: [], reason: 'worktree clean — nothing to commit' };
  }

  // Stage everything, then UNSTAGE the transient files that must never land on
  // the lane branch: the worker's own `LANE-RESULT.json` report and any
  // `.brainclaw/` coordination state. Committing those would pollute the branch
  // (and master, on merge) with non-deliverable artefacts.
  const add = runGit(['add', '-A'], worktreePath);
  if (!add.ok) {
    return { committed: false, files_changed: [], reason: `git add failed: ${add.stderr.trim()}` };
  }
  runGit(['reset', '-q', '--', 'LANE-RESULT.json', '.brainclaw', '.brainclaw-heartbeat-*'], worktreePath);

  // The files actually staged for this commit (post-exclusion) — also the
  // truthful files_changed report.
  const staged = runGit(['diff', '--cached', '--name-only'], worktreePath);
  const files = staged.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (files.length === 0) {
    // Only transient files changed — nothing deliverable to commit. Restore the
    // index so the worktree is left exactly as the worker left it.
    runGit(['reset', '-q'], worktreePath);
    return { committed: false, files_changed: [], reason: 'no committable changes (only transient LANE-RESULT.json / .brainclaw)' };
  }

  const authorName = options.authorName ?? 'brainclaw (on behalf)';
  const authorEmail = options.authorEmail ?? 'brainclaw@on-behalf.local';
  const commit = runGit([
    '-c', `user.name=${authorName}`,
    '-c', `user.email=${authorEmail}`,
    '-c', 'commit.gpgsign=false',
    'commit', '-m', message,
  ], worktreePath);
  if (!commit.ok) {
    return { committed: false, files_changed: files, reason: `git commit failed: ${commit.stderr.trim()}` };
  }

  const head = runGit(['rev-parse', 'HEAD'], worktreePath);
  return {
    committed: true,
    sha: head.ok ? head.stdout.trim() : undefined,
    files_changed: files,
    reason: 'committed on behalf of worker',
  };
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
          && !norm.startsWith('.brainclaw-heartbeat-')
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

  if (branchExists) {
    const attachedWorktreePath = findWorktreePathForBranch(listWorktrees(mainWorktreePath), branchName);
    if (attachedWorktreePath) {
      throw new Error(
        `Cannot reuse branch ${branchName}: it is checked out in worktree ${attachedWorktreePath}. Remove or merge that worktree first.`,
      );
    }

    if (options.resetExistingBranch) {
      const reset = runGit(['branch', '--force', branchName, baseRef], mainWorktreePath);
      if (!reset.ok) {
        throw new Error(`git branch --force failed for ${branchName}: ${reset.stderr.trim()}`);
      }
    } else {
      // can_2e282880 (worktree-as-contract at creation): a reused branch is a
      // CONTRACT that the worker starts from the dispatch base, not from
      // whatever stale base the branch happened to sit on (observed live: a
      // June dispatch reused a feat/<scope> branch based on April master).
      //   - branch has NO commits ahead of the base → silently re-point it to
      //     the base (it carries nothing worth keeping);
      //   - branch HAS commits not on the base → REFUSE and name them: they
      //     are unharvested work — merging/harvesting first is the only safe
      //     move, a silent reset would destroy it and a silent reuse would
      //     run the worker on a stale base.
      const ahead = runGit(['rev-list', '--count', `${baseRef}..${branchName}`], mainWorktreePath);
      const aheadCount = ahead.ok ? parseInt(ahead.stdout.trim(), 10) : NaN;
      if (!Number.isFinite(aheadCount)) {
        throw new Error(`Cannot assess divergence of existing branch ${branchName} vs ${baseRef}: ${ahead.stderr.trim()}`);
      }
      if (aheadCount > 0) {
        const commits = runGit(['log', '--oneline', '-n', '5', `${baseRef}..${branchName}`], mainWorktreePath);
        throw new Error(
          `Refusing to reuse branch ${branchName}: it has ${aheadCount} commit(s) not on ${baseRef} (unharvested work). ` +
          `Harvest/merge or delete the branch first. Divergent commits:\n${commits.stdout.trim()}`,
        );
      }
      const reset = runGit(['branch', '--force', branchName, baseRef], mainWorktreePath);
      if (!reset.ok) {
        throw new Error(`git branch --force failed for ${branchName}: ${reset.stderr.trim()}`);
      }
    }
  }

  // Use forward-slash paths for git on Windows
  const gitTargetPath = gitPath(targetPath);
  const worktreeArgs = branchExists
    ? ['worktree', 'add', gitTargetPath, branchName]
    : ['worktree', 'add', '-b', branchName, gitTargetPath, baseRef];

  const result = runGit(worktreeArgs, mainWorktreePath, resolveWorktreeAddTimeoutMs());
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

  // pln#479: opt-in per-worktree typecheck gate. Off by default — on large
  // monorepos `tsc` is slow and a per-commit gate would be punishing — enable
  // with BRAINCLAW_WORKTREE_TYPECHECK_GATE=1. Isolated to this worktree, so the
  // main repo's commits are never affected.
  let typecheckGate: { installed: boolean; reason?: string } | undefined;
  if (process.env.BRAINCLAW_WORKTREE_TYPECHECK_GATE === '1') {
    typecheckGate = installWorktreeTypecheckGate(mainWorktreePath, targetPath);
  }

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
    // pln#479: record whether the per-worktree typecheck gate is active.
    ...(typecheckGate?.installed ? { typecheck_gate: true } : {}),
  };
  fs.writeFileSync(
    path.join(targetPath, '.brainclaw-worktree.json'),
    JSON.stringify(meta, null, 2),
  );

  return targetPath;
}

/** Directory (relative to a worktree root) holding the per-worktree git hooks. */
export const WORKTREE_HOOKS_DIRNAME = '.brainclaw-hooks';

/**
 * The pre-commit gate body (pln#479). Runs via `node -e` — same SIGPIPE-avoiding
 * pattern as install-hooks.ts. Git runs hooks with cwd = worktree root, so the
 * relative paths resolve there. `node` and the tsc entry point are invoked with
 * forward-slash relative paths to stay cross-platform (no quoting/backslash
 * pitfalls). If typescript is absent the gate degrades to a warning rather than
 * blocking — a tooling gap must not trap a worker.
 */
export function buildTypecheckPreCommitScript(): string {
  return `#!/bin/sh
# brainclaw worktree typecheck gate (pln#479) — do not edit manually.
# Blocks the commit when 'tsc --noEmit' fails. Bypass: git commit --no-verify.
exec node -e "
const fs = require('fs');
const { execSync } = require('child_process');
if (!fs.existsSync('tsconfig.json')) process.exit(0);
if (!fs.existsSync('node_modules/typescript/bin/tsc')) {
  process.stderr.write('\\\\n[brainclaw] typecheck gate: typescript not found in worktree node_modules — skipping (commit allowed).\\\\n');
  process.exit(0);
}
try {
  execSync('node node_modules/typescript/bin/tsc --noEmit', { stdio: 'inherit' });
} catch (e) {
  process.stderr.write('\\\\n[brainclaw] commit blocked: tsc --noEmit reported type errors (above). Fix them, or bypass with: git commit --no-verify\\\\n\\\\n');
  process.exit(1);
}
" 2>&1 || exit $?
`;
}

/**
 * pln#479 — install an ISOLATED pre-commit gate in a dispatched worktree that
 * blocks a commit when `tsc --noEmit` fails, so a worker cannot land code that
 * breaks the type-check (observed: workers committing strict-mode-broken TS that
 * only blew up at merge/build time, pln#466).
 *
 * Isolation is the crux: git hooks are shared across all worktrees of a repo by
 * default, so we must NOT write into the common hooks dir — that would impose
 * tsc on the human's main-repo commits too. Instead we point THIS worktree's
 * `core.hooksPath` at a worktree-local dir via the `--worktree` config scope
 * (enabling `extensions.worktreeConfig`), which leaves the main repo's hook
 * setup completely untouched and is torn down with the worktree.
 *
 * No-ops when the worktree has no `tsconfig.json`. Depends on pln#523 having
 * linked `node_modules` so `tsc` resolves.
 */
export function installWorktreeTypecheckGate(
  mainWorktreePath: string,
  worktreePath: string,
): { installed: boolean; reason?: string } {
  if (!fs.existsSync(path.join(worktreePath, 'tsconfig.json'))) {
    return { installed: false, reason: 'no tsconfig.json — not a TypeScript worktree' };
  }
  try {
    const hooksDir = path.join(worktreePath, WORKTREE_HOOKS_DIRNAME);
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), buildTypecheckPreCommitScript(), {
      encoding: 'utf-8',
      mode: 0o755,
    });
    // Enable per-worktree config on the repo (idempotent, additive) so the
    // hooksPath override stays scoped to THIS worktree only.
    runGit(['config', 'extensions.worktreeConfig', 'true'], mainWorktreePath);
    const set = runGit(['config', '--worktree', 'core.hooksPath', gitPath(hooksDir)], worktreePath);
    if (!set.ok) {
      return { installed: false, reason: `git config --worktree core.hooksPath failed: ${set.stderr.trim()}` };
    }
    return { installed: true };
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : String(err) };
  }
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
 * Files brainclaw itself writes into a worktree AT BIRTH — they are never user
 * work and must not count as "uncommitted changes" when deciding whether a
 * merged worktree can be GC'd:
 *   - `.gitignore`            — copied from the main repo by createWorktree; on
 *                               Windows autocrlf flags it as ` M .gitignore`,
 *                               which previously made EVERY brainclaw worktree
 *                               look dirty and skipped the clean forever.
 *   - `.brainclaw-worktree.json` — the sidecar metadata createWorktree writes.
 * Combined with isSystemDirtyPath (.brainclaw/, .git/, agent config dirs).
 */
const WORKTREE_BIRTH_NOISE = new Set(['.gitignore', '.brainclaw-worktree.json']);

/**
 * True when a worktree's `git status --porcelain=v1 -z` output contains ONLY
 * brainclaw birth artifacts / coordination-store noise — i.e. no real user work
 * would be lost by removing it. Empty output (fully clean) also returns true.
 */
export function worktreeHasOnlyBirthNoise(statusZStdout: string): boolean {
  const paths = parsePorcelainZ(statusZStdout);
  return paths.every((p) => {
    const norm = p.replace(/\\/g, '/');
    return WORKTREE_BIRTH_NOISE.has(norm)
      || norm.startsWith('.brainclaw-heartbeat-') // worker liveness sentinel (sprint 1.5)
      || norm === 'LANE-RESULT.json'              // worker outcome report — harvested, never committed
      || isSystemDirtyPath(norm);
  });
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

    // Check for uncommitted changes — but ignore brainclaw birth-noise
    // (.gitignore autocrlf, the sidecar, coordination store). Without this,
    // every merged brainclaw worktree looked dirty and was skipped forever,
    // so `worktree clean` removed nothing and worktrees accumulated (pln#525).
    if (!options.force) {
      const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], wt.path);
      if (status.ok && !worktreeHasOnlyBirthNoise(status.stdout)) {
        result.skipped.push({ path: wt.path, reason: 'uncommitted changes' });
        continue;
      }
    }

    if (options.dryRun) {
      result.removed.push(wt.path);
      continue;
    }

    try {
      // Reaching here means EITHER options.force OR the birth-noise gate above
      // passed (no real user work). In both cases git's own `worktree remove`
      // must be forced: otherwise it refuses on the untracked sidecar /
      // autocrlf .gitignore that we already classified as discardable noise
      // (pln#525 — the refusal that left every merged worktree un-GC-able).
      removeWorktree(mainWorktreePath, wt.path, { force: true });
      result.removed.push(wt.path);
    } catch {
      result.skipped.push({ path: wt.path, reason: 'removal failed' });
    }
  }

  // Clean orphan brainclaw worktree directories (no matching git worktree)
  cleanOrphanWorktreeDirs(mainWorktreePath, worktrees, result, options.dryRun);

  return result;
}

/** A worker whose heartbeat file was touched within this window looks alive. */
const WORKTREE_GC_LIVENESS_WINDOW_MS = 120_000;

export interface WorktreeGcDecision {
  path: string;
  branch?: string;
  removed: boolean;
  /** Why it was removed, or why it was kept. */
  reason: string;
}

/**
 * A worker still looks alive when a `.brainclaw-heartbeat-*` sentinel in its
 * worktree was modified within `windowMs`. Cheap liveness signal that needs no
 * agent_run lookup — the spawn wrapper touches the heartbeat periodically.
 */
function workerLooksAlive(worktreePath: string, windowMs: number): boolean {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(worktreePath)) {
      if (!name.startsWith('.brainclaw-heartbeat-')) continue;
      try {
        if (now - fs.statSync(path.join(worktreePath, name)).mtimeMs < windowMs) return true;
      } catch { /* ignore unreadable sentinel */ }
    }
  } catch { /* worktree dir unreadable — treat as not-alive */ }
  return false;
}

/**
 * Garbage-collect a single dispatched sub-agent worktree once its work is safely
 * harvested (pln#594). Used by the loop-close cascade so review/dispatch
 * worktrees stop accumulating under ~/.brainclaw/worktrees/.
 *
 * SAFE BY DEFAULT — returns { removed: false, reason } instead of removing when:
 *   - a worker still looks alive (recent heartbeat) — never bypassed, even by force;
 *   - the worktree has un-harvested edits (anything beyond brainclaw birth-noise /
 *     LANE-RESULT.json / heartbeat — i.e. real uncommitted work);
 *   - the lane branch has commits NOT reachable from the main repo HEAD
 *     (un-integrated work that `branch -D` would drop).
 * `force` bypasses the dirty + unmerged guards (NOT the liveness guard).
 * Removal is junction-safe (delegates to removeWorktree → detachWorktreeJunctions).
 */
export function gcWorktreeIfHarvested(
  mainWorktreePath: string,
  worktreePath: string,
  options: { force?: boolean; livenessWindowMs?: number } = {},
): WorktreeGcDecision {
  const out = (removed: boolean, reason: string, branch?: string): WorktreeGcDecision => ({
    path: worktreePath, branch, removed, reason,
  });

  if (!worktreePath || !fs.existsSync(worktreePath)) return out(false, 'already gone');

  if (workerLooksAlive(worktreePath, options.livenessWindowMs ?? WORKTREE_GC_LIVENESS_WINDOW_MS)) {
    return out(false, 'worker still active (recent heartbeat)');
  }

  const branchRes = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  const branch = branchRes.ok ? branchRes.stdout.trim() : undefined;

  if (!options.force) {
    const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], worktreePath);
    if (status.ok && !worktreeHasOnlyBirthNoise(status.stdout)) {
      return out(false, 'un-harvested changes in worktree', branch);
    }
    // The lane HEAD must be reachable from the main repo HEAD, else the branch
    // carries un-integrated commits that `branch -D` would silently drop.
    const laneHead = runGit(['rev-parse', 'HEAD'], worktreePath);
    const mainHead = runGit(['rev-parse', 'HEAD'], mainWorktreePath);
    if (laneHead.ok && mainHead.ok) {
      const ancestor = runGit(
        ['merge-base', '--is-ancestor', laneHead.stdout.trim(), mainHead.stdout.trim()],
        mainWorktreePath,
      );
      if (!ancestor.ok) return out(false, 'lane branch has un-integrated commits', branch);
    }
  }

  try {
    removeWorktree(mainWorktreePath, worktreePath, { force: true });
  } catch (err) {
    return out(false, `removal failed: ${(err as Error).message}`, branch);
  }
  // Delete the now-redundant dispatch branch (force: it may be a squash-merge
  // descendant that `-d` would refuse). Best-effort — a kept branch is harmless.
  if (branch && branch !== 'HEAD' && branch !== '(detached)') {
    runGit(['branch', '-D', branch], mainWorktreePath);
  }
  return out(true, options.force ? 'force-removed' : 'harvested + merged', branch);
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
