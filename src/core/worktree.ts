import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Normalizes a path for use in git CLI arguments (forward slashes on Windows). */
function gitPath(p: string): string {
  return p.replace(/\\/g, '/');
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
  options: { sessionId?: string; agent?: string } = {},
): string {
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

  // Use forward-slash paths for git on Windows
  const gitTargetPath = gitPath(targetPath);
  const worktreeArgs = branchExists
    ? ['worktree', 'add', gitTargetPath, branchName]
    : ['worktree', 'add', '-b', branchName, gitTargetPath];

  const result = runGit(worktreeArgs, mainWorktreePath);
  if (!result.ok) {
    throw new Error(`git worktree add failed: ${result.stderr.trim()}`);
  }

  // Write brainclaw metadata sidecar inside the worktree
  const meta = {
    session_id: options.sessionId,
    agent: options.agent,
    user: process.env.USER || process.env.USERNAME || undefined,
    created_at: new Date().toISOString(),
    main_worktree_path: mainWorktreePath,
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

  // Remove brainclaw metadata directory if it sits under ~/.brainclaw/worktrees
  // (safety: only delete managed paths, never arbitrary dirs)
  const base = path.join(os.homedir(), '.brainclaw', 'worktrees');
  if (worktreePath.startsWith(base) && fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
}

/**
 * Prunes stale worktree administrative files from `.git/worktrees/`.
 * Equivalent to `git worktree prune`.
 */
export function pruneWorktrees(mainWorktreePath: string): void {
  runGit(['worktree', 'prune'], mainWorktreePath);
}
