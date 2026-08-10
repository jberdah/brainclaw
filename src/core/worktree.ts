import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { parsePorcelainZ, isSystemDirtyPath } from './dirty-scope.js';
import { entityRecordDirs } from './io.js';

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
 *
 * trp#950 (dogfood 2026-07-15): a plain truncation makes two DISTINCT scopes
 * that share a >48-char prefix collapse to the SAME branch → same worktree path
 * → the second claim/assign is refused. When (and only when) the cleaned slug
 * exceeds the cap, a deterministic 8-char digest of the FULL cleaned slug is
 * appended so distinct scopes diverge, while the same scope stays stable
 * (resume/re-assign still resolves its worktree). Short scopes are unchanged.
 * 8 hex chars = 32 bits: comfortably collision-safe for the realistic case
 * (a handful of scopes sharing a deep directory prefix) while keeping a
 * 39-char readable head.
 */
const BRANCH_COMPONENT_CAP = 48;
export function sanitizeBranchComponent(raw: string, fallback = 'scope'): string {
  const cleaned = raw
    .replace(/[\s~^:?*[\]\\]/g, '-')   // chars forbidden by check-ref-format
    .replace(/@\{/g, '-')               // reflog syntax
    .replace(/\.\.+/g, '.')             // no double dots
    .replace(/[^a-zA-Z0-9._-]/g, '-')   // conservative whitelist for the rest
    .replace(/-+/g, '-')                // collapse dashes
    .replace(/^[.-]+/, '');             // no leading dot/dash

  let slug: string;
  if (cleaned.length <= BRANCH_COMPONENT_CAP) {
    slug = cleaned.replace(/[.-]+$/, ''); // no trailing dot/dash
  } else {
    // Truncation drops characters → reserve room for a collision-resistant
    // suffix derived from the full cleaned slug (trp#950). The digest is hex, so
    // it can never re-introduce a trailing dot/dash or a `.lock` suffix.
    const suffix = crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 8);
    const head = cleaned.slice(0, BRANCH_COMPONENT_CAP - suffix.length - 1).replace(/[.-]+$/, '');
    slug = `${head}-${suffix}`;
  }
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
 * How a dispatched worktree gets its JS dependencies (`node_modules`).
 *
 * - `link`    (default) — junction the main tree's `node_modules` into the
 *              worktree. Instant, zero disk, but an OUT-OF-WORKTREE-ROOT symlink
 *              that `next dev` / Turbopack rejects (trp_37b05a15).
 * - `install` — run the detected package manager's install AT THE WORKTREE ROOT
 *              after creation, yielding a real in-root `node_modules`
 *              (Turbopack-compatible). Slower; may need the network/cache.
 * - `copy`    — recursively copy `node_modules` from the main tree into the
 *              worktree (real in-root dir, offline, but disk-heavy).
 * - `none`    — provision no JS deps at all (the historical
 *              `BRAINCLAW_NO_LINK_DEPS=1` behavior).
 */
export type WorktreeDepsMode = 'link' | 'install' | 'copy' | 'none';

const WORKTREE_DEPS_MODES: readonly WorktreeDepsMode[] = ['link', 'install', 'copy', 'none'];

/**
 * Resolves the JS dependency provisioning mode for a worktree.
 *
 * Precedence (first match wins):
 *   1. env `BRAINCLAW_WORKTREE_DEPS_MODE` (link|install|copy|none)
 *   2. env `BRAINCLAW_NO_LINK_DEPS=1` → `none` (backward compat)
 *   3. config `worktree.deps_mode` in `.brainclaw/config.yaml`
 *   4. `link` (default — unchanged behavior)
 *
 * An unrecognized env value is ignored (falls through) with a warning, so a
 * typo never silently changes provisioning.
 */
export function resolveWorktreeDepsMode(projectRoot: string): WorktreeDepsMode {
  const envMode = process.env.BRAINCLAW_WORKTREE_DEPS_MODE?.trim().toLowerCase();
  if (envMode) {
    if ((WORKTREE_DEPS_MODES as readonly string[]).includes(envMode)) {
      return envMode as WorktreeDepsMode;
    }
    logger.warn(
      `[worktree] Ignoring invalid BRAINCLAW_WORKTREE_DEPS_MODE='${envMode}' `
      + `(expected one of ${WORKTREE_DEPS_MODES.join('|')}).`,
    );
  }
  if (process.env.BRAINCLAW_NO_LINK_DEPS === '1') return 'none';
  try {
    const configured = loadConfig(projectRoot).worktree?.deps_mode;
    if (configured && (WORKTREE_DEPS_MODES as readonly string[]).includes(configured)) {
      return configured;
    }
  } catch { /* no / invalid config — fall through to default */ }
  return 'link';
}

/** Package manager brainclaw knows how to drive for `install` deps mode. */
export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/**
 * Detects the JS package manager for a project from its lockfile, falling back
 * to the `packageManager` field of package.json, then to `npm`. Lockfile wins
 * because it reflects what actually produced the main tree's `node_modules`.
 */
export function detectPackageManager(projectRoot: string): PackageManager {
  const lockfiles: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ];
  for (const [file, pm] of lockfiles) {
    if (fs.existsSync(path.join(projectRoot, file))) return pm;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as {
      packageManager?: string;
    };
    const declared = pkg.packageManager?.split('@')[0]?.trim();
    if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') {
      return declared;
    }
  } catch { /* no / invalid package.json — default below */ }
  return 'npm';
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
 * Resolve the real git worktree root for `cwd` (pln#614). On an IN-TREE project
 * — a project dir that sits inside a larger repo (monorepo), where the git root
 * is an ancestor, not the project dir itself — `git worktree add` MUST run from
 * the true toplevel, and the per-project worktree hash MUST be derived from it.
 *
 * The bug (trp_28025248, cross-machine dogfooding 1.13.0): the assign/review
 * claim path passed the project cwd straight to createWorktree, so `git worktree
 * add` ran from the project dir and — with an empty `.git` left by the embedded
 * init — failed with "not a git repository", while the ideation path (which
 * resolved the toplevel) worked. resolveGitToplevel makes both paths agree.
 *
 * Falls back to the input cwd when `git rev-parse` cannot resolve a toplevel
 * (not a repo, git absent) so non-git callers and tests keep their behaviour.
 */
export function resolveGitToplevel(cwd: string): string {
  // Codex review of PR #49 (HIGH): a stale/empty `.git` INSIDE the project dir
  // (left by the embedded init — the exact leazzy case) makes `git rev-parse
  // --show-toplevel` FAIL at that level instead of discovering the parent repo:
  // git stops at the invalid gitdir. A plain fallback-to-cwd would then still
  // run from the project dir and hash the subdir — the bug unfixed. So on
  // failure we walk UP and retry from each ancestor, skipping past the invalid
  // nested gitdir until a real toplevel is found; only a truly non-git tree
  // falls back to the input cwd.
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const result = runGit(['rev-parse', '--show-toplevel'], dir);
    if (result.ok) {
      const top = result.stdout.trim();
      if (top) return path.resolve(top);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root — not inside any repo
    dir = parent;
  }
  return cwd;
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
  // the lane branch: the worker's own `LANE-RESULT.json` report, any
  // `.brainclaw/` coordination state, and the `.brainclaw-worktree.json` marker.
  // Committing those would pollute the branch (and master, on merge) with
  // non-deliverable artefacts — a field report (Codex on macOS) caught them
  // landing in a lane commit (trp_01a2ba2a). `.brainclaw-worktree.json` sits at
  // the worktree ROOT (NOT inside `.brainclaw/`), so the `.brainclaw` pathspec
  // does not cover it — it needs its own entry. These are ALWAYS transient, so
  // the unstage is unconditional.
  const add = runGit(['add', '-A'], worktreePath);
  if (!add.ok) {
    return { committed: false, files_changed: [], reason: `git add failed: ${add.stderr.trim()}` };
  }
  runGit([
    'reset', '-q', '--',
    'LANE-RESULT.json',
    '.brainclaw',
    '.brainclaw-worktree.json',
    '.brainclaw-heartbeat-*',
  ], worktreePath);

  // node_modules needs a TRACKED-AWARE exclusion (Codex review of #88, BLOCKING).
  // Unstage the links/dirs brainclaw provisions — but a project that VENDORS
  // node_modules tracks those files, and a worker's change to a TRACKED
  // node_modules file is a REAL deliverable; dropping it would silently omit
  // work. Strategy: unstage every node_modules path, then RE-ADD only the ones
  // already tracked at HEAD and modified/deleted (never the fresh provisioned
  // link/dir, which is `A` vs HEAD). The component-bounded pathspecs never match
  // a similarly-named deliverable such as `src/node_modules_helper.ts` — the
  // plain `node_modules` is root-leading-dir only, the `:(glob)` forms match the
  // `node_modules` path component exactly (nested link entry + nested contents).
  const NODE_MODULES_SPECS = ['node_modules', ':(glob)**/node_modules', ':(glob)**/node_modules/**'];
  runGit(['reset', '-q', '--', ...NODE_MODULES_SPECS], worktreePath);
  const trackedNm = runGit(
    ['diff', '--name-only', '--diff-filter=MD', 'HEAD', '--', ...NODE_MODULES_SPECS],
    worktreePath,
  );
  const keepNm = trackedNm.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (keepNm.length > 0) {
    runGit(['add', '--', ...keepNm], worktreePath);
  }

  // The files actually staged for this commit (post-exclusion) — also the
  // truthful files_changed report.
  const staged = runGit(['diff', '--cached', '--name-only'], worktreePath);
  const files = staged.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (files.length === 0) {
    // Only transient files changed — nothing deliverable to commit. Restore the
    // index so the worktree is left exactly as the worker left it.
    runGit(['reset', '-q'], worktreePath);
    return { committed: false, files_changed: [], reason: 'no committable changes (only transient LANE-RESULT.json / .brainclaw / node_modules links)' };
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

  // trp_e824d2af — LANE-RESULT.json is a TERMINAL SIGNAL, and `reset --hard`
  // does not touch untracked files: left at the root, the PRIOR turn's result
  // reads as the NEXT turn's completion (dispatch_status declared a
  // freshly-spawned round 2 "worker reported done" with round 1's verdict,
  // observed live 2026-08-02). Archive it into the worktree's .brainclaw/
  // sidecar — preserved for forensics, out of the signal path, and already
  // excluded from the residue check below. Best-effort: an archive failure
  // falls through to the residue check, which then names the file loudly
  // instead of passing it silently.
  try {
    const laneResultPath = path.join(worktreePath, 'LANE-RESULT.json');
    if (fs.existsSync(laneResultPath)) {
      const archiveDir = path.join(worktreePath, '.brainclaw');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.renameSync(laneResultPath, path.join(archiveDir, `LANE-RESULT.prev-${fs.statSync(laneResultPath).mtimeMs.toFixed(0)}.json`));
    }
  } catch { /* best-effort — the residue check below surfaces what remains */ }

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

/**
 * trp_72b4e9b3 — on worktree ADOPTION, re-stamp the sidecar's base anchor.
 *
 * The sidecar's `base_ref_sha` (trp#926) is the anchor `commits_ahead` counts
 * from. An adopted worktree keeps its ROUND-1 creation stamp, so round 2's git
 * evidence counted commits since the previous round's base — observed live as
 * a nonsensical `commits_ahead: 2` on a freshly re-pointed worktree. Best-effort:
 * a missing/unreadable sidecar (hand-made worktree) is left untouched.
 */
function refreshSidecarBaseSha(worktreePath: string, mainWorktreePath: string, baseRef: string): void {
  const sidecarPath = path.join(worktreePath, '.brainclaw-worktree.json');
  try {
    if (!fs.existsSync(sidecarPath)) return;
    const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as Record<string, unknown>;
    const rev = runGit(['rev-parse', baseRef], mainWorktreePath);
    meta.base_ref = baseRef;
    if (rev.ok) meta.base_ref_sha = rev.stdout.trim();
    else delete meta.base_ref_sha;
    meta.adopted_at = new Date().toISOString();
    fs.writeFileSync(sidecarPath, JSON.stringify(meta, null, 2));
  } catch { /* best-effort — stale anchor is observability-only */ }
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
/**
 * Whether the project looks like a Next.js app — a `next` dependency in
 * package.json or a `next.config.*` at the root. Used to warn that the
 * out-of-root `node_modules` symlink brainclaw provisions is rejected by
 * `next dev` / Turbopack (trp_37b05a15), even though tsc / vitest / build accept
 * it. Best-effort + defensive: any read/parse error → false (never blocks
 * worktree creation over a heuristic).
 */
export function projectUsesNextjs(projectRoot: string): boolean {
  try {
    for (const cfg of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
      if (fs.existsSync(path.join(projectRoot, cfg))) return true;
    }
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  } catch {
    return false;
  }
}

/**
 * Timeout for a per-worktree package-manager install (`deps_mode=install`).
 * Defaults to 10 minutes; override with BRAINCLAW_WORKTREE_INSTALL_TIMEOUT_MS.
 */
export function resolveWorktreeInstallTimeoutMs(): number {
  const raw = process.env.BRAINCLAW_WORKTREE_INSTALL_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

/**
 * Provisions a worktree's JS dependencies for `install` / `copy` deps modes,
 * yielding a real in-root `node_modules` that `next dev` / Turbopack accepts
 * (unlike the out-of-root junction of `link` mode; trp_37b05a15).
 *
 * Best-effort: any failure is recorded as a warning (the worker can still
 * install by hand) and NEVER thrown — worktree creation must not fail over
 * dependency provisioning. Returns human-readable warnings (empty on success).
 *
 * - `install` runs ONE package-manager install at the worktree root, which
 *   natively populates monorepo workspace `node_modules` too — so it ignores
 *   `nodeModulesRelPaths`. No-op when the project has no `package.json`.
 * - `copy` recursively mirrors each existing `node_modules` dir from the main
 *   tree (symlinks copied verbatim so pnpm's relative link farm stays valid).
 */
export function provisionWorktreeDeps(
  mode: 'install' | 'copy',
  mainWorktreePath: string,
  targetPath: string,
  nodeModulesRelPaths: string[],
): string[] {
  const warnings: string[] = [];

  if (mode === 'install') {
    if (!fs.existsSync(path.join(targetPath, 'package.json'))) return warnings;
    const pm = detectPackageManager(mainWorktreePath);
    const timeoutMs = resolveWorktreeInstallTimeoutMs();
    // Windows: npm/pnpm/yarn/bun are `.cmd` shims, only found via the shell — so
    // pass ONE static command string (pm is validated; 'install' is literal → no
    // injection) and NO args array (avoids DEP0190). Unix: the binaries are on
    // PATH, so spawn directly with an args array and no shell.
    const result = process.platform === 'win32'
      ? spawnSync(`${pm} install`, { cwd: targetPath, encoding: 'utf-8', timeout: timeoutMs, shell: true })
      : spawnSync(pm, ['install'], { cwd: targetPath, encoding: 'utf-8', timeout: timeoutMs });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      const msg = `deps_mode=install: '${pm} install' timed out after ${timeoutMs}ms and was killed `
        + `(raise BRAINCLAW_WORKTREE_INSTALL_TIMEOUT_MS). Run '${pm} install' in the worktree manually.`;
      warnings.push(msg);
      logger.warn(`[worktree] ${msg}`);
    } else if (result.error) {
      const msg = `deps_mode=install: could not run '${pm} install' (${result.error.message}). `
        + `Is ${pm} on PATH? Run '${pm} install' in the worktree manually.`;
      warnings.push(msg);
      logger.warn(`[worktree] ${msg}`);
    } else if (result.status !== 0) {
      const tail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      const msg = `deps_mode=install: '${pm} install' exited ${result.status ?? '?'}${tail ? ` — ${tail}` : ''}. `
        + `Run '${pm} install' in the worktree manually.`;
      warnings.push(msg);
      logger.warn(`[worktree] ${msg}`);
    }
    return warnings;
  }

  // copy
  const copyable = nodeModulesRelPaths.filter((rel) => fs.existsSync(path.join(mainWorktreePath, rel)));
  if (copyable.length === 0) {
    if (fs.existsSync(path.join(targetPath, 'package.json'))) {
      const pm = detectPackageManager(mainWorktreePath);
      const msg = `deps_mode=copy: no node_modules found in the main tree to copy — `
        + `run '${pm} install' in the worktree.`;
      warnings.push(msg);
      logger.warn(`[worktree] ${msg}`);
    }
    return warnings;
  }
  for (const rel of copyable) {
    const src = path.join(mainWorktreePath, rel);
    const dest = path.join(targetPath, rel);
    if (fs.existsSync(dest)) continue;
    try {
      const parentDir = path.dirname(dest);
      if (parentDir !== targetPath) fs.mkdirSync(parentDir, { recursive: true });
      // Codex review P1: if the SOURCE node_modules is itself a symlink/junction
      // (e.g. a main tree that is itself a linked worktree, or a user-linked
      // node_modules), a verbatim copy would reproduce that out-of-root link and
      // Turbopack would still reject it — defeating copy mode. Dereference the
      // TOP-LEVEL entry to its real directory before copying, then copy with
      // verbatimSymlinks so the tree's INTERNAL relative links (pnpm's farm)
      // stay intact. A real dir source copies straight through.
      const srcReal = fs.lstatSync(src).isSymbolicLink() ? fs.realpathSync(src) : src;
      fs.cpSync(srcReal, dest, { recursive: true, verbatimSymlinks: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const msg = `deps_mode=copy: failed to copy '${rel}' into worktree (${reason}). `
        + `Run the package manager's install in the worktree manually.`;
      warnings.push(msg);
      logger.warn(`[worktree] ${msg}`);
    }
  }
  return warnings;
}

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
  // pln#614: resolve the true git toplevel first, so an in-tree project (project
  // dir ≠ git root) creates its worktree from the real repo root — `git worktree
  // add` runs there, and the per-project worktree hash (resolveWorktreePath) is
  // derived from it, matching the ideation path. All git commands + the hash
  // below use this resolved root rather than the raw project cwd.
  mainWorktreePath = resolveGitToplevel(mainWorktreePath);

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
    // trp_72b4e9b3 — the path derives from the branch name, and loop-scoped
    // dispatches derive the SAME branch every round (feat/review-loop-<lop>).
    // A fresh claim on round 2 therefore collided here and the whole spawn
    // failed (spawn_no_worktree) — worse, the claim persisted without a
    // worktree and wedged every later dispatch on the scope. When the existing
    // path is a REGISTERED worktree of this repo checked out on EXACTLY the
    // requested branch, ADOPT it: honor the reused-branch contract first
    // (can_2e282880 — never destroy unharvested commits unless the caller
    // explicitly pinned a reset), then re-point it to the base. Anything else
    // at the path (foreign dir, other branch) still refuses loudly.
    const attachedPath = findWorktreePathForBranch(listWorktrees(mainWorktreePath), branchName);
    const sameTarget = attachedPath !== undefined && (process.platform === 'win32'
      ? path.resolve(attachedPath).toLowerCase() === path.resolve(targetPath).toLowerCase()
      : path.resolve(attachedPath) === path.resolve(targetPath));
    if (sameTarget) {
      // Resolve the base to a SHA in the MAIN repo first: resetWorktreeToRef
      // runs inside the worktree, where a symbolic ref like "HEAD" resolves to
      // the WORKTREE's own tip — a silent no-op reset onto the stale round.
      const requestedBase = options.baseRef ?? 'HEAD';
      const baseRev = runGit(['rev-parse', requestedBase], mainWorktreePath);
      if (!baseRev.ok) {
        throw new Error(`Cannot adopt worktree ${targetPath}: base ref ${requestedBase} does not resolve: ${baseRev.stderr.trim()}`);
      }
      const adoptBase = baseRev.stdout.trim();
      // Review PR#167 P1 — TRACKED dirt is unharvested work, unconditionally.
      // A sandboxed codex CANNOT commit (.git read-only): its entire review
      // output lives as staged/unstaged edits the coordinator harvests via
      // `git diff HEAD`. The commit guard below never sees those, and the
      // hard reset would destroy them silently — even under an explicit
      // reset pin, because the pin means "start from this base", never
      // "discard a worker's unharvested output". Untracked files are fine:
      // the reset leaves them and resetWorktreeToRef's residue check governs.
      const dirt = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=no'], targetPath);
      if (!dirt.ok) {
        throw new Error(`Cannot adopt worktree ${targetPath}: dirty-state check failed: ${dirt.stderr.trim()}`);
      }
      if (dirt.stdout.length > 0) {
        const files = dirt.stdout.split('\0').filter(Boolean).map((e) => e.slice(3)).slice(0, 5).join(', ');
        throw new Error(
          `Refusing to adopt worktree ${targetPath}: it has uncommitted TRACKED changes (${files}) — a sandboxed worker's ` +
          `unharvested output. Harvest the diff first (git diff HEAD in that worktree) or remove the worktree.`,
        );
      }
      if (!options.resetExistingBranch) {
        const ahead = runGit(['rev-list', '--count', `${adoptBase}..${branchName}`], mainWorktreePath);
        const aheadCount = ahead.ok ? parseInt(ahead.stdout.trim(), 10) : NaN;
        if (!Number.isFinite(aheadCount)) {
          throw new Error(`Cannot assess divergence of existing worktree branch ${branchName} vs ${adoptBase}: ${ahead.stderr.trim()}`);
        }
        if (aheadCount > 0) {
          const commits = runGit(['log', '--oneline', '-n', '5', `${adoptBase}..${branchName}`], mainWorktreePath);
          throw new Error(
            `Refusing to adopt worktree ${targetPath}: branch ${branchName} has ${aheadCount} commit(s) not on ${adoptBase} (unharvested work). ` +
            `Harvest/merge or remove the worktree first. Divergent commits:\n${commits.stdout.trim()}`,
          );
        }
      }
      const reset = resetWorktreeToRef(targetPath, adoptBase);
      if (!reset.ok) {
        throw new Error(
          `Worktree path already exists and could not be adopted (reset to ${adoptBase} failed: ${reset.stderr.trim()}). ` +
          `Remove it first with 'brainclaw worktree remove'.`,
        );
      }
      logger.warn(`[worktree] adopted existing worktree ${targetPath} (branch ${branchName}) and re-pointed it to ${adoptBase}`);
      refreshSidecarBaseSha(targetPath, mainWorktreePath, adoptBase);
      return targetPath;
    }
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
  // can build/typecheck sub-packages, not just the root.
  //
  // trp_37b05a15: the JS dependency provisioning mode (link | install | copy |
  // none) is opt-in via BRAINCLAW_WORKTREE_DEPS_MODE / config worktree.deps_mode
  // (BRAINCLAW_NO_LINK_DEPS=1 still maps to `none`). `link` (default) junctions
  // node_modules from the main tree — an out-of-root symlink `next dev` rejects;
  // `install`/`copy` provision a real in-root node_modules (Turbopack-ok);
  // `none` provisions no deps (central validation). Explicit options.sharedPaths
  // are always honored.
  const isNodeModulesPath = (p: string): boolean => p === 'node_modules' || p.endsWith('/node_modules');
  const depsMode = resolveWorktreeDepsMode(mainWorktreePath);
  const detected = depsMode === 'none'
    ? []
    : [...detectStackSharedPaths(mainWorktreePath), ...detectWorkspaceNodeModules(mainWorktreePath)];
  const extra = options.sharedPaths ?? [];
  const excluded = new Set(options.excludeShared ?? []);
  const requested = [...new Set([...detected, ...extra])].filter((p) => !excluded.has(p));

  // In install/copy mode, node_modules becomes a REAL in-root directory instead
  // of an out-of-root junction — so it is excluded from the symlink pass and
  // provisioned separately. Other stack dirs (venv, vendor, …) still link.
  const provisionDeps = depsMode === 'install' || depsMode === 'copy';
  const nodeModulesPaths = requested.filter(isNodeModulesPath);
  const sharedPaths = provisionDeps ? requested.filter((p) => !isNodeModulesPath(p)) : requested;
  for (const entry of sharedPaths) {
    trySymlinkSharedPath(entry);
  }

  // Codex review P1: track whether in-root provisioning actually succeeded, so
  // the dispatch brief can tell the worker the truth. A failed install/copy is
  // best-effort (non-fatal) but the worker must then install itself — the brief
  // must NOT claim "node_modules is real, do not reinstall" over a failure.
  let depsProvisioned: boolean | undefined;
  if (provisionDeps) {
    const provisionWarnings = provisionWorktreeDeps(depsMode, mainWorktreePath, targetPath, nodeModulesPaths);
    symlinkWarnings.push(...provisionWarnings);
    depsProvisioned = provisionWarnings.length === 0;
  } else if (depsMode === 'link') {
    // trp_37b05a15 (field report, Next.js 16 / Turbopack) — the node_modules link
    // brainclaw provisions is an out-of-worktree-root symlink to the main repo.
    // tsc / vitest / build follow it fine, but `next dev` (Turbopack) PANICS on a
    // node_modules link that points outside the worktree root. Surface a warning
    // (not a failure — the link is still correct for build/typecheck) so a worker
    // or operator doing dev-server work knows the workaround up front.
    const linkedNodeModules = sharedPaths.some(isNodeModulesPath);
    if (linkedNodeModules && projectUsesNextjs(mainWorktreePath)) {
      const msg =
        'Next.js detected: node_modules is linked as an out-of-worktree-root symlink, which '
        + '`next dev` / Turbopack rejects (it requires node_modules under the worktree root). '
        + 'tsc / vitest / build are unaffected. For dev-server work, set deps_mode=install '
        + '(config worktree.deps_mode or BRAINCLAW_WORKTREE_DEPS_MODE=install), run `npm install` '
        + 'here, or smoke-test on the merged branch.';
      symlinkWarnings.push(msg);
      logger.warn(`[worktree] ${msg}`);
    }
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

  // trp#926 — record the RESOLVED base ref SHA at creation time. base_ref is
  // usually "HEAD" or a branch name, both of which drift after creation and
  // are useless for later "how many commits did the worker add?" comparisons.
  // The resolved SHA is the stable anchor: `${base_ref_sha}..HEAD` on the lane
  // deterministically counts the worker's contribution even as master advances.
  // Best-effort — an unresolvable base_ref simply omits the field.
  const baseRefSha = (() => {
    const rev = runGit(['rev-parse', baseRef], mainWorktreePath);
    return rev.ok ? rev.stdout.trim() : undefined;
  })();

  // Write brainclaw metadata sidecar inside the worktree
  const meta = {
    session_id: options.sessionId,
    agent: options.agent,
    user: process.env.USER || process.env.USERNAME || undefined,
    created_at: new Date().toISOString(),
    main_worktree_path: mainWorktreePath,
    base_ref: baseRef,
    ...(baseRefSha ? { base_ref_sha: baseRefSha } : {}),
    reset_existing_branch: options.resetExistingBranch === true,
    git_advice: 'git add ONLY specific files, NEVER git add -A.',
    // trp_37b05a15: how JS deps were provisioned (link junction / real install /
    // copy / none) — non-default modes are recorded so a worker/supervisor knows
    // whether node_modules is an out-of-root link (dev-server caveat) or in-root.
    // `deps_provisioned` (install/copy only) records whether the in-root
    // provisioning actually succeeded — false means best-effort failed and the
    // worker must install itself (Codex review P1).
    ...(depsMode !== 'link' ? { deps_mode: depsMode } : {}),
    ...(depsProvisioned !== undefined ? { deps_provisioned: depsProvisioned } : {}),
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
 * Depth cap for detachWorktreeJunctions' recursive walk. 8 covers realistic
 * monorepo trees (apps/<pkg>/packages/<pkg>/node_modules, pnpm nested links)
 * while keeping the walk bounded on pathological structures. Hitting the cap
 * is a hard failure: continuing to `git worktree remove` after an incomplete
 * scan would re-open the junction-follow wipe class. .git is skipped outright
 * — it never contains user junctions and can be very deep.
 */
const JUNCTION_SCAN_MAX_DEPTH = 8;

/**
 * pln#498 + trp#926 (2026-07-03 incident) — Detach ALL symlinks/junctions from
 * a worktree before any recursive removal. On Windows, `git worktree remove`
 * performs its own recursive rm and historically (git ≤ 2.38) followed NTFS
 * junctions into the main repo, wiping `node_modules`. Unlinking every
 * junction entry first leaves git only regular files/dirs to walk.
 *
 * Historically this only inspected top-level entries — that covered the
 * classic single-stack shared `node_modules` case but MISSED:
 *   - monorepo per-package junctions created by pln#523
 *     (apps/<pkg>/node_modules, packages/<pkg>/node_modules);
 *   - operator- or worker-created manual junctions at nested paths.
 * The 2026-07-03 incident (node_modules racine rasé via the auto-junction)
 * was a recurrence of the pln#498 class, extended one level of nesting.
 *
 * The recursion NEVER descends into a symlink (lstat + unlink at the entry
 * itself), so it cannot follow a junction into the main repo. `.git/` is
 * skipped entirely — git manages its own state and it never holds user
 * junctions. Depth is capped defensively at JUNCTION_SCAN_MAX_DEPTH; hitting
 * the cap aborts removal rather than silently leaving deeper links in place.
 */
export function detachWorktreeJunctions(worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return;
  const failures: string[] = [];
  detachJunctionsRecursively(worktreePath, 0, failures);
  if (failures.length > 0) {
    throw new Error(`could not safely detach worktree junctions: ${failures.join('; ')}`);
  }
}

function detachJunctionsRecursively(dir: string, depth: number, failures: string[]): void {
  if (depth > JUNCTION_SCAN_MAX_DEPTH) {
    failures.push(`scan depth exceeded at ${dir}`);
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    failures.push(`could not read ${dir}: ${(err as Error).message}`);
    return;
  }

  for (const entry of entries) {
    // `.git` is a file (linked worktree pointer) at the worktree root or a
    // real dir in the main repo — either way, do not walk it.
    if (entry.name === '.git') continue;
    const child = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(child);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      // Unlink the junction. Do NOT descend into it (that would follow the
      // link back into the main repo — the exact class we're preventing).
      try {
        fs.unlinkSync(child);
      } catch (unlinkErr) {
        try {
          fs.rmdirSync(child);
        } catch (rmdirErr) {
          failures.push(
            `could not detach link ${child}: unlink=${(unlinkErr as Error).message}; rmdir=${(rmdirErr as Error).message}`,
          );
        }
      }
      continue;
    }
    if (stat.isDirectory()) {
      detachJunctionsRecursively(child, depth + 1, failures);
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

  // pln#647 — PROTOCOL DEBRIS MUST NOT BLOCK AN EXPLICIT REMOVE.
  //
  // The bulk `worktree clean` path already knows that a heartbeat, a LANE-RESULT or
  // a copied .gitignore are brainclaw's OWN artifacts and not user work
  // (worktreeHasOnlyBirthNoise). This path did not, so `git worktree remove` refused
  // with "contains modified or untracked files" over a file brainclaw itself wrote
  // and never gitignores. Observed 2026-08-04 in brainclaw's own repo: two of three
  // worker worktrees refused removal, blocked by a lone
  // `.brainclaw-heartbeat-<asgn>`. That is not cosmetic — a worktree surviving its
  // lane is what makes a re-dispatch on the same loop scope collide
  // (`spawn_no_worktree`), and the retry then wedges the scope with a claim that has
  // no worktree (trp#72b4e9b3, whose documented recovery begins by deleting exactly
  // this heartbeat by hand).
  //
  // So: consult the SAME predicate the clean path uses. Only brainclaw's own noise is
  // forced through; a worktree holding real user work still refuses, and the caller
  // must pass force explicitly.
  const args = ['worktree', 'remove', worktreePath];
  let force = options.force === true;
  if (!force && fs.existsSync(worktreePath)) {
    const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], worktreePath);
    // `isAutoForcibleDebris`, NOT `worktreeHasOnlyBirthNoise`: the latter also
    // forgives agent-config dirs, which is safe for gating and post-merge gc but not
    // for a destruction with no merge gate (review of pln#647).
    if (status.ok && status.stdout.trim().length > 0 && isAutoForcibleDebris(status.stdout)) {
      force = true;
    }
  }
  if (force) args.push('--force');

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
 * The ONLY paths an explicit `worktree remove` may force through on its own.
 *
 * NARROWER THAN `worktreeHasOnlyBirthNoise` ON PURPOSE (review of pln#647).
 * That predicate folds in `isSystemDirtyPath`, which classes agent-config dirs
 * (`.claude/`, `.cursor/`, `.codex/`) as noise — calibrated for two jobs that destroy
 * nothing: dispatch GATING, and the POST-MERGE gc where the content is already
 * integrated. Reusing it for a removal with NO merge gate would let
 * `brainclaw worktree remove`, without `--force`, silently delete an agent's
 * uncommitted `.claude/agents/x.md` or a modified tracked `.claude/settings.json`.
 *
 * So this lists brainclaw's OWN protocol artifacts by name and nothing else. A
 * worktree holding anything else — including agent config — still refuses and needs
 * an explicit force, which is what the pln#647 commit claimed and did not deliver.
 */
export function isAutoForcibleDebris(statusZStdout: string): boolean {
  const paths = parsePorcelainZ(statusZStdout);
  if (paths.length === 0) return false;
  return paths.every((p) => {
    const norm = p.replace(/\\/g, '/');
    return norm === '.gitignore'                    // copied at birth; CRLF-flipped on Windows
      || norm === '.brainclaw-worktree.json'         // sidecar metadata
      || norm === 'LANE-RESULT.json'                 // worker outcome report — harvested
      || norm === 'REVIEW-FINDINGS.md'
      || norm === 'REVIEW_FINDINGS.md'
      || norm === 'TRIAGE-REPORT.json'
      || norm.startsWith('.brainclaw-heartbeat-')    // worker liveness sentinel
      || norm === '.brainclaw' || norm.startsWith('.brainclaw/'); // coordination store
  });
}

/**
 * trp#926 (squash-aware GC) — True when every commit on `branch` that is not
 * an ancestor of `baseRef` has a patch-equivalent commit ALREADY on `baseRef`.
 *
 * `git branch --merged HEAD` and `merge-base --is-ancestor` are ancestry-only:
 * a squash-merge on GitHub creates a NEW commit on master whose ancestry does
 * not include the lane commits, so an ancestry probe returns "not merged" and
 * the GC keeps the worktree forever. `git cherry <base> <branch>` uses
 * patch-id equivalence — the same signal GitHub itself uses to say "this PR is
 * merged". Output is one line per commit in `base..branch`:
 *   `+ <sha>` = patch NOT yet on base (a real un-integrated commit)
 *   `- <sha>` = patch already on base (via squash / cherry-pick / rebase)
 * The branch is "merged by content" iff there are no `+` lines. An empty
 * output (no commits ahead of base) is also merged.
 *
 * Returns `false` on any git failure — a probe that cannot prove merged must
 * NEVER lie "yes" and cause a keep-me worktree to be GC'd. Callers combine
 * this with ancestry ('git branch --merged') so both signals contribute.
 */
export function isBranchMergedByContent(
  mainWorktreePath: string,
  branchName: string,
  baseRef = 'HEAD',
): boolean {
  const cherry = runGit(['cherry', baseRef, branchName], mainWorktreePath);
  if (!cherry.ok) return false;
  const lines = cherry.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true; // no commits ahead of base → fully merged
  // A `+` line means "patch not on base" — one is enough to disqualify.
  if (!lines.some((l) => l.startsWith('+ '))) return true;

  // Multi-commit squash merges often do not produce per-commit patch-id
  // matches: the squash commit's aggregate patch differs from each individual
  // branch commit. As a second, still content-only signal, compare the final
  // content of files changed by the branch. If every branch-touched path now
  // matches baseRef, removing the worktree cannot drop unique file content.
  const mergeBase = runGit(['merge-base', baseRef, branchName], mainWorktreePath);
  if (!mergeBase.ok || !mergeBase.stdout.trim()) return false;
  const changed = runGit(['diff', '--name-only', '-z', mergeBase.stdout.trim(), branchName], mainWorktreePath);
  if (!changed.ok) return false;
  const paths = changed.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return true;
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const diff = runGit(['diff', '--quiet', branchName, baseRef, '--', ...chunk], mainWorktreePath);
    if (!diff.ok) return false;
  }
  return true;
}

/**
 * True when a LOCAL git branch of this exact name exists (pln#529). Lets the
 * gated-sequence base selector distinguish "predecessor branch gone (merged +
 * cleaned → code is on HEAD)" from "branch present but not yet integrated →
 * fork the dependent lane from it". Returns false on any git failure.
 */
export function localBranchExists(mainWorktreePath: string, branchName: string): boolean {
  return probeLocalBranch(mainWorktreePath, branchName) === 'present';
}

/**
 * pln#529 — TRI-STATE local-branch probe. `localBranchExists` collapses "branch
 * genuinely absent" and "git failed" into one `false`, and the gated-base
 * resolver's unsafe direction is "absent → assume on HEAD". A transient git
 * failure (timeout, index.lock, not-a-repo) must NOT be read as "absent → the
 * socle is on HEAD" (that silently drops the predecessor's code). `git rev-parse
 * --verify --quiet` exits 1 with EMPTY stderr for a clean not-found; any other
 * failure carries stderr — so:
 *   present  = exit 0
 *   absent   = failure with empty stderr (clean not-found)
 *   unknown  = failure with stderr (real git error — caller must fail safe)
 */
export type BranchProbe = 'present' | 'absent' | 'unknown';
export function probeLocalBranch(mainWorktreePath: string, branchName: string): BranchProbe {
  const r = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], mainWorktreePath);
  if (r.ok) return 'present';
  return r.stderr.trim() === '' ? 'absent' : 'unknown';
}

/**
 * True when `cwd` is inside a git work tree. pln#529 uses this to distinguish a
 * NON-git project (where branch/worktree propagation is inapplicable — fall back
 * to the legacy HEAD base) from a git repo whose branch probe transiently failed
 * (which must fail SAFE, not silently assume HEAD).
 */
export function isGitRepo(cwd: string): boolean {
  return runGit(['rev-parse', '--is-inside-work-tree'], cwd).ok;
}

/**
 * Comparison key for worktree paths: PHYSICAL identity when the path exists
 * (realpath expands Windows 8.3 short names — `RUNNER~1` and `runneradmin`
 * are the same directory but different strings, and git always reports the
 * long form while a claim may carry the short one), else plain resolution.
 * Forward slashes, case-folded on win32.
 */
function worktreePathKey(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  resolved = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Worktree paths referenced by an ACTIVE, non-expired claim — the set the GC
 * must never touch.
 *
 * Read directly from the claims record dirs (both layouts, pln#649) instead of
 * claims.ts: claims.ts imports worktree.ts, so the dependency can only point
 * this way. The parse is deliberately lenient — an unreadable claim simply does
 * not protect anything; it never blocks the GC of OTHER worktrees.
 *
 * Scope note: dispatch claims are project-local, so the project store is the
 * right authority here; workspace-level claims (cross-project) never carry a
 * lane worktree_path.
 */
function activeClaimWorktreePaths(cwd: string): Set<string> {
  const out = new Set<string>();
  const now = new Date();
  for (const dir of entityRecordDirs('claims', cwd)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const claim = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as {
          status?: string;
          worktree_path?: string;
          expires_at?: string;
        };
        if (claim.status !== 'active') continue;
        if (typeof claim.worktree_path !== 'string' || !claim.worktree_path) continue;
        // Mirror isClaimExpired: a zombie claim past its expiry must not make a
        // worktree un-GC-able forever.
        if (claim.expires_at && new Date(claim.expires_at) < now) continue;
        out.add(worktreePathKey(claim.worktree_path));
      } catch {
        /* lenient by design — see above */
      }
    }
  }
  return out;
}

/**
 * Removes worktrees whose branch has been fully merged into the current branch
 * (typically master/main after a merge). Also removes brainclaw-managed
 * worktree directories that no longer have a corresponding git worktree entry
 * (orphan dirs left behind by force-deleted branches).
 *
 * Safe by default: skips worktrees with uncommitted changes unless `force` is set.
 *
 * trp#926 — Merged detection is a UNION of two signals:
 *   - ancestry (`git branch --merged HEAD`): catches fast-forward / merge-commit;
 *   - content (`git cherry HEAD <branch>`, patch-id): catches squash merges,
 *     which is GitHub's default merge strategy on this repo and previously left
 *     every squashed lane un-GC-able forever.
 *
 * ACTIVE-CLAIM GATE (incident 2026-08-10): a freshly-dispatched lane worktree
 * has no commits of its own — its branch IS an ancestor of HEAD, so both merged
 * probes say "merged" — and before the agent's first write it has no uncommitted
 * changes either. Both historical gates therefore pass during a lane's startup
 * window, and the post-merge hook destroyed a live codex lane 7 minutes after
 * spawn (worktree emptied under the running agent). The coordination store is
 * the authority on liveness: a worktree referenced by an active claim is
 * untouchable — merged or not, clean or not, force or not. The escape hatch is
 * releasing the claim, never bypassing it.
 */
export function cleanMergedWorktrees(
  mainWorktreePath: string,
  options: { force?: boolean; dryRun?: boolean } = {},
): CleanResult {
  const result: CleanResult = { removed: [], skipped: [], pruned: false };

  // pln#614: resolve the toplevel so an in-tree project scans the same
  // per-project worktree hash createWorktree wrote under (and runs git from the
  // real repo root).
  mainWorktreePath = resolveGitToplevel(mainWorktreePath);

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
  const protectedPaths = activeClaimWorktreePaths(mainWorktreePath);

  for (const wt of worktrees) {
    if (wt.is_main) continue;

    // Active-claim gate — see the function doc. Checked BEFORE the merged
    // probes and BEFORE `force`: a live dispatched lane is never GC-able.
    if (protectedPaths.has(worktreePathKey(wt.path))) {
      result.skipped.push({ path: wt.path, reason: 'active claim' });
      continue;
    }

    // trp#926 — a lane's branch is "merged" if EITHER git says its commits are
    // ancestors of HEAD (fast-forward / merge-commit) OR every commit's patch
    // is already on HEAD (squash-merge, catching GitHub's default strategy).
    // Without the content probe, squashed lanes accumulate forever.
    const isMerged = mergedBranches.has(wt.branch)
      || isBranchMergedByContent(mainWorktreePath, wt.branch, 'HEAD');
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
  cleanOrphanWorktreeDirs(mainWorktreePath, worktrees, result, options.dryRun, protectedPaths);

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

  // pln#614: the merge-base / patch-id probes below run from the main repo — an
  // in-tree project dir (empty .git) would fail them; resolve the real toplevel.
  mainWorktreePath = resolveGitToplevel(mainWorktreePath);

  if (workerLooksAlive(worktreePath, options.livenessWindowMs ?? WORKTREE_GC_LIVENESS_WINDOW_MS)) {
    return out(false, 'worker still active (recent heartbeat)');
  }

  const branchRes = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  const branch = branchRes.ok ? branchRes.stdout.trim() : undefined;

  if (!options.force) {
    // FAIL CLOSED (codex review): every safety probe that cannot be read must
    // KEEP the worktree, never fall through to removal. A transient `git status`
    // timeout on a real, dirty worktree previously skipped the dirty check and
    // force-removed it — losing un-harvested edits. Same for the HEAD reads.
    const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], worktreePath);
    if (!status.ok) {
      return out(false, 'could not read worktree status — keeping (fail-closed)', branch);
    }
    if (!worktreeHasOnlyBirthNoise(status.stdout)) {
      return out(false, 'un-harvested changes in worktree', branch);
    }
    // The lane HEAD must be reachable from the main repo HEAD, else the branch
    // carries un-integrated commits that `branch -D` would silently drop.
    const laneHead = runGit(['rev-parse', 'HEAD'], worktreePath);
    const mainHead = runGit(['rev-parse', 'HEAD'], mainWorktreePath);
    if (!laneHead.ok || !mainHead.ok) {
      return out(false, 'could not verify merge status — keeping (fail-closed)', branch);
    }
    const ancestor = runGit(
      ['merge-base', '--is-ancestor', laneHead.stdout.trim(), mainHead.stdout.trim()],
      mainWorktreePath,
    );
    // exit 0 = ancestor (safe). Non-zero = not an ancestor OR a git error — both
    // mean "cannot prove integrated via ancestry". trp#926 — fall back to the
    // content probe (patch-id): a squash-merged lane is not an ancestor but is
    // fully integrated, and previously the GC kept it forever. Ancestry OR
    // content, either signal is enough; a failed content probe still keeps the
    // worktree (isBranchMergedByContent returns false on git failure).
    if (!ancestor.ok && branch && !isBranchMergedByContent(mainWorktreePath, branch, mainHead.stdout.trim())) {
      return out(false, 'lane branch has un-integrated commits (or unverifiable)', branch);
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
  protectedPaths: Set<string> = new Set(),
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

    // Active-claim gate: a dir whose git admin entry vanished can still host a
    // LIVE agent (the 2026-08-10 incident left exactly this state behind). If a
    // claim still points here, it is not debris.
    if (protectedPaths.has(worktreePathKey(dirPath))) {
      result.skipped.push({ path: dirPath, reason: 'active claim' });
      continue;
    }

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
