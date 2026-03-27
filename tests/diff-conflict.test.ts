import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { AGENT_ENV_KEYS } from './helpers/workspace.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

// Absolute URL to the compiled state module for inline script tests
const DIST_STATE_URL = pathToFileURL(
  path.resolve(import.meta.dirname, '..', '..', 'dist', 'core', 'state.js')
).href;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-diff-'));
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
    USERNAME: 'testuser',
    USER: 'testuser',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };
  for (const key of AGENT_ENV_KEYS) {
    delete env[key];
  }
  const configPath = path.join(cwd, '.brainclaw', 'config.yaml');
  if (fs.existsSync(configPath)) {
    const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as { current_agent?: string; current_agent_id?: string };
    if (config.current_agent) {
      env.BRAINCLAW_AGENT_NAME = config.current_agent;
      env.BRAINCLAW_AGENT = config.current_agent;
    }
    if (config.current_agent_id) {
      env.BRAINCLAW_AGENT_ID = config.current_agent_id;
    }
  }
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    env,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

describe('diff command', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
    run(['register-agent', 'contributor-bot', '--kind', 'agent', '--set-current'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('diff --since far past shows all entries', () => {
    run(['decision', 'Auth gateway decision'], dir);
    run(['constraint', 'No direct DB writes from frontend'], dir);

    const res = run(['diff', '--since', '2020-01-01T00:00:00Z'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Changes since'));
    assert.ok(res.stdout.includes('Auth gateway decision'));
    assert.ok(res.stdout.includes('No direct DB writes from frontend'));
  });

  it('diff --since future shows no changes', () => {
    run(['decision', 'Some decision'], dir);

    const res = run(['diff', '--since', '2099-01-01T00:00:00Z'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('No changes'));
  });

  it('diff --json returns structured output with correct shape', () => {
    run(['decision', 'JSON diff decision'], dir);
    run(['reflect', 'Candidate for diff', '--type', 'trap'], dir);

    const res = run(['diff', '--since', '2020-01-01T00:00:00Z', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.ok(typeof parsed.since === 'string');
    assert.ok(typeof parsed.checked_at === 'string');
    assert.ok(typeof parsed.total_changes === 'number');
    assert.ok(Array.isArray(parsed.state_entries));
    assert.ok(Array.isArray(parsed.new_candidates));
    assert.ok(Array.isArray(parsed.accepted_candidates));
    assert.ok(parsed.total_changes > 0);

    const decision = parsed.state_entries.find((e: { entry_type: string }) => e.entry_type === 'decision');
    assert.ok(decision, 'should contain decision entry');
    assert.ok(decision.text.includes('JSON diff decision'));
  });

  it('diff shows new candidates pending review', () => {
    run(['reflect', 'Trap for diff test', '--type', 'trap'], dir);

    const res = run(['diff', '--since', '2020-01-01T00:00:00Z'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Trap for diff test'));
    assert.ok(res.stdout.includes('pending review') || res.stdout.includes('?'));
  });

  it('diff without --since fails when no .last-context marker exists', () => {
    // No context command run — no marker
    const res = run(['diff'], dir);
    assert.notEqual(res.exitCode, 0);
    assert.ok(
      res.stderr.includes('.last-context') || res.stderr.includes('context'),
      'should mention how to create the marker'
    );
  });

  it('diff uses .last-context marker written by context command', () => {
    // Run a decision first (will be "before context")
    run(['decision', 'Old decision before context'], dir);

    // Run context — writes .last-context marker
    run(['context'], dir);

    // Verify marker was written
    const markerPath = path.join(dir, '.brainclaw', '.last-context');
    assert.ok(fs.existsSync(markerPath), '.last-context should be written by context');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    assert.ok(typeof marker.memory_version === 'string');

    // Add new entry after context
    run(['decision', 'New decision after context'], dir);

    // diff without --since reads the marker
    const res = run(['diff'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('New decision after context'));
    assert.ok(!res.stdout.includes('Old decision before context'));
  });

  it('diff without --since advances the marker (cursor semantics)', () => {
    // Bootstrap marker via context
    run(['context'], dir);

    // Add entry after first context
    run(['decision', 'Entry after first context'], dir);

    // First diff: should show the entry and advance the marker
    const res1 = run(['diff'], dir);
    assert.equal(res1.exitCode, 0);
    assert.ok(res1.stdout.includes('Entry after first context'));

    // Second diff immediately after: marker was advanced, should show nothing new
    const res2 = run(['diff'], dir);
    assert.equal(res2.exitCode, 0);
    assert.ok(res2.stdout.includes('No changes'));
  });

  it('diff --since invalid date errors clearly', () => {
    const res = run(['diff', '--since', 'not-a-date'], dir);
    assert.notEqual(res.exitCode, 0);
    assert.ok(res.stderr.includes('invalid date') || res.stderr.includes('ISO'));
  });

  it('diff shows accepted candidates since timestamp', () => {
    const rDiff = run(['reflect', 'Good trap to accept', '--type', 'trap'], dir);
    run(['accept', extractId(rDiff.stdout), '--by', 'testuser'], dir);

    const res = run(['diff', '--since', '2020-01-01T00:00:00Z', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.accepted_candidates.length > 0, 'should show accepted candidate');
    assert.ok(parsed.accepted_candidates[0].text.includes('Good trap to accept'));
  });
});

