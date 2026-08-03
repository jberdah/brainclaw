import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { complete_turn, turn } from '../../src/core/loops/verbs.js';
import { reconcileTurn, reconcileFailedTurn } from '../../src/core/loops/reconcile-turn.js';
import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, deriveChildIds, getReservation,
} from '../../src/core/loops/attempt-reservation.js';
import { createAgentRun, loadAgentRun } from '../../src/core/agentruns.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { listRuntimeEvents } from '../../src/core/events.js';
import { ensureRuntimeDirs, writeCompletionSignal } from '../../src/core/runtime-signals.js';
import type { LaneResult } from '../../src/core/schema.js';

// pln#630 §8 — reconcileTurn: the ONE mutating convergence action. Read-strict
// evidence, reducer-driven artifacts, deterministic-stop close, R4 conflict,
// idempotent.

const FUTURE = () => new Date(Date.now() + 600_000).toISOString();
const TOKEN = 'gen-1';

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-reconcile-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  ensureRuntimeDirs(dir);
  return dir;
}

function setup(cwd: string, verdict?: 'approve' | 'request_changes') {
  const loop = openLoop({
    kind: 'review', title: 't', created_by: 'coord', mode: 'symmetric',
    phases: [{ name: 'findings' }],
    stop_condition: { kind: 'reviewer_green' },
    slots: [{ slot_id: 'lsl_r', role: 'reviewer', agent: 'codex', status: 'assigned' }],
  }, cwd);
  const turnId = 'tat_recon';
  reserve({
    turn_id: turnId, loop_id: loop.id, slot_id: 'lsl_r', target_slot_generation: 0,
    loop_version_at_reserve: loop.version, agent: 'codex', claim_id: 'clm_x',
    phase: 'findings', iteration: 0, store_root: cwd, cwd, lease_deadline: FUTURE(),
  }, cwd);
  commitReservation(turnId, cwd);
  armLaunch(turnId, { token: TOKEN, epoch: 1, lease_deadline: FUTURE() }, cwd);
  consumeLaunchGrant(turnId, TOKEN, 1, cwd);
  const { run_id, assignment_id } = deriveChildIds(turnId);
  createAgentRun({
    id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_x', agent: 'codex',
    transport: 'cli_spawn', scope: 'review-loop', description: 'turn', status: 'running',
  }, cwd);
  const lane: LaneResult = {
    assignment_id, turn_id: turnId, run_id, nonce: TOKEN, status: 'completed',
    summary: 'reviewed', ...(verdict ? { review_verdict: verdict, review_summary: 'rationale' } : {}),
  };
  return { loopId: loop.id, turnId, runId: run_id, assignmentId: assignment_id, lane };
}

