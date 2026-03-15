import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { memoryDir } from './io.js';

export interface RemoteSyncResult {
  success: boolean;
  message: string;
  details?: string;
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function hasGitRemote(remoteName: string, cwd: string): boolean {
  const result = runGit(['remote', 'get-url', remoteName], cwd);
  return result.ok;
}

export function pullRemoteMemory(options: { remote?: string; cwd?: string } = {}): RemoteSyncResult {
  const cwd = options.cwd ?? process.cwd();
  const remote = options.remote ?? 'origin';

  if (!hasGitRemote(remote, cwd)) {
    return { success: false, message: `Git remote '${remote}' not found. Add it with: git remote add ${remote} <url>` };
  }

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch.ok) {
    return { success: false, message: 'Could not determine current branch.' };
  }

  const result = runGit(['pull', '--no-rebase', remote, branch.stdout], cwd);
  if (!result.ok) {
    return { success: false, message: `git pull failed: ${result.stderr}`, details: result.stderr };
  }

  return { success: true, message: `Pulled from ${remote}/${branch.stdout}`, details: result.stdout };
}

export function pushRemoteMemory(options: { remote?: string; cwd?: string; message?: string } = {}): RemoteSyncResult {
  const cwd = options.cwd ?? process.cwd();
  const remote = options.remote ?? 'origin';
  const memDir = memoryDir(cwd);
  const relativeMemDir = path.relative(cwd, memDir);

  if (!hasGitRemote(remote, cwd)) {
    return { success: false, message: `Git remote '${remote}' not found.` };
  }

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch.ok) {
    return { success: false, message: 'Could not determine current branch.' };
  }

  // Stage only the memory directory (shared content only — machine/private-specific dirs excluded)
  const addResult = runGit(['add', relativeMemDir], cwd);
  if (!addResult.ok) {
    return { success: false, message: `git add failed: ${addResult.stderr}` };
  }

  // Check if there's anything to commit
  const statusResult = runGit(['diff', '--cached', '--quiet'], cwd);
  if (statusResult.ok) {
    return { success: true, message: 'Nothing to push — memory is already in sync with last commit.' };
  }

  const commitMsg = options.message ?? 'chore: sync brainclaw memory';
  const commitResult = runGit(['commit', '-m', commitMsg], cwd);
  if (!commitResult.ok) {
    return { success: false, message: `git commit failed: ${commitResult.stderr}` };
  }

  const pushResult = runGit(['push', remote, branch.stdout], cwd);
  if (!pushResult.ok) {
    return { success: false, message: `git push failed: ${pushResult.stderr}`, details: pushResult.stderr };
  }

  return { success: true, message: `Pushed to ${remote}/${branch.stdout}`, details: pushResult.stdout };
}

export function diffRemoteMemory(options: { remote?: string; cwd?: string } = {}): RemoteSyncResult {
  const cwd = options.cwd ?? process.cwd();
  const remote = options.remote ?? 'origin';

  if (!hasGitRemote(remote, cwd)) {
    return { success: false, message: `Git remote '${remote}' not found.` };
  }

  // Fetch to update remote refs without merging
  runGit(['fetch', remote], cwd);

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const diffResult = runGit(['diff', `${remote}/${branch.stdout}`, '--', memoryDir(cwd)], cwd);
  if (!diffResult.ok) {
    return { success: false, message: `git diff failed: ${diffResult.stderr}` };
  }

  if (!diffResult.stdout) {
    return { success: true, message: 'Memory is in sync with remote — no differences.' };
  }

  return { success: true, message: 'Differences found with remote:', details: diffResult.stdout };
}
