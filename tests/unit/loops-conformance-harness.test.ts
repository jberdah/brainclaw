import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { prepareTurnOwnedReviewDispatch } from '../../src/core/review-loop-turn-dispatch.js';
import { reconcileTurn } from '../../src/core/loops/reconcile-turn.js';
import { deriveChildIds, getReservation, launchGrant } from '../../src/core/loops/attempt-reservation.js';
import { loadAgentRun } from '../../src/core/agentruns.js';
import { ensureRuntimeDirs, writeCompletionSignal } from '../../src/core/runtime-signals.js';
import type { LaneResult } from '../../src/core/schema.js';

// pln#630 §9 — CONFORMANCE HARNESS. The contract's end-to-end regression proof,
// driving the REAL primitives (prepareTurnOwnedReviewDispatch → fake-worker
// evidence → reconcileTurn → convergence) with a FAKE executor (no real spawn):
// reserve→commit→arm→consume, then the "worker" writes the turn-keyed sentinel +
// LANE-RESULT, then reconcile converges. Plus the Codex-mandated adversarial cases.

const FUTURE = () => new Date(Date.now() + 600_000).toISOString();

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-conf-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  ensureRuntimeDirs(dir);
  return dir;
}

function openReviewLoop(cwd: string, slotId = 'lsl_r') {
  return openLoop({
    kind: 'review', title: 'conformance', created_by: 'coord', mode: 'symmetric',
    phases: [{ name: 'findings' }],
    stop_condition: { kind: 'reviewer_green' },
    slots: [{ slot_id: slotId, role: 'reviewer', agent: 'codex' }],
  }, cwd);
}

function prep(cwd: string, loopId: string, slotId = 'lsl_r') {
  const r = prepareTurnOwnedReviewDispatch({
    loopId, slotId, agent: 'codex', phase: 'findings', task: 'review',
    description: 'conformance review turn', scope: `review-loop:${loopId}`,
    claimId: 'clm_conf', worktreePath: path.join(cwd, 'wt'),
    dispatcherAgent: 'coord', isReviewer: true, cwd,
  });
  assert.equal(r.kind, 'won', 'reserve→commit→arm→consume must win');
  if (r.kind !== 'won') throw new Error('unreachable');
  return r;
}

/** The FAKE worker: writes the turn-keyed completion sentinel + returns the LANE-RESULT. */
function fakeWorkerCompletes(cwd: string, w: { turnId: string; runId: string; assignmentId: string; nonce: string }, verdict: 'approve' | 'request_changes'): LaneResult {
  writeCompletionSignal(cwd, w.assignmentId, { turn_id: w.turnId, run_id: w.runId, nonce: w.nonce, status: 'completed', at: new Date().toISOString() });
  return { assignment_id: w.assignmentId, turn_id: w.turnId, run_id: w.runId, nonce: w.nonce, status: 'completed', summary: 'fake review', review_verdict: verdict, review_summary: 'looks good' };
}