describe('reconcileTurn §8', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('approve → records an accepted verdict, completes the run, auto-closes the loop (reviewer_green)', () => {
    const { turnId, runId, assignmentId, loopId, lane } = setup(cwd, 'approve');
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, true);
    assert.equal(r.slot_outcome, 'done');
    assert.equal(r.auto_closed, true, 'reviewer_green closes the loop');
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), `loop is terminal (${loop.status})`);
    assert.ok(loop.artifacts.some((a) => a.type === 'verdict' && /^accepted/.test((a.body ?? '').toLowerCase())));
    assert.equal(loadAgentRun(runId, cwd)?.status, 'completed', 'turn-owned run settled to completed');
    // pln#521 P4 — a loop_artifact_harvested observability event was emitted for the harvest.
    const harvested = listRuntimeEvents(cwd).filter((e) => e.event_type === 'loop_artifact_harvested');
    assert.equal(harvested.length, 1, 'exactly one loop_artifact_harvested event');
    assert.equal(harvested[0]!.run_id, runId, 'event carries the turn-owned run_id');
    assert.equal(harvested[0]!.assignment_id, assignmentId, 'event carries the assignment_id');
  });

  it('request_changes → records a changes-requested verdict, loop stays OPEN (fix cycle continues)', () => {
    const { turnId, loopId, lane } = setup(cwd, 'request_changes');
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, true);
    assert.equal(r.slot_outcome, 'done');
    assert.notEqual(r.auto_closed, true);
    const loop = getLoop(loopId, cwd)!;
    assert.ok(!['closed', 'completed', 'cancelled'].includes(loop.status), `loop stays open (${loop.status})`);
    assert.ok(loop.artifacts.some((a) => a.type === 'verdict' && (a.body ?? '').startsWith('changes-requested')));
  });

  it('REJECTS a stale/mismatched-nonce lane (read-strict) — no artifact, loop untouched', () => {
    const { turnId, loopId, lane } = setup(cwd, 'approve');
    const stale = { ...lane, nonce: 'WRONG-GEN' };
    const r = reconcileTurn({ turn_id: turnId, lane: stale, cwd });
    assert.equal(r.reconciled, false);
    assert.match(r.reason, /does not match|no live launch/);
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.status, 'open');
    assert.ok(!loop.artifacts.some((a) => a.type === 'verdict'), 'no verdict recorded from stale evidence');
  });

  it('completed+failed CONTRADICTION → conflict, convergence withheld (§13 R4)', () => {
    const { turnId, runId, assignmentId, loopId, lane } = setup(cwd, 'approve');
    writeCompletionSignal(cwd, assignmentId, { turn_id: turnId, run_id: runId, nonce: TOKEN, status: 'completed', at: 'c' });
    writeCompletionSignal(cwd, assignmentId, { turn_id: turnId, run_id: runId, nonce: TOKEN, status: 'failed', at: 'f' });
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, false);
    assert.equal(r.conflict, true);
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.status, 'open', 'auto-stop withheld on contradiction');
  });

  it('is idempotent: a second reconcile after close is a no-op', () => {
    const { turnId, lane } = setup(cwd, 'approve');
    const first = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(first.auto_closed, true);
    const second = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(second.reconciled, true);
    assert.match(second.reason, /already|idempotent/i);
  });

  it('unknown turn_id → reconciled:false', () => {
    const r = reconcileTurn({ turn_id: 'tat_nope', lane: { assignment_id: 'a', status: 'completed', summary: 's' } as LaneResult, cwd });
    assert.equal(r.reconciled, false);
    assert.match(r.reason, /unknown turn/);
  });

  // ── review-round fixes ──

  it('crash-before-advance recovery: a terminal slot + open loop → reconcile re-attempts advance and CLOSES (Finding 1)', () => {
    const { turnId, loopId, lane } = setup(cwd, 'approve');
    // Simulate reconcile #1 crashing AFTER complete_turn (verdict recorded, slot
    // done) but BEFORE advance: record the accepted verdict directly, leaving the
    // loop OPEN.
    complete_turn({ id: loopId, slot_id: 'lsl_r', actor: 'x', outcome: 'done', artifact: { phase: 'findings', type: 'verdict', body: 'accepted: recorded pre-crash' } }, cwd);
    assert.equal(getLoop(loopId, cwd)!.status, 'open', 'loop still open (advance never ran)');
    // reconcile #2 must NOT double-record and MUST close the loop.
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, true);
    assert.equal(r.artifacts_added, 0, 'no re-record on a terminal slot');
    assert.equal(r.auto_closed, true);
    assert.ok(['closed', 'completed'].includes(getLoop(loopId, cwd)!.status));
    // Exactly ONE verdict artifact (no duplicate).
    assert.equal(getLoop(loopId, cwd)!.artifacts.filter((a) => a.type === 'verdict').length, 1);
  });

  it('request_changes reconciled twice → NO duplicate verdict artifact (Finding 2)', () => {
    const { turnId, loopId, lane } = setup(cwd, 'request_changes');
    reconcileTurn({ turn_id: turnId, lane, cwd });
    const r2 = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r2.reconciled, true);
    assert.equal(r2.artifacts_added, 0, 'second reconcile records nothing');
    const verdicts = getLoop(loopId, cwd)!.artifacts.filter((a) => a.type === 'verdict');
    assert.equal(verdicts.length, 1, 'exactly one changes-requested verdict despite two reconciles');
  });

  it('oversized review_summary → body truncated, no throw, still closes (Finding 3)', () => {
    const { turnId, loopId, lane } = setup(cwd, 'approve');
    const hugeLane = { ...lane, review_summary: 'x'.repeat(9000) };
    const r = reconcileTurn({ turn_id: turnId, lane: hugeLane, cwd });
    assert.equal(r.reconciled, true, 'a huge summary must not throw out of reconcileTurn');
    const verdict = getLoop(loopId, cwd)!.artifacts.find((a) => a.type === 'verdict')!;
    assert.ok(Buffer.byteLength(verdict.body ?? '', 'utf8') <= 4096, 'verdict body capped to the schema limit');
    assert.ok((verdict.body ?? '').startsWith('accepted'), 'truncation preserves the accepted prefix → still fires reviewer_green');
    assert.equal(r.auto_closed, true);
  });

  it('SUPERSEDED turn → no-op (a newer turn took over the slot; never re-terminalize on a stale outcome)', () => {
    const { turnId, loopId, lane } = setup(cwd, 'approve');
    // A newer turn rebinds the slot pointer (as prepare's turn() would for the next iteration).
    turn({ id: loopId, slot_id: 'lsl_r', actor: 'coord', turn_id: 'tat_newer' }, cwd);
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, false);
    assert.match(r.reason, /superseded/);
    // The superseded turn recorded no verdict and did not close the loop.
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.status, 'open');
    assert.ok(!loop.artifacts.some((a) => a.type === 'verdict'));
  });

  it('lane completed + turn-keyed FAILED sentinel → conflict withheld (Finding 5)', () => {
    const { turnId, runId, assignmentId, loopId, lane } = setup(cwd, 'approve');
    // Only a failed sentinel (no completed sentinel), but the lane says completed.
    writeCompletionSignal(cwd, assignmentId, { turn_id: turnId, run_id: runId, nonce: TOKEN, status: 'failed', at: 'f' });
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, false);
    assert.equal(r.conflict, true);
    assert.equal(getLoop(loopId, cwd)!.status, 'open');
  });
});

