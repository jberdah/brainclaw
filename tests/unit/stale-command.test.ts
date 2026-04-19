import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntity, getEntity, listEntities, updateEntity } from '../../src/core/entity-operations.js';
import { runStaleList, runStaleResolve } from '../../src/commands/stale.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * Phase 4 Sprint 1 Lane A step 4 — brainclaw stale CLI command.
 *
 * Covers the happy path where a stale trap gets resolved through the
 * wrapper and disappears from the report. Broader scenarios (plans,
 * runtime_notes, candidates) are exercised by detectStaleness unit
 * tests in staleness-core.test.ts.
 */

function captureConsole(fn: () => void): { logs: string[]; errors: string[] } {
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errors };
}

describe('commands/stale — minimal resolve flow', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-stale-cmd-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('list returns "no stale items" on a fresh workspace', () => {
    const { logs } = captureConsole(() => runStaleList({ cwd: workspace.dir }));
    assert.ok(logs.some((l) => l.includes('No stale items')));
  });

  it('resolve <id> removes a runtime_note when it is flagged stale (expired)', () => {
    // Seed an observation runtime_note, then backdate its expires_at so the
    // staleness detector flags it. updateEntity for runtime_note goes through
    // the generic spread path, so expires_at round-trips correctly.
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const created = createEntity('runtime_note', {
      agent: 'tester',
      text: 'old observation',
      note_type: 'observation',
    }, workspace.dir);
    updateEntity('runtime_note', created.id, { expires_at: tenDaysAgo }, workspace.dir);

    // Confirm the note shows up as stale before resolving.
    const { logs: listLogs } = captureConsole(() => runStaleList({ cwd: workspace.dir }));
    assert.ok(listLogs.some((l) => l.includes('stale runtime note')), 'stale report should mention the note');

    // Resolve should remove the note.
    const { logs: resolveLogs } = captureConsole(() => runStaleResolve(created.id, { cwd: workspace.dir }));
    assert.ok(resolveLogs.some((l) => l.includes(created.id)), 'resolve output should mention the id');

    // After resolve the note is gone from the stale report.
    const { logs: afterLogs } = captureConsole(() => runStaleList({ cwd: workspace.dir }));
    assert.ok(afterLogs.some((l) => l.includes('No stale items')), 'stale report should be clear after resolve');

    // And it is no longer retrievable.
    assert.throws(
      () => getEntity('runtime_note', created.id, workspace.dir),
      /not found/i,
    );
  });

  it('resolve <unknown-id> exits with a helpful error', () => {
    const { errors } = captureConsole(() => {
      const origExit = process.exit;
      process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
      try {
        runStaleResolve('trp_doesnotexist', { cwd: workspace.dir });
      } catch { /* expected */ }
      finally { process.exit = origExit; }
    });
    assert.ok(errors.some((e) => e.includes('not currently flagged stale')));
  });
});
