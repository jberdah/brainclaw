import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { LOOP_KINDS, type LoopKind } from '../../src/core/loops/types.js';
import { prepareTurnOwnedReviewDispatch } from '../../src/core/review-loop-turn-dispatch.js';
import { reconcileTurn } from '../../src/core/loops/reconcile-turn.js';
import {
  deriveChildIds, getReservation, launchGrant,
  reserve, commitReservation, abortReservation,
  armLaunch, consumeLaunchGrant, revokeLaunchGrant,
  evidenceMatchesAttempt, deriveTurnId,
} from '../../src/core/loops/attempt-reservation.js';
import { loadAgentRun, createAgentRun } from '../../src/core/agentruns.js';
import { ensureRuntimeDirs, getRuntimeSignalPath, writeCompletionSignal } from '../../src/core/runtime-signals.js';
import { integrateLaneResults, getLaneResultPath } from '../../src/commands/harvest.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { saveAssignment } from '../../src/core/assignments.js';
import { nowISO } from '../../src/core/ids.js';
import type { Assignment, Claim, LaneResult } from '../../src/core/schema.js';

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
  try {
    loadClaim('clm_conf', cwd);
  } catch {
    saveClaim({
      schema_version: 2,
      id: 'clm_conf',
      agent: 'codex',
      scope: `review-loop:${loopId}`,
      description: 'conformance review turn',
      created_at: nowISO(),
      status: 'active',
    }, cwd);
  }
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
function fakeWorkerCompletes(cwd: string, w: {
  turnId: string;
  runId: string;
  assignmentId: string;
  nonce: string;
  executionContractRef?: { hash: string; snapshot_hash: string };
}, verdict: 'approve' | 'request_changes'): LaneResult {
  const contractSignal = w.executionContractRef
    ? { contract_hash: w.executionContractRef.hash, capability_snapshot_hash: w.executionContractRef.snapshot_hash }
    : {};
  const contractLane = w.executionContractRef
    ? { execution_contract_hash: w.executionContractRef.hash, capability_snapshot_hash: w.executionContractRef.snapshot_hash }
    : {};
  if (w.executionContractRef) {
    fs.writeFileSync(getRuntimeSignalPath(cwd, w.assignmentId, 'ack'), JSON.stringify({
      status: 'accepted',
      turn_id: w.turnId,
      run_id: w.runId,
      nonce: w.nonce,
      contract_hash: w.executionContractRef.hash,
      capability_snapshot_hash: w.executionContractRef.snapshot_hash,
    }));
  }
  writeCompletionSignal(cwd, w.assignmentId, {
    turn_id: w.turnId,
    run_id: w.runId,
    nonce: w.nonce,
    status: 'completed',
    at: new Date().toISOString(),
    ...contractSignal,
  });
  return {
    assignment_id: w.assignmentId,
    turn_id: w.turnId,
    run_id: w.runId,
    nonce: w.nonce,
    status: 'completed',
    summary: 'fake review',
    review_verdict: verdict,
    review_summary: 'looks good',
    ...contractLane,
  };
}

/**
 * Characterization harness for the kind-neutral attempt primitives. It opens a
 * real loop (therefore using that kind's shipped default protocol) and only
 * derives reservation inputs from the materialized loop. Dispatch/reconcile is
 * deliberately outside this harness: the shipped end-to-end dispatcher remains
 * review-specific, while the durable attempt state machine is already generic.
 */