// ── pln#641 (dec#151 option b) — reconcileFailedTurn ────────────────────────
// A worker that died at the TRANSPORT level produces no lane result, ever. Its
// claim release must still be a BUSINESS decision recorded on the loop — never
// a side-effect of the transport verdict (pln#638 6c effects boundary).

describe('reconcileFailedTurn — business convergence of a transport failure (pln#641)', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  function failedSetup() {
    const s = setup(cwd);
    saveClaim({
      schema_version: 2, id: 'clm_x', agent: 'codex', scope: 'review-loop',
      description: 'lane claim', created_at: new Date().toISOString(), status: 'active',
    }, cwd);
    const run = loadAgentRun(s.runId, cwd)!;
    const reservation = getReservation(s.turnId, cwd)!;
    return { ...s, run, reservation };
  }

  it('records the failure ON the loop first, then releases the claim, with a business audit trail', () => {
    const { loopId, run, reservation } = failedSetup();
    const r = reconcileFailedTurn({ reservation, run, reason: 'stalled: heartbeat lost', cwd });
    assert.equal(r.converged, true);
    assert.equal(r.claim_released, true);
    assert.equal(loadClaim('clm_x', cwd).status, 'released', 'non-famine: the scope is re-claimable for a retry lane');
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.slots.find((sl) => sl.slot_id === 'lsl_r')!.status, 'failed',
      'the failure is a recorded loop fact, not a transport side-effect');
    assert.equal(loop.status, 'open', 'a failed lane leaves the loop open for a retry dispatch');
    const business = listRuntimeEvents(cwd).filter((e) => e.status_reason === 'turn_failure_business_release');
    assert.equal(business.length, 1, 'the release is audited as a BUSINESS decision');
    assert.equal(business[0]!.claim_id, 'clm_x');
  });

  it('SUPERSEDED → converged WITHOUT release: the claim belongs to the live turn (claim reuse, trp_e824d2af)', () => {
    const { loopId, run, reservation } = failedSetup();
    turn({ id: loopId, slot_id: 'lsl_r', actor: 'coord', turn_id: 'tat_newer' }, cwd);
    const r = reconcileFailedTurn({ reservation, run, reason: 'silent_termination_no_evidence', cwd });
    assert.equal(r.converged, true);
    assert.match(r.reason, /superseded/);
    assert.equal(r.claim_released, false);
    assert.equal(loadClaim('clm_x', cwd).status, 'active', 'the live turn keeps its (reused) claim');
  });

  it('is idempotent: a second pass records nothing and emits no second audit event', () => {
    const { run, reservation } = failedSetup();
    reconcileFailedTurn({ reservation, run, reason: 'first pass', cwd });
    const r2 = reconcileFailedTurn({ reservation, run, reason: 'second pass', cwd });
    assert.equal(r2.converged, true);
    assert.equal(r2.claim_released, false, 'claim already released — nothing to redo');
    assert.equal(
      listRuntimeEvents(cwd).filter((e) => e.status_reason === 'turn_failure_business_release').length, 1,
      'exactly one business release event across both passes',
    );
  });

  it('containment: refuses to converge a reservation from ANOTHER store — claim retained', () => {
    const { run, reservation } = failedSetup();
    const foreign = { ...reservation, store_root: path.join(cwd, 'elsewhere') };
    const r = reconcileFailedTurn({ reservation: foreign, run, reason: 'x', cwd });
    assert.equal(r.converged, false);
    assert.match(r.reason, /containment/);
    assert.equal(loadClaim('clm_x', cwd).status, 'active', 'never a forced release across store boundaries');
  });
});
