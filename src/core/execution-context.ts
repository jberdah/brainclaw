import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ExecutionToolVersion {
  name: string;
  available: boolean;
  version?: string;
}

export interface ExecutionEnvSignal {
  name: string;
  value: string;
  redacted: boolean;
}

export interface GitWorktreeInfo {
  /** Absolute path to the .git directory (or gitdir file for linked worktrees). */
  git_dir: string;
  /** Absolute path to the current worktree root. */
  worktree_path: string;
  /** Absolute path to the main worktree root (same as worktree_path for non-linked worktrees). */
  main_worktree_path: string;
  /** True if this is a linked worktree (not the main one). */
  is_linked_worktree: boolean;
}

export interface ExecutionContextSnapshot {
  platform: NodeJS.Platform;
  shell: string;
  cwd: string;
  workspace_root: string;
  branch?: string;
  git_status: 'clean' | 'dirty' | 'unavailable';
  has_remote: boolean;
  /** Git worktree details — undefined when not in a git repo. */
  git_worktree?: GitWorktreeInfo;
  /** Number of commits the current branch is behind the main branch (master/main). */
  commits_behind_main?: number;
  toolchains: ExecutionToolVersion[];
  env_signals: ExecutionEnvSignal[];
}

export interface CompactExecutionContextSnapshot {
  platform: NodeJS.Platform;
  shell?: string;
  workspace_root: string;
  branch?: string;
  git_status: 'clean' | 'dirty' | 'unavailable';
  has_remote: boolean;
  commits_behind_main?: number;
  toolchains: ExecutionToolVersion[];
}

export interface ExecutionContextOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult;

const TOOLCHAINS: Array<{ name: string; command: string; args: string[] }> = [
  { name: 'node', command: 'node', args: ['--version'] },
  { name: 'npm', command: 'npm', args: ['--version'] },
  { name: 'pnpm', command: 'pnpm', args: ['--version'] },
  { name: 'python', command: 'python', args: ['--version'] },
  { name: 'pip', command: 'pip', args: ['--version'] },
  { name: 'cargo', command: 'cargo', args: ['--version'] },
  { name: 'go', command: 'go', args: ['version'] },
];

const ENV_WHITELIST = [
  'BRAINCLAW_AGENT',
  'BRAINCLAW_HOST_ID',
  'BRAINCLAW_SESSION_ID',
  'OPENCLAW_AGENT',
  'OPENCLAW_SESSION_ID',
  'CI',
  'NODE_ENV',
  'VIRTUAL_ENV',
  'CONDA_DEFAULT_ENV',
  'npm_config_user_agent',
];

let cachedToolchains: ExecutionToolVersion[] | undefined;

export function buildExecutionContext(options: ExecutionContextOptions = {}): ExecutionContextSnapshot {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;

  const workspaceRoot = detectWorkspaceRoot(cwd, runner);
  const branch = detectGitBranch(cwd, runner);
  const gitStatus = detectGitStatus(cwd, runner);
  const hasRemote = detectGitRemote(cwd, runner);

  return {
    platform: process.platform,
    shell: detectShell(env),
    cwd,
    workspace_root: workspaceRoot,
    branch,
    git_status: gitStatus,
    has_remote: hasRemote,
    git_worktree: detectGitWorktree(cwd, runner),
    commits_behind_main: branch ? detectCommitsBehindMain(cwd, branch, runner) : undefined,
    toolchains: detectToolchains(cwd, runner),
    env_signals: captureEnvSignals(env),
  };
}

export function compactExecutionContext(snapshot: ExecutionContextSnapshot): CompactExecutionContextSnapshot {
  return {
    platform: snapshot.platform,
    shell: snapshot.shell,
    workspace_root: snapshot.workspace_root,
    branch: snapshot.branch,
    git_status: snapshot.git_status,
    has_remote: snapshot.has_remote,
    commits_behind_main: snapshot.commits_behind_main,
    toolchains: snapshot.toolchains.filter((tool) => tool.available),
  };
}

