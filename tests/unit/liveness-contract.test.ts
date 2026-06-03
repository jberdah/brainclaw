/**
 * pln#520 step 1 — verifiable liveness contract.
 *
 * The reconciler now trusts the file SENTINELS (completed/failed/heartbeat)
 * over the untrustworthy wrapper pid (can_f792cacd). These tests drive the
 * verdicts by writing sentinels, not by faking pids:
 *   - completed sentinel        → inferred_completed
 *   - failed sentinel           → inferred_failed (failed_silent + log tail)
 *   - fresh heartbeat           → no_op (alive, even with a dead/absent pid)
 *   - stale heartbeat           → inferred_failed (stalled + log tail)
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  reconcileAgentRun,
  reconcileDeadPidRunningAgentRunAtRead,
} from '../../src/core/agentrun-reconciler.js';
import { createAgentRun } from '../../src/core/agentruns.js';
import {
  ensureRuntimeDirs,
  getRuntimeLogPath,
  getRuntimeSignalPath,
} from '../../src/core/runtime-signals.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;

beforeEach(() => { ws = createTestWorkspace({ currentAgent: 'liveness-test' }); });
afterEach(() => { ws.cleanup(); });

const ASGN = 'asgn_live';

function makeRunningRun() {
  return createAgentRun({
    assignment_id: ASGN,
    claim_id: 'clm_live',
    agent: 'codex',
    transport: 'cli_spawn',
    scope: 'src/x',
    description: 'liveness run',
    status: 'running',
  }, ws.dir);
}

function writeSignal(kind: 'ack' | 'heartbeat' | 'completed' | 'failed', body = ''): string {
  ensureRuntimeDirs(ws.dir);
  const p = getRuntimeSignalPath(ws.dir, ASGN, kind);
  fs.writeFileSync(p, body);
  return p;
}

describe('liveness contract — read path (pln#520 step 1)', () => {
  it('completed sentinel → inferred_completed', () => {
    const run = makeRunningRun();
    writeSignal('completed');
    const r = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(r.action, 'inferred_completed');
    assert.equal(r.current_status, 'completed');
    assert.ok(r.reason.includes('completed sentinel'), r.reason);
  });

  it('failed sentinel → inferred_failed with failed_silent + log tail', () => {
    const run = makeRunningRun();
    ensureRuntimeDirs(ws.dir);
    fs.writeFileSync(getRuntimeLogPath(ws.dir, ASGN, 'stderr'), 'Error: boom at line 42\n');
    writeSignal('failed');
    const r = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(r.action, 'inferred_failed');
    assert.equal(r.current_status, 'failed');
    assert.ok(r.reason.includes('failed_silent'), r.reason);
    assert.ok(r.reason.includes('boom at line 42'), `expected log tail, got: ${r.reason}`);
  });

  it('fresh heartbeat → no_op (worker alive, pid untrusted)', () => {
    const run = makeRunningRun();
    writeSignal('heartbeat', JSON.stringify({ run_id: run.id, nonce: 'n1' }));
    const r = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(r.action, 'no_op');
    assert.equal(r.current_status, 'running', 'a heartbeating worker is never failed');
    assert.ok(r.reason.includes('heartbeat fresh'), r.reason);
  });

  it('stale heartbeat → inferred_failed (stalled)', () => {
    const run = makeRunningRun();
    const p = writeSignal('heartbeat', JSON.stringify({ run_id: run.id }));
    // Backdate the heartbeat mtime well past the stale threshold.
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(p, old, old);
    const r = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir, { heartbeatStaleMs: 10 * 60_000 });
    assert.equal(r.action, 'inferred_failed');
    assert.ok(r.reason.startsWith('stalled:'), r.reason);
  });

  it('completion evidence wins over a stale heartbeat', () => {
    const run = makeRunningRun();
    const p = writeSignal('heartbeat', '{}');
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(p, old, old);
    writeSignal('completed');
    const r = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir, { heartbeatStaleMs: 1 });
    assert.equal(r.action, 'inferred_completed');
  });
});

describe('liveness contract — batch path reconcileAgentRun (pln#520 step 1)', () => {
  it('failed sentinel → inferred_failed past the grace window', () => {
    const run = makeRunningRun();
    writeSignal('failed');
    const r = reconcileAgentRun(run.id, ws.dir, { nowMs: Date.now() + 5 * 60_000 });
    assert.equal(r.action, 'inferred_failed');
    assert.ok(r.reason.includes('failed_silent'), r.reason);
  });

  it('fresh heartbeat → no_op past the grace window', () => {
    const run = makeRunningRun();
    writeSignal('heartbeat', JSON.stringify({ run_id: run.id }));
    const r = reconcileAgentRun(run.id, ws.dir, { nowMs: Date.now() + 5 * 60_000 });
    assert.equal(r.action, 'no_op');
    assert.ok(r.reason.includes('heartbeat fresh'), r.reason);
  });
});
