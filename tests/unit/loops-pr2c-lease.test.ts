import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, deriveChildIds,
  type ReserveInput,
} from '../../src/core/loops/attempt-reservation.js';
import { createAgentRun, loadAgentRun, transitionAgentRun } from '../../src/core/agentruns.js';
import { reconcileAgentRun, sweepTurnOwnedPreRunLeaseAtRead } from '../../src/core/agentrun-reconciler.js';
import { runDispatchHealthCheck } from '../../src/commands/doctor.js';
import { ensureRuntimeDirs, writeCompletionSignal } from '../../src/core/runtime-signals.js';

// pln#630 PR2c-lease (§4 + R5): a TURN-OWNED run preallocated `created`/`launching`
// converges on its dispatch/launch LEASE, never on the pid/heartbeat heuristics.
//   crossed grant, past lease → failed / launch_attempted_unknown (never completed)
//   no launch receipt, past lease → cancelled / reserved_never_launched
//   within lease → no-op ; turn-keyed completion → no-op (reconcileTurn finalizes)

const MIN = 60_000;

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-pr2clease-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  ensureRuntimeDirs(dir);
  return dir;
}

function resInput(cwd: string, turn_id: string, leaseMsFromNow = MIN): ReserveInput {
  return {
    turn_id, loop_id: 'lop_abc', slot_id: 'lsl_r', target_slot_generation: 1,
    loop_version_at_reserve: 1, agent: 'codex', claim_id: 'clm_x', phase: 'findings',
    iteration: 0, store_root: cwd, cwd,
    lease_deadline: new Date(Date.now() + leaseMsFromNow).toISOString(),
  };
}

/** Reserve + commit a turn and mint the owned agent_run at `status`. Does NOT arm. */
function reservedRun(cwd: string, turnId: string, status: 'created' | 'launching', leaseMsFromNow = MIN) {
  reserve(resInput(cwd, turnId, leaseMsFromNow), cwd);
  commitReservation(turnId, cwd);
  const { run_id, assignment_id } = deriveChildIds(turnId);
  const run = createAgentRun({
    id: run_id, short_label: `run#${turnId}`, assignment_id, claim_id: 'clm_x',
    agent: 'codex', transport: 'manual_command', scope: 'src/x.ts',
    description: 'turn-owned pre-run', status,
  }, cwd);
  return { runId: run_id, assignmentId: assignment_id, run };
}