export function renderExecutionContextSummary(
  snapshot: ExecutionContextSnapshot | CompactExecutionContextSnapshot,
  includeEnvSignals: boolean = false,
): string {
  const lines: string[] = [];
  lines.push(`Platform: ${snapshot.platform}`);
  if (snapshot.shell) {
    lines.push(`Shell: ${snapshot.shell}`);
  }
  lines.push(`Workspace: ${snapshot.workspace_root}`);
  if (snapshot.branch) {
    lines.push(`Git branch: ${snapshot.branch}`);
  }
  lines.push(`Git status: ${snapshot.git_status}`);
  if ('git_worktree' in snapshot && snapshot.git_worktree) {
    const wt = snapshot.git_worktree;
    lines.push(`Git worktree: ${wt.worktree_path}${wt.is_linked_worktree ? ' (linked)' : ' (main)'}`);
    if (wt.is_linked_worktree) {
      lines.push(`Main worktree: ${wt.main_worktree_path}`);
    }
  }
  lines.push(`Git remote: ${snapshot.has_remote ? 'configured' : 'none'}`);
  if ('commits_behind_main' in snapshot && snapshot.commits_behind_main && snapshot.commits_behind_main > 0) {
    lines.push(`⚠ Branch is ${snapshot.commits_behind_main} commit(s) behind master. Consider rebasing before editing.`);
  }

  const availableToolchains = snapshot.toolchains.filter((tool) => tool.available);
  if (availableToolchains.length > 0) {
    lines.push(`Toolchains: ${availableToolchains.map((tool) => `${tool.name}${tool.version ? ` ${tool.version}` : ''}`).join(', ')}`);
  } else {
    lines.push('Toolchains: none detected');
  }

  if (includeEnvSignals && 'env_signals' in snapshot && snapshot.env_signals.length > 0) {
    lines.push('Environment signals:');
    for (const signal of snapshot.env_signals) {
      lines.push(`- ${signal.name}=${signal.value}`);
    }
  }

  return lines.join('\n');
}

function detectWorkspaceRoot(cwd: string, runner: CommandRunner): string {
  const result = runner('git', ['rev-parse', '--show-toplevel'], cwd);
  if (result.status === 0) {
    return result.stdout.trim();
  }
  return cwd;
}

function detectGitBranch(cwd: string, runner: CommandRunner): string | undefined {
  const result = runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (result.status !== 0) {
    return undefined;
  }
  const branch = result.stdout.trim();
  return branch && branch !== 'HEAD' ? branch : undefined;
}

function detectGitWorktree(cwd: string, runner: CommandRunner): GitWorktreeInfo | undefined {
  const gitDir = runner('git', ['rev-parse', '--git-dir'], cwd);
  const toplevel = runner('git', ['rev-parse', '--show-toplevel'], cwd);
  if (gitDir.status !== 0 || toplevel.status !== 0) return undefined;

  const gitDirPath = path.resolve(cwd, gitDir.stdout.trim());
  const worktreePath = toplevel.stdout.trim();

  // Main worktree: resolve via git-common-dir (points to the shared .git for linked worktrees)
  const commonDir = runner('git', ['rev-parse', '--git-common-dir'], cwd);
  let mainWorktreePath = worktreePath;
  let isLinked = false;

  if (commonDir.status === 0) {
    const commonDirPath = path.resolve(cwd, commonDir.stdout.trim());
    // For linked worktrees, git-common-dir !== git-dir
    if (path.normalize(commonDirPath) !== path.normalize(gitDirPath)) {
      isLinked = true;
      // The main worktree is the parent of the common .git directory
      mainWorktreePath = path.dirname(commonDirPath);
    }
  }

  return {
    git_dir: gitDirPath,
    worktree_path: worktreePath,
    main_worktree_path: mainWorktreePath,
    is_linked_worktree: isLinked,
  };
}

