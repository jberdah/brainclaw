import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-handoff-contract-'));
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
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

function readHandoff(dir: string): Record<string, unknown> {
  const handoffDir = path.join(dir, '.brainclaw', 'coordination', 'handoffs');
  const files = fs.readdirSync(handoffDir).filter(f => f.endsWith('.json'));
  assert.ok(files.length > 0, 'Expected at least one handoff file');
  return JSON.parse(fs.readFileSync(path.join(handoffDir, files[0]), 'utf-8'));
}

describe('handoff command with contract fields', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates handoff with --files', () => {
    const res = run([
      'handoff', 'Pass auth work',
      '--from', 'claude', '--to', 'copilot',
      '--files', 'src/auth.ts', 'src/middleware.ts',
    ], dir);
    assert.equal(res.exitCode, 0, res.stderr);

    const handoff = readHandoff(dir);
    assert.ok(handoff.contract, 'Expected contract to be set');
    const contract = handoff.contract as Record<string, unknown>;
    assert.deepEqual(contract.files_touched, ['src/auth.ts', 'src/middleware.ts']);
  });

  it('creates handoff with all contract fields', () => {
    const res = run([
      'handoff', 'Complete refactor',
      '--from', 'claude', '--to', 'copilot',
      '--files', 'src/core/state.ts',
      '--pre-condition', 'branch feat/refactor exists',
      '--post-condition', 'all tests pass', 'coverage above 60%',
      '--test', 'tests/unit/state.test.ts',
      '--linked-plan', 'pln_abc123',
    ], dir);
    assert.equal(res.exitCode, 0, res.stderr);

    const handoff = readHandoff(dir);
    const contract = handoff.contract as Record<string, unknown>;
    assert.deepEqual(contract.files_touched, ['src/core/state.ts']);
    assert.deepEqual(contract.pre_conditions, ['branch feat/refactor exists']);
    assert.deepEqual(contract.post_conditions, ['all tests pass', 'coverage above 60%']);
    assert.deepEqual(contract.tests_to_verify, ['tests/unit/state.test.ts']);
    assert.deepEqual(contract.linked_plans, ['pln_abc123']);
  });

  it('creates handoff without contract when no contract fields given', () => {
    const res = run([
      'handoff', 'Simple pass',
      '--from', 'claude', '--to', 'copilot',
    ], dir);
    assert.equal(res.exitCode, 0, res.stderr);

    const handoff = readHandoff(dir);
    assert.equal(handoff.contract, undefined);
  });

  it('backward compatible: handoff without contract parses correctly', () => {
    // Create a handoff the old way (no contract), verify it still works
    const res = run([
      'handoff', 'Legacy handoff',
      '--from', 'agent-a', '--to', 'agent-b',
      '--tag', 'legacy',
    ], dir);
    assert.equal(res.exitCode, 0, res.stderr);

    const handoff = readHandoff(dir);
    assert.equal(handoff.contract, undefined);
    assert.equal(handoff.from, 'agent-a');
    assert.equal(handoff.to, 'agent-b');
  });
});
