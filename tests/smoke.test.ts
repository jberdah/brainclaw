import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-smoke-'));
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
      BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
      BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
      BRAINCLAW_TEST_MODE: '1',
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

describe('smoke', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('initializes memory, records a decision, and reports it in status json', () => {
    const init = run(['init', '-y'], dir);
    assert.equal(init.exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, '.brainclaw', 'config.yaml')), true);

    const decision = run(['decision', 'Use auth gateway for OAuth', '--tag', 'auth'], dir);
    assert.equal(decision.exitCode, 0);

    const status = run(['status', '--json'], dir);
    assert.equal(status.exitCode, 0);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.state.active_constraints.length, 0);
    assert.equal(parsed.state.recent_decisions.length, 1);
    assert.equal(parsed.config.storage_dir, '.brainclaw');
  });
});
