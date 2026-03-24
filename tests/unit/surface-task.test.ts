import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-surface-task-'));
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const fakeHome = path.join(cwd, '.fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 90000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
      BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
      BRAINCLAW_STORE_BOUNDARY: cwd,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      USERNAME: 'testuser',
      USER: 'testuser',
    },
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('surface-task CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    const initResult = run(['init', '-y'], dir);
    assert.equal(initResult.exitCode, 0, initResult.stderr);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('queues a desktop AI surface task and lists it', () => {
    const createResult = run([
      'surface-task', 'create', 'Generate homepage hero visual',
      '--target', 'chatgpt',
      '--kind', 'visual_asset',
      '--instructions', 'Create a lightweight SaaS hero visual in PNG format.',
      '--output', 'assets/hero-home.png',
      '--tag', 'design',
      '--path', 'src/pages/Home.tsx',
    ], dir);

    assert.equal(createResult.exitCode, 0, createResult.stderr);
    assert.match(createResult.stdout, /Surface task queued/);
    assert.match(createResult.stdout, /chatgpt/);

    const listResult = run(['surface-task', 'list'], dir);
    assert.equal(listResult.exitCode, 0, listResult.stderr);
    assert.match(listResult.stdout, /Generate homepage hero visual/);
    assert.match(listResult.stdout, /queued, target chatgpt, kind visual_asset/);
    assert.match(listResult.stdout, /assets\/hero-home\.png/);
  });

  it('updates a queued task to completed with a result note', () => {
    const createResult = run([
      'surface-task', 'create', 'Draft release summary',
      '--target', 'claude',
      '--kind', 'summary',
      '--instructions', 'Summarize the bootstrap improvements for non-dev users.',
    ], dir);
    assert.equal(createResult.exitCode, 0, createResult.stderr);

    const idMatch = createResult.stdout.match(/\[(ast_[a-f0-9]+)\]/);
    assert.ok(idMatch, createResult.stdout);
    const taskId = idMatch[1]!;

    const updateResult = run([
      'surface-task', 'update', taskId,
      '--status', 'completed',
      '--result', 'Saved summary into internal-docs/releases/bootstrap-summary.md',
      '--output', 'internal-docs/releases/bootstrap-summary.md',
    ], dir);

    assert.equal(updateResult.exitCode, 0, updateResult.stderr);
    assert.match(updateResult.stdout, /Surface task updated/);

    const listResult = run(['surface-task', 'list', '--all'], dir);
    assert.equal(listResult.exitCode, 0, listResult.stderr);
    assert.match(listResult.stdout, /completed, target claude, kind summary/);
    assert.match(listResult.stdout, /Saved summary into internal-docs\/releases\/bootstrap-summary\.md/);
  });
});
