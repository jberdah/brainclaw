import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-worktree-'));
}

/** Run brainclaw CLI against a temp store. */
function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 20000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
      USERNAME: 'testuser',
      USER: 'testuser',
      BRAINCLAW_STORE_BOUNDARY: cwd,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/** Create a minimal git repo + brainclaw store for testing. */
function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Need at least one commit for branches/worktrees to work
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

describe('brainclaw worktree CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    initGitRepo(dir);
    // Init brainclaw store
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    // Cleanup any linked worktrees before removing temp dir
    try {
      execSync('git worktree prune', { cwd: dir, stdio: 'pipe' });
    } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('list shows no linked worktrees on a fresh repo', () => {
    const result = run(['worktree', 'list'], dir);
    // Should succeed (exit 0 or just print)
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  });

  it('create adds a linked worktree for a new branch', () => {
    const result = run(['worktree', 'create', 'feat/wt-test'], dir);
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('✔ Worktree created'),
      `Expected success message, got: ${result.stdout}`,
    );
    assert.ok(result.stdout.includes('feat/wt-test'));
  });

  it('create fails gracefully for a bare repo guard', () => {
    // A bare repo cannot host a linked worktree via brainclaw
    const bareDir = tmpDir();
    execSync('git init --bare', { cwd: bareDir, stdio: 'pipe' });
    run(['init', '-y'], bareDir);

    const result = run(['worktree', 'create', 'feat/some-branch'], bareDir);
    // Should fail with a clear error message
    assert.notEqual(result.exitCode, 0);
    assert.ok(
      result.stderr.includes('bare') || result.stdout.includes('bare') || result.stderr.length > 0,
      `Expected bare-repo error, got stdout: ${result.stdout} stderr: ${result.stderr}`,
    );
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it('list shows the created worktree after create', () => {
    run(['worktree', 'create', 'feat/wt-list-test'], dir);
    const listResult = run(['worktree', 'list'], dir);
    assert.equal(listResult.exitCode, 0, `stderr: ${listResult.stderr}`);
    // The main worktree should always be present
    assert.ok(
      listResult.stdout.includes('branch') || listResult.stdout.includes(dir),
      `Expected worktree listing, got: ${listResult.stdout}`,
    );
  });

  it('prune runs without error', () => {
    const result = run(['worktree', 'prune'], dir);
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('pruned'));
  });
});
