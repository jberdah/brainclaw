import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sanitizedProcessEnv } from './helpers/workspace.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-handoff-'));
}

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...sanitizedProcessEnv(),
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

describe('update-handoff command', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a handoff and updates its status to accepted', () => {
    const createRes = run([
      'handoff',
      'Pass the auth work to claude',
      '--from', 'copilot',
      '--to', 'claude',
    ], dir);
    assert.equal(createRes.exitCode, 0, createRes.stderr);
    const handoffId = extractId(createRes.stdout);

    const updateRes = run(['update-handoff', handoffId, '--status', 'accepted'], dir);
    assert.equal(updateRes.exitCode, 0, updateRes.stderr);
    assert.ok(updateRes.stdout.includes('Handoff updated'), updateRes.stdout);
    assert.ok(updateRes.stdout.includes('accepted'), updateRes.stdout);

    const [hFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs')).filter(f => f.endsWith('.json'));
    const handoff = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs', hFile), 'utf-8'));
    assert.equal(handoff.status, 'accepted');
  });

  it('updates the receiving agent with --to', () => {
    const createRes = run(['handoff', 'Delegate auth review', '--from', 'copilot', '--to', 'claude'], dir);
    const handoffId = extractId(createRes.stdout);

    const updateRes = run(['update-handoff', handoffId, '--to', 'gemini'], dir);
    assert.equal(updateRes.exitCode, 0, updateRes.stderr);

    const [hFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs')).filter(f => f.endsWith('.json'));
    const handoff = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs', hFile), 'utf-8'));
    assert.equal(handoff.to, 'gemini');
  });

  it('closes a handoff with status closed', () => {
    const createRes = run(['handoff', 'Handover session context', '--from', 'copilot', '--to', 'claude'], dir);
    const handoffId = extractId(createRes.stdout);

    run(['update-handoff', handoffId, '--status', 'closed'], dir);

    const [hFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs')).filter(f => f.endsWith('.json'));
    const handoff = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs', hFile), 'utf-8'));
    assert.equal(handoff.status, 'closed');
  });

  it('captures a structured review verdict on the handoff', () => {
    const createRes = run(['handoff', 'Review auth patch', '--from', 'copilot', '--to', 'claude'], dir);
    const handoffId = extractId(createRes.stdout);

    const updateRes = run([
      'update-handoff',
      handoffId,
      '--review-verdict', 'request_changes',
      '--reviewed-by', 'codex',
      '--review-summary', 'Null handling is still incomplete.',
      '--blocking-issue', 'Missing null guard in auth callback path.',
      '--suggestion', 'Add a regression test for empty provider payloads.',
    ], dir);
    assert.equal(updateRes.exitCode, 0, updateRes.stderr);

    const [hFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs')).filter(f => f.endsWith('.json'));
    const handoff = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs', hFile), 'utf-8'));
    assert.equal(handoff.review.verdict, 'request_changes');
    assert.equal(handoff.review.reviewed_by, 'codex');
    assert.equal(handoff.review.summary, 'Null handling is still incomplete.');
    assert.deepEqual(handoff.review.blocking_issues, ['Missing null guard in auth callback path.']);
    assert.deepEqual(handoff.review.suggestions, ['Add a regression test for empty provider payloads.']);
    assert.equal(typeof handoff.review.reviewed_at, 'string');
  });

  it('errors on unknown handoff id', () => {
    const res = run(['update-handoff', 'hnd_doesnotexist', '--status', 'accepted'], dir);
    assert.equal(res.exitCode, 1);
    assert.ok(res.stderr.includes('not found'), res.stderr);
  });
});