describe('pln#630 §9 conformance harness — full turn-owned contract (fake executor)', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('POSITIVE: reserve→dispatch(fake)→reconcile → artifact + complete_turn + run completed + reviewer_green auto-close; GET mutates nothing', () => {
    const loop = openReviewLoop(cwd);
    const w = prep(cwd, loop.id);

    // The reservation is committed + the launch grant crossed (spawn authority won).
    assert.equal(getReservation(w.turnId, cwd)?.decision, 'committed');
    assert.equal(launchGrant(w.turnId, cwd)?.status, 'crossed');
    assert.equal(w.nonce, launchGrant(w.turnId, cwd)?.token, 'turnEcho nonce == authoritative launch token');

    const lane = fakeWorkerCompletes(cwd, w, 'approve');

    // GET stays observational: merely reading the loop after the worker wrote its
    // evidence converges NOTHING — the loop is still open, slot still assigned.
    const beforeReconcile = getLoop(loop.id, cwd)!;
    assert.equal(beforeReconcile.status, 'open', 'a read never converges (GET observational)');
    assert.ok(!beforeReconcile.artifacts.some((a) => a.type === 'verdict'), 'no verdict recorded by a read');

    // reconcile — the ONE mutating convergence action.
    const r = reconcileTurn({ turn_id: w.turnId, lane, cwd });
    assert.equal(r.reconciled, true);
    assert.equal(r.auto_closed, true);

    const after = getLoop(loop.id, cwd)!;
    assert.ok(['closed', 'completed'].includes(after.status), `loop auto-closed (${after.status})`);
    assert.ok(after.artifacts.some((a) => a.type === 'verdict' && /^accepted/.test((a.body ?? '').toLowerCase())), 'accepted verdict recorded');
    assert.equal(loadAgentRun(w.runId, cwd)?.status, 'completed', 'run settled to completed');
  });

  it('POSITIVE request_changes: verdict recorded, loop stays OPEN for the fix cycle', () => {
    const loop = openReviewLoop(cwd);
    const w = prep(cwd, loop.id);
    const lane = fakeWorkerCompletes(cwd, w, 'request_changes');
    const r = reconcileTurn({ turn_id: w.turnId, lane, cwd });
    assert.equal(r.reconciled, true);
    assert.notEqual(r.auto_closed, true);
    assert.ok(!['closed', 'completed', 'cancelled'].includes(getLoop(loop.id, cwd)!.status));
  });

  it('ADVERSARIAL (i) stale prior-attempt sentinel: attempt A evidence must NOT converge attempt B', () => {
    // Two DISTINCT turns → distinct deterministic run_ids/assignment_ids. A's
    // completed sentinel must never satisfy B's reconcile (read-strict keys differ).
    const loop = openReviewLoop(cwd);
    const b = prep(cwd, loop.id);
    // Forge A's identity (a different, non-owned turn) and its sentinel + lane.
    const aTurn = 'tat_stale_A';
    const aChild = deriveChildIds(aTurn);
    writeCompletionSignal(cwd, aChild.assignment_id, { turn_id: aTurn, run_id: aChild.run_id, nonce: 'A-nonce', status: 'completed', at: 'a' });
    const aLane: LaneResult = { assignment_id: b.assignmentId, turn_id: aTurn, run_id: aChild.run_id, nonce: 'A-nonce', status: 'completed', summary: 'A', review_verdict: 'approve' };
    // Reconciling B with A's lane keys → rejected (evidence not turn-keyed to B).
    const r = reconcileTurn({ turn_id: b.turnId, lane: aLane, cwd });
    assert.equal(r.reconciled, false, "A's evidence must not converge B");
    assert.equal(getLoop(loop.id, cwd)!.status, 'open');
  });

  it('ADVERSARIAL (ii) wrong-nonce (superseded generation): read-strict rejects', () => {
    const loop = openReviewLoop(cwd);
    const w = prep(cwd, loop.id);
    const lane = { ...fakeWorkerCompletes(cwd, w, 'approve'), nonce: 'SUPERSEDED' };
    const r = reconcileTurn({ turn_id: w.turnId, lane, cwd });
    assert.equal(r.reconciled, false);
    assert.equal(getLoop(loop.id, cwd)!.status, 'open');
  });

  it('ADVERSARIAL (iii) completed lane + turn-keyed FAILED sentinel: conflict withheld, no auto-close', () => {
    const loop = openReviewLoop(cwd);
    const w = prep(cwd, loop.id);
    const lane = fakeWorkerCompletes(cwd, w, 'approve');
    // Wrapper ALSO wrote a turn-keyed failed sentinel (non-zero exit after result).
    writeCompletionSignal(cwd, w.assignmentId, { turn_id: w.turnId, run_id: w.runId, nonce: w.nonce, status: 'failed', at: 'f' });
    const r = reconcileTurn({ turn_id: w.turnId, lane, cwd });
    assert.equal(r.reconciled, false);
    assert.equal(r.conflict, true);
    assert.equal(getLoop(loop.id, cwd)!.status, 'open');
  });

  it('ADVERSARIAL (iv) duplicate dispatch: a second prepare of the same slot+iteration is DENIED (no double-spawn)', () => {
    const loop = openReviewLoop(cwd);
    prep(cwd, loop.id); // first wins
    const second = prepareTurnOwnedReviewDispatch({
      loopId: loop.id, slotId: 'lsl_r', agent: 'codex', phase: 'findings', task: 'review',
      description: 'dup', scope: `review-loop:${loop.id}`, claimId: 'clm_conf2',
      dispatcherAgent: 'coord', isReviewer: true, cwd,
    });
    assert.equal(second.kind, 'denied', 'the exactly-once fence denies the duplicate');
  });

  it('ADVERSARIAL (v) reconcile is idempotent across repeated triggers (wrapper-signal + harvest + session-end)', () => {
    const loop = openReviewLoop(cwd);
    const w = prep(cwd, loop.id);
    const lane = fakeWorkerCompletes(cwd, w, 'approve');
    const first = reconcileTurn({ turn_id: w.turnId, lane, cwd });
    assert.equal(first.auto_closed, true);
    // Simulate three more triggers firing the same reconcile.
    for (let i = 0; i < 3; i++) {
      const again = reconcileTurn({ turn_id: w.turnId, lane, cwd });
      assert.equal(again.reconciled, true);
      assert.equal(again.artifacts_added, 0, 'no duplicate artifacts on repeated triggers');
    }
    assert.equal(getLoop(loop.id, cwd)!.artifacts.filter((a) => a.type === 'verdict').length, 1);
  });
});
