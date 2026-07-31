import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, deriveChildIds,
  findReservationByRunId, type ReserveInput,
} from '../../src/core/loops/attempt-reservation.js';
import { createAgentRun } from '../../src/core/agentruns.js';
import { collectEvidence, reconcileAgentRun } from '../../src/core/agentrun-reconciler.js';
import {
  ensureRuntimeDirs, writeCompletionSignal, getRuntimeSignalPath, type CompletionSignalBody,
} from '../../src/core/runtime-signals.js';

// pln#630 PR2b-c (§13 R3) — a TURN-OWNED run is completed ONLY on turn-keyed
// evidence; a bare presence-only / stale sentinel never phantom-completes it.
// Legacy (non-turn-owned) runs keep presence-based acceptance.

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-readstrict-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  ensureRuntimeDirs(dir);
  return dir;
}

function resInput(cwd: string, turn_id: string): ReserveInput {
  return {
    turn_id, loop_id: 'lop_abc', slot_id: 'lsl_r', target_slot_generation: 1,
    loop_version_at_reserve: 1, agent: 'codex', claim_id: 'clm_x', phase: 'findings',
    iteration: 0, store_root: cwd, cwd, lease_deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

/** Reserve→commit→arm→consume a turn (→ crossed, nonce = token) and create the
 *  owned agent_run (id = derived run_id) in `running`. Returns the correlation. */
function turnOwnedRun(cwd: string, turnId: string): { runId: string; assignmentId: string; token: string; run: ReturnType<typeof createAgentRun> } {
  reserve(resInput(cwd, turnId), cwd);
  commitReservation(turnId, cwd);
  const token = `gen-${turnId}`;
  armLaunch(turnId, { token, epoch: 1, lease_deadline: new Date(Date.now() + 60_000).toISOString() }, cwd);
  consumeLaunchGrant(turnId, token, 1, cwd);
  const { run_id, assignment_id } = deriveChildIds(turnId);
  const run = createAgentRun({ id: run_id, short_label: `run#${turnId}`, assignment_id, claim_id: 'clm_x', agent: 'codex', transport: 'manual_command', scope: 'src/x.ts', description: 'turn-owned run', status: 'running' }, cwd);
  return { runId: run_id, assignmentId: assignment_id, token, run };
}

describe('read-strict acceptance (pln#630 PR2b-c §13 R3)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('findReservationByRunId links a run to its owning attempt', () => {
    reserve(resInput(cwd, 'tat_link'), cwd);
    const { run_id } = deriveChildIds('tat_link');
    assert.equal(findReservationByRunId(run_id, cwd)?.turn_id, 'tat_link');
    assert.equal(findReservationByRunId('run_nonexistent', cwd), undefined);
  });

  it('turn-owned run: a MATCHING turn-keyed completed sentinel is accepted', () => {
    const { runId, assignmentId, token, run } = turnOwnedRun(cwd, 'tat_match');
    const body: CompletionSignalBody = { turn_id: 'tat_match', run_id: runId, nonce: token, status: 'completed', at: new Date().toISOString() };
    writeCompletionSignal(cwd, assignmentId, body);
    const ev = collectEvidence(run, cwd);
    assert.equal(ev.turn_owned, true);
    assert.equal(ev.turn_keyed_completed, true);
    const result = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0 });
    assert.equal(result.current_status, 'completed', 'matching turn-keyed evidence completes the run');
  });

  it('turn-owned run: a BARE presence-only sentinel is NOT accepted (no phantom-completion)', () => {
    const { runId, assignmentId, run } = turnOwnedRun(cwd, 'tat_bare');
    // Legacy presence-only marker: empty file at the assignment-keyed path.
    const p = getRuntimeSignalPath(cwd, assignmentId, 'completed');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf-8');
    const ev = collectEvidence(run, cwd);
    assert.equal(ev.turn_owned, true);
    assert.equal(ev.completed_signal, true, 'the bare sentinel exists by presence');
    assert.equal(ev.turn_keyed_completed, false, 'but is NOT turn-keyed evidence');
    const result = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0 });
    assert.notEqual(result.current_status, 'completed', 'presence alone must not complete a turn-owned run');
  });

  it('turn-owned run: a STALE wrong-nonce sentinel is NOT accepted', () => {
    const { runId, assignmentId, run } = turnOwnedRun(cwd, 'tat_stale2');
    writeCompletionSignal(cwd, assignmentId, { turn_id: 'tat_stale2', run_id: runId, nonce: 'WRONG-GEN', status: 'completed', at: new Date().toISOString() });
    const ev = collectEvidence(run, cwd);
    assert.equal(ev.turn_keyed_completed, false);
    const result = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0 });
    assert.notEqual(result.current_status, 'completed');
  });

  it('turn-owned run: a completed+failed CONTRADICTION withholds both (§13 R4)', () => {
    const { runId, assignmentId, token, run } = turnOwnedRun(cwd, 'tat_conflict');
    writeCompletionSignal(cwd, assignmentId, { turn_id: 'tat_conflict', run_id: runId, nonce: token, status: 'completed', at: 'c' });
    writeCompletionSignal(cwd, assignmentId, { turn_id: 'tat_conflict', run_id: runId, nonce: token, status: 'failed', at: 'f' });
    const ev = collectEvidence(run, cwd);
    assert.equal(ev.turn_keyed_completed, false, 'contradiction must not accept completed');
    assert.equal(ev.failed_signal, false, 'contradiction must not accept failed');
    const result = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0 });
    assert.notEqual(result.current_status, 'completed');
    assert.notEqual(result.current_status, 'failed');
  });

  it('turn-owned run: a .completed FILE carrying a status:failed BODY is NOT accepted (trust body, not filename — #C2)', () => {
    const { runId, assignmentId, token, run } = turnOwnedRun(cwd, 'tat_wrongstatus');
    // Write directly to the completed-named path but with a failed-status body.
    const p = getRuntimeSignalPath(cwd, assignmentId, 'completed');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ turn_id: 'tat_wrongstatus', run_id: runId, nonce: token, status: 'failed', at: 'x' }), 'utf-8');
    const ev = collectEvidence(run, cwd);
    assert.equal(ev.turn_keyed_completed, false);
    assert.notEqual(reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0 }).current_status, 'completed');
  });

  it('turn-owned run: FAILURE is read-strict too — matching turn-keyed failed accepted, bare presence rejected (#B)', () => {
    // Matching turn-keyed failed body → failed_signal true.
    const a = turnOwnedRun(cwd, 'tat_failmatch');
    writeCompletionSignal(cwd, a.assignmentId, { turn_id: 'tat_failmatch', run_id: a.runId, nonce: a.token, status: 'failed', at: 'f' });
    assert.equal(collectEvidence(a.run, cwd).failed_signal, true);

    // Bare presence-only .failed marker on a healthy turn-owned run → NOT failed.
    const b = turnOwnedRun(cwd, 'tat_failbare');
    const p = getRuntimeSignalPath(cwd, b.assignmentId, 'failed');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf-8');
    const ev = collectEvidence(b.run, cwd);
    assert.equal(ev.failed_signal, false, 'a stale bare .failed marker must not phantom-fail a turn-owned run');
  });

  it('LEGACY run (no owning reservation): presence sentinel still completes it (unchanged)', () => {
    const run = createAgentRun({ assignment_id: 'asgn_legacy', claim_id: 'clm_x', agent: 'codex', transport: 'manual_command', scope: 'src/x.ts', description: 'legacy run', status: 'running' }, cwd);
    const p = getRuntimeSignalPath(cwd, 'asgn_legacy', 'completed');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf-8');
    const ev = collectEvidence(run, cwd);
    assert.equal(ev.turn_owned, false);
    const result = reconcileAgentRun(run.id, cwd, { healthCheckGraceMs: 0 });
    assert.equal(result.current_status, 'completed', 'legacy presence-based acceptance preserved');
  });
});