function detectGitStatus(cwd: string, runner: CommandRunner): 'clean' | 'dirty' | 'unavailable' {
  const result = runner('git', ['status', '--porcelain'], cwd);
  if (result.status !== 0) {
    return 'unavailable';
  }
  return result.stdout.trim().length > 0 ? 'dirty' : 'clean';
}

function detectGitRemote(cwd: string, runner: CommandRunner): boolean {
  const result = runner('git', ['remote'], cwd);
  if (result.status !== 0) {
    return false;
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length > 0;
}

/**
 * Detect how many commits the current branch is behind the main branch.
 * Tries master then main as the reference branch.
 * Returns undefined if not in a git repo or on the main branch itself.
 */
function detectCommitsBehindMain(cwd: string, currentBranch: string, runner: CommandRunner): number | undefined {
  // Don't check if already on main branch
  if (currentBranch === 'master' || currentBranch === 'main') return undefined;

  // Try both master and main, return the highest count found.
  // This handles repos where both branches exist but only one is the real reference.
  let maxBehind: number | undefined;
  for (const mainBranch of ['master', 'main']) {
    const result = runner('git', ['rev-list', '--count', `${currentBranch}..${mainBranch}`], cwd);
    if (result.status === 0) {
      const count = parseInt(result.stdout.trim(), 10);
      if (!isNaN(count) && (maxBehind === undefined || count > maxBehind)) {
        maxBehind = count;
      }
    }
  }

  return maxBehind;
}

function detectToolchains(cwd: string, runner: CommandRunner): ExecutionToolVersion[] {
  if (runner === defaultRunner && cachedToolchains) {
    return cachedToolchains;
  }

  const detected = TOOLCHAINS.map((tool) => {
    const result = runner(tool.command, tool.args, cwd);
    if (result.status !== 0) {
      return { name: tool.name, available: false };
    }
    const version = firstNonEmptyLine(result.stdout || result.stderr);
    return {
      name: tool.name,
      available: true,
      version,
    };
  });

  if (runner === defaultRunner) {
    cachedToolchains = detected;
  }

  return detected;
}

function captureEnvSignals(env: NodeJS.ProcessEnv): ExecutionEnvSignal[] {
  const signals: ExecutionEnvSignal[] = [];

  for (const name of ENV_WHITELIST) {
    const raw = env[name]?.trim();
    if (!raw) {
      continue;
    }
    signals.push({
      name,
      value: normalizeEnvValue(name, raw),
      redacted: isRedactedEnv(name),
    });
  }

  return signals;
}

function normalizeEnvValue(name: string, value: string): string {
  if (name === 'CI') {
    return value.toLowerCase() === 'true' ? 'true' : 'set';
  }
  if (name === 'VIRTUAL_ENV') {
    return path.basename(value);
  }
  if (name === 'BRAINCLAW_SESSION_ID' || name === 'OPENCLAW_SESSION_ID') {
    return redactValue(value);
  }
  if (name === 'npm_config_user_agent') {
    return value.split(' ')[0] ?? value;
  }
  return value;
}

function isRedactedEnv(name: string): boolean {
  return name === 'BRAINCLAW_SESSION_ID' || name === 'OPENCLAW_SESSION_ID';
}

function redactValue(value: string): string {
  if (value.length <= 10) {
    return 'set';
  }
  return `${value.slice(0, 5)}...${value.slice(-3)}`;
}

function detectShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL?.trim();
  if (shell) {
    return path.basename(shell).replace(/\.exe$/i, '');
  }
  if (env.PSModulePath) {
    return 'powershell';
  }
  const comspec = env.ComSpec?.trim() ?? env.COMSPEC?.trim();
  if (comspec) {
    return path.basename(comspec).replace(/\.exe$/i, '');
  }
  return process.platform === 'win32' ? 'unknown-windows-shell' : 'unknown-shell';
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function defaultRunner(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
