/**
 * Functional coverage for `brainclaw repair` (pln#397 stp_6d5c80f1).
 *
 * Drives runRepair() against seeded broken-store fixtures to assert that
 * doctor-surfaced candidates actually fix the drift, preserve data, and
 * degrade gracefully on re-runs.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRepair } from '../../src/commands/repair.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function captureConsole(fn: () => void): { logs: string[]; errors: string[] } {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  return { logs, errors };
}

describe('brainclaw repair — functional flow', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-repair-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('creates missing entity subdirectories via mkdir action', () => {
    // Simulate drift: remove one of the expected subdirs that createTestWorkspace
    // seeded. We pick traps/ because nothing in the helper writes to it.
    const missing = path.join(workspace.dir, '.brainclaw', 'memory', 'traps');
    if (fs.existsSync(missing)) {
      fs.rmSync(missing, { recursive: true, force: true });
    }
    assert.ok(!fs.existsSync(missing), 'precondition: directory must be missing');

    let result: ReturnType<typeof runRepair>;
    captureConsole(() => {
      result = runRepair({ cwd: workspace.dir });
    });

    assert.ok(result!.ok, 'repair should complete without failures');
    assert.ok(result!.applied.some((o) => o.action === 'mkdir' && o.target.endsWith('memory/traps')));
    assert.ok(fs.existsSync(missing), 'directory should be recreated');
  });

  it('dry-run reports candidates without creating anything', () => {
    const missing = path.join(workspace.dir, '.brainclaw', 'memory', 'traps');
    if (fs.existsSync(missing)) {
      fs.rmSync(missing, { recursive: true, force: true });
    }

    let result: ReturnType<typeof runRepair>;
    captureConsole(() => {
      result = runRepair({ cwd: workspace.dir, dryRun: true });
    });

    assert.ok(result!.dry_run, 'result must flag dry_run');
    assert.equal(result!.applied.length, 0, 'dry-run applies nothing');
    assert.ok(result!.skipped.some((o) => o.reason === 'dry-run'));
    assert.ok(!fs.existsSync(missing), 'dry-run must not create the directory');
  });

  it('safe-by-default: unsafe candidates are deferred with a clear reason', () => {
    // Seed an inbox message stored at inbox root (orphaned) that parses as
    // invalid JSON — doctor will emit a quarantine (unsafe) candidate.
    const inboxRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'inbox');
    fs.mkdirSync(inboxRoot, { recursive: true });
    const bogus = path.join(inboxRoot, 'broken-message.json');
    fs.writeFileSync(bogus, '{ not valid json', 'utf-8');

    let result: ReturnType<typeof runRepair>;
    captureConsole(() => {
      result = runRepair({ cwd: workspace.dir });
    });

    // The bogus file should NOT have moved — quarantine is unsafe.
    assert.ok(fs.existsSync(bogus), 'unsafe file must stay in place by default');
    const unsafeSkipped = result!.skipped.find((o) => o.action === 'quarantine_inbox_message');
    if (unsafeSkipped) {
      assert.match(unsafeSkipped.reason ?? '', /include-unsafe/);
    }
  });

  it('repair is idempotent: second run has nothing to apply', () => {
    const missing = path.join(workspace.dir, '.brainclaw', 'memory', 'traps');
    if (fs.existsSync(missing)) {
      fs.rmSync(missing, { recursive: true, force: true });
    }
    captureConsole(() => runRepair({ cwd: workspace.dir }));
    let second: ReturnType<typeof runRepair>;
    captureConsole(() => {
      second = runRepair({ cwd: workspace.dir });
    });
    const mkdirApplied = second!.applied.filter((o) => o.action === 'mkdir');
    assert.equal(mkdirApplied.length, 0, 'second run must not re-apply mkdir');
  });

  it('json output returns a structured RepairResult', () => {
    const missing = path.join(workspace.dir, '.brainclaw', 'memory', 'traps');
    if (fs.existsSync(missing)) {
      fs.rmSync(missing, { recursive: true, force: true });
    }

    let captured = '';
    const orig = console.log;
    console.log = (...args: unknown[]) => { captured += args.map(String).join(' '); };
    try {
      runRepair({ cwd: workspace.dir, json: true });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(captured);
    assert.ok('ok' in parsed);
    assert.ok('applied' in parsed && Array.isArray(parsed.applied));
    assert.ok('candidates_total' in parsed);
    assert.ok('candidates_safe' in parsed);
    assert.ok('candidates_unsafe' in parsed);
  });
});