function lifecycleHarness(cwd: string, kind: LoopKind) {
  const slotId = `lsl_${kind}`;
  const loop = openLoop({
    kind,
    title: `${kind} lifecycle characterization`,
    created_by: 'coord',
    slots: [{ slot_id: slotId, role: 'worker', agent: 'codex' }],
  }, cwd);

  function reserveAt(iteration: number) {
    const turnId = deriveTurnId(loop.id, slotId, iteration);
    return reserve({
      turn_id: turnId,
      loop_id: loop.id,
      slot_id: slotId,
      target_slot_generation: iteration,
      loop_version_at_reserve: loop.version,
      agent: 'codex',
      claim_id: `clm_${kind}_${iteration}`,
      phase: loop.current_phase,
      iteration,
      store_root: cwd,
      cwd,
      lease_deadline: FUTURE(),
    }, cwd);
  }

  function evidenceMatches(turnId: string, nonce: string): boolean {
    const persisted = getReservation(turnId, cwd);
    assert.ok(persisted, `reservation ${turnId} must be readable`);
    return evidenceMatchesAttempt(persisted, {
      turn_id: turnId,
      run_id: persisted.child_ids.run_id,
      nonce,
    });
  }

  return { loop, reserveAt, evidenceMatches };
}

describe('dec#171 / pln#676 — attempt lifecycle characterization across all loop kinds', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  for (const kind of LOOP_KINDS) {
    it(`${kind}: reserve/commit/abort + arm/cross/revoke + adopted replay + stale evidence`, () => {
      const h = lifecycleHarness(cwd, kind);
      assert.equal(h.loop.kind, kind);
      assert.equal(getLoop(h.loop.id, cwd)?.kind, kind, 'attempt remains linked to a real persisted loop of this kind');

      const crossing = h.reserveAt(0);
      assert.equal(crossing.decision, 'prepared');
      assert.equal(commitReservation(crossing.turn_id, cwd).decision, 'committed');
      assert.equal(armLaunch(crossing.turn_id, { token: `${kind}-gen-1`, epoch: 1, lease_deadline: FUTURE() }, cwd).launch?.status, 'armed');
      const won = consumeLaunchGrant(crossing.turn_id, `${kind}-gen-1`, 1, cwd);
      assert.equal(won.reservation.launch?.status, 'crossed');
      assert.equal(won.wonTransition, true);
      const adopted = consumeLaunchGrant(crossing.turn_id, `${kind}-gen-1`, 1, cwd);
      assert.equal(adopted.wonTransition, false, 'replay observes crossed but does not regain spawn authority');
      assert.equal(h.evidenceMatches(crossing.turn_id, `${kind}-gen-1`), true);
      assert.equal(h.evidenceMatches(crossing.turn_id, `${kind}-stale`), false, 'wrong-generation evidence stays stale');

      const aborting = h.reserveAt(1);
      assert.equal(abortReservation(aborting.turn_id, 'characterized pre-commit abort', cwd).decision, 'aborted');

      const revoking = h.reserveAt(2);
      commitReservation(revoking.turn_id, cwd);
      armLaunch(revoking.turn_id, { token: `${kind}-gen-revoked`, epoch: 1, lease_deadline: FUTURE() }, cwd);
      assert.equal(revokeLaunchGrant(revoking.turn_id, 1, 'characterized supersession', cwd).launch?.status, 'revoked');
      assert.equal(h.evidenceMatches(revoking.turn_id, `${kind}-gen-revoked`), false, 'revoked evidence is no longer current');
    });
  }
});

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
    writeCompletionSignal(cwd, w.assignmentId, {
      turn_id: w.turnId,
      run_id: w.runId,
      nonce: w.nonce,
      status: 'failed',
      at: 'f',
      ...(w.executionContractRef
        ? { contract_hash: w.executionContractRef.hash, capability_snapshot_hash: w.executionContractRef.snapshot_hash }
        : {}),
    });
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

/**
 * pln#630 PR4 — §9 conformance over the REAL harvest path (flag-flip gate). The block above
 * drives the primitives directly; this proves harvest itself wires them under the flag: a
 * KEYLESS worker lane (the production shape — the brief never asks the worker to echo
 * turn_id/run_id/nonce) converges via sentinel-derived evidence, and a turn-owned lane routes
 * to reconcileTurn INSTEAD OF the legacy closer (exactly-one finalizer). The fuller harvest
 * matrix (request_changes bump/retain, cap→blocked, report→integrate, idempotent re-integrate,
 * wrong-nonce reject) lives in loops-pr3a-harvest-reconcile + loops-pr3b-fixcycle.
 */