describe('PR2c-lease — turn-owned pre-run lease expiry (pln#630 §4 + R5)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('within lease → NO-OP (the worker may yet cross the fence / start)', () => {
    const { runId } = reservedRun(cwd, 'tat_within', 'created');
    const r = reconcileAgentRun(runId, cwd, { nowMs: Date.now() }); // well before the +60s lease
    assert.equal(r.action, 'no_op');
    assert.equal(loadAgentRun(runId, cwd)?.status, 'created');
  });

  it('past lease, committed-UNARMED → cancelled / reserved_never_launched', () => {
    const { runId } = reservedRun(cwd, 'tat_neverlaunched', 'created');
    const r = reconcileAgentRun(runId, cwd, { nowMs: Date.now() + 2 * MIN });
    assert.equal(r.action, 'inferred_cancelled');
    assert.match(r.reason, /reserved_never_launched/);
    assert.equal(r.current_status, 'cancelled');
    assert.equal(loadAgentRun(runId, cwd)?.status, 'cancelled');
  });

  it('past lease, ARMED-but-not-crossed → cancelled / reserved_never_launched', () => {
    const { runId } = reservedRun(cwd, 'tat_armed', 'launching');
    // Arm in the real-time-valid window (dispatch lease still future), then simulate
    // the future via nowMs. The launch lease becomes the effective deadline.
    armLaunch('tat_armed', { token: 'gen-1', epoch: 1, lease_deadline: new Date(Date.now() + MIN).toISOString() }, cwd);
    const r = reconcileAgentRun(runId, cwd, { nowMs: Date.now() + 2 * MIN });
    assert.equal(r.action, 'inferred_cancelled');
    assert.match(r.reason, /reserved_never_launched/);
    assert.equal(r.current_status, 'cancelled');
  });

  it('past lease, launch grant CROSSED → failed / launch_attempted_unknown (never completed)', () => {
    const { runId } = reservedRun(cwd, 'tat_crossed', 'launching');
    armLaunch('tat_crossed', { token: 'gen-1', epoch: 1, lease_deadline: new Date(Date.now() + MIN).toISOString() }, cwd);
    const consumed = consumeLaunchGrant('tat_crossed', 'gen-1', 1, cwd);
    assert.equal(consumed.wonTransition, true, 'this invocation crossed the fence');
    const r = reconcileAgentRun(runId, cwd, { nowMs: Date.now() + 2 * MIN });
    assert.equal(r.action, 'inferred_failed');
    assert.match(r.reason, /launch_attempted_unknown/);
    assert.equal(r.current_status, 'failed');
    assert.notEqual(r.current_status, 'completed', 'a crossed-never-ran run must NEVER complete');
  });

  it('past lease, CROSSED from a `created` run (torn crossed-before-launching) → failed', () => {
    // The matrix now permits created→failed for exactly this torn state.
    const { runId } = reservedRun(cwd, 'tat_torn', 'created');
    armLaunch('tat_torn', { token: 'gen-1', epoch: 1, lease_deadline: new Date(Date.now() + MIN).toISOString() }, cwd);
    consumeLaunchGrant('tat_torn', 'gen-1', 1, cwd);
    const r = reconcileAgentRun(runId, cwd, { nowMs: Date.now() + 2 * MIN });
    assert.equal(r.current_status, 'failed');
    assert.match(r.reason, /launch_attempted_unknown/);
  });

  it('turn-keyed completion present → NO-OP (finalization deferred to reconcileTurn)', () => {
    const { runId, assignmentId } = reservedRun(cwd, 'tat_done', 'launching');
    armLaunch('tat_done', { token: 'gen-1', epoch: 1, lease_deadline: new Date(Date.now() + MIN).toISOString() }, cwd);
    consumeLaunchGrant('tat_done', 'gen-1', 1, cwd); // nonce = gen-1
    writeCompletionSignal(cwd, assignmentId, { turn_id: 'tat_done', run_id: runId, nonce: 'gen-1', status: 'completed', at: new Date().toISOString() });
    const r = reconcileAgentRun(runId, cwd, { nowMs: Date.now() + 2 * MIN });
    assert.equal(r.action, 'no_op');
    assert.match(r.reason, /defer finalization to reconcileTurn/);
    // The run is NOT expired to failed/cancelled just because it hasn't reached running.
    assert.notEqual(loadAgentRun(runId, cwd)?.status, 'failed');
    assert.notEqual(loadAgentRun(runId, cwd)?.status, 'cancelled');
  });

  it('matrix: created → failed is now a permitted transition', () => {
    const run = createAgentRun({ assignment_id: 'asgn_m', claim_id: 'clm_x', agent: 'codex', transport: 'manual_command', scope: 'src/x.ts', description: 'm', status: 'created' }, cwd);
    assert.doesNotThrow(() => transitionAgentRun(run.id, 'failed', { actor: 'test', status_reason: 'launch_attempted_unknown' }, cwd));
    assert.equal(loadAgentRun(run.id, cwd)?.status, 'failed');
  });

  it('sweepTurnOwnedPreRunLeaseAtRead converges turn-owned pre-run runs, SKIPS legacy', () => {
    const a = reservedRun(cwd, 'tat_sweep1', 'created');       // turn-owned, past lease
    const b = reservedRun(cwd, 'tat_sweep2', 'launching');      // turn-owned, past lease
    // Legacy created run (no owning reservation) must be untouched by this sweep.
    const legacy = createAgentRun({ assignment_id: 'asgn_legacy', claim_id: 'clm_x', agent: 'codex', transport: 'manual_command', scope: 'src/y.ts', description: 'legacy', status: 'created' }, cwd);

    const results = sweepTurnOwnedPreRunLeaseAtRead(cwd, { nowMs: Date.now() + 2 * MIN });
    const swept = new Set(results.map((r) => r.run_id));
    assert.ok(swept.has(a.runId) && swept.has(b.runId), 'both turn-owned runs are swept');
    assert.ok(!swept.has(legacy.id), 'legacy run is not touched by the turn-owned sweep');
    assert.equal(loadAgentRun(a.runId, cwd)?.status, 'cancelled');
    assert.equal(loadAgentRun(b.runId, cwd)?.status, 'cancelled');
    assert.equal(loadAgentRun(legacy.id, cwd)?.status, 'created', 'legacy stays created');
  });

  it('doctor reports reserved_never_launched under inferred_cancelled (not a health failure — exit 0)', () => {
    // Past lease at reserve time (real clock) so doctor — which has no nowMs — sees expiry.
    reservedRun(cwd, 'tat_doctor', 'created', -1000);
    const report = runDispatchHealthCheck({ cwd });
    assert.equal(report.inferred_cancelled.length, 1, 'the never-launched run lands in inferred_cancelled');
    assert.match(report.inferred_cancelled[0]!.reason, /reserved_never_launched/);
    assert.equal(report.inferred_failed.length, 0, 'reserved_never_launched is NOT a failure');
    assert.equal(report.exit_code, 0, 'a clean non-launch must not fail the doctor');
  });
});
