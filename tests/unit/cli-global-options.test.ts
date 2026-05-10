import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureMemoryDir } from '../../src/core/io.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { emptyState, saveState, loadState } from '../../src/core/state.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initStore(dir: string): void {
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('test-project', { projectId: 'prj_test' }), dir);
  saveState(emptyState(), dir);
}

function runCli(args: string[], cwd: string, homeDir: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
      BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
      BRAINCLAW_TEST_MODE: '1',
      BRAINCLAW_STORE_BOUNDARY: cwd,
      HOME: homeDir,
      USERPROFILE: homeDir,
      USERNAME: 'testuser',
      USER: 'testuser',
    },
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? (result.error ? 124 : 1),
  };
}

describe('cli global option parsing', () => {
  let dir: string;
  let homeDir: string;

  beforeEach(() => {
    dir = tmpDir('bclaw-cli-global-');
    homeDir = tmpDir('bclaw-cli-home-');
    initStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('does not treat subcommand-local --project as the root cross-project flag', () => {
    const result = runCli(['plan', 'Own auth rollout', '--project', 'auth'], dir, homeDir);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /\[pln_[a-f0-9]+\]/, result.stdout);
    assert.doesNotMatch(result.stderr, /linked project|resolveProjectCwd|not found/i, result.stderr);

    const state = loadState(dir);
    const plan = state.plan_items.find((item) => item.text === 'Own auth rollout');
    assert.ok(plan, `Expected plan in state. stdout=${result.stdout}\nstderr=${result.stderr}`);
  });
});