describe('pln#630 §9 conformance — real harvest path (flag-gated)', () => {
  const A = 'conf-reviewer'; // profile-less ⇒ worker self-commits ⇒ no git / no on-behalf commit
  let cwd: string;
  beforeEach(() => { cwd = ws(); process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1'; });
  afterEach(() => { delete process.env.BRAINCLAW_TURN_OWNED_REVIEW; fs.rmSync(cwd, { recursive: true, force: true }); });

  it('a KEYLESS approve lane converges through integrateLaneResults via sentinel-derived evidence; turn-owned never hits the legacy closer', () => {
    const loop = openLoop({
      kind: 'review', title: 'conf-harvest', created_by: 'coord', mode: 'symmetric',
      phases: [{ name: 'findings' }], stop_condition: { kind: 'reviewer_green' },
      slots: [{ slot_id: 'lsl_r', role: 'reviewer', agent: A }],
    }, cwd);
    const turnId = deriveTurnId(loop.id, 'lsl_r', 0);
    const { assignment_id, run_id } = deriveChildIds(turnId);
    reserve({ turn_id: turnId, loop_id: loop.id, slot_id: 'lsl_r', target_slot_generation: 0, loop_version_at_reserve: loop.version, agent: A, claim_id: 'clm_c', phase: 'findings', iteration: 0, store_root: cwd, cwd, lease_deadline: FUTURE() }, cwd);
    commitReservation(turnId, cwd);
    armLaunch(turnId, { token: 'gen-0', epoch: 1, lease_deadline: FUTURE() }, cwd);
    consumeLaunchGrant(turnId, 'gen-0', 1, cwd);
    createAgentRun({ id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_c', agent: A, transport: 'cli_spawn', scope: `review-loop:${loop.id}`, description: 't', status: 'created', tags: ['turn-owned'] }, cwd);
    const claim: Claim = { schema_version: 2, id: 'clm_c', agent: A, scope: `review-loop:${loop.id}`, description: 't', created_at: nowISO(), status: 'active' };
    saveClaim(claim, cwd);
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-conf-wt-'));
    const asg: Assignment = { schema_version: 2, id: assignment_id, short_label: assignment_id, claim_id: 'clm_c', agent: A, dispatcher_agent: 'coord', scope: `review-loop:${loop.id}`, description: 't', status: 'offered', created_at: nowISO(), updated_at: nowISO(), offered_at: nowISO(), last_heartbeat_at: nowISO(), artifacts: [], retry_count: 0, max_retries: 2, heartbeat_ttl_ms: 1_800_000, acceptance_ttl_ms: 900_000, tags: [], worktree_path: wt };
    saveAssignment(asg, cwd);
    // The coordinator wrapper wrote the turn-keyed SENTINEL; the worker wrote a KEYLESS lane.
    writeCompletionSignal(cwd, assignment_id, { turn_id: turnId, run_id, nonce: 'gen-0', status: 'completed', at: 't' });
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({ assignment_id, status: 'completed', summary: 'reviewed', review_verdict: 'approve', review_summary: 'ok' }));

    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const converged = getLoop(loop.id, cwd)!;
    assert.ok(['closed', 'completed'].includes(converged.status), 'harvest converged the keyless approve lane via reconcile');
    assert.equal(loadAgentRun(run_id, cwd)?.status, 'completed', 'turn-owned run settled');
    assert.equal(converged.artifacts.filter((a) => a.type === 'verdict').length, 1, 'exactly one finalizer — no legacy double-record');
    assert.equal(loadClaim('clm_c', cwd)?.status, 'released', 'approve close released the claim');
    fs.rmSync(wt, { recursive: true, force: true });
  });
});
