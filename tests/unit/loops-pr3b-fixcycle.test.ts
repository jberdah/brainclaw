import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { turn, advance } from '../../src/core/loops/verbs.js';
import { reconcileTurn } from '../../src/core/loops/reconcile-turn.js';
import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, deriveTurnId, deriveChildIds,
  revokeLaunchGrant, launchGrant,
} from '../../src/core/loops/attempt-reservation.js';
import { prepareTurnOwnedReviewDispatch as prepareViaDispatch } from '../../src/core/review-loop-turn-dispatch.js';
import { createAgentRun, loadAgentRun } from '../../src/core/agentruns.js';
import { reconcileAgentRun } from '../../src/core/agentrun-reconciler.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { saveAssignment } from '../../src/core/assignments.js';
import { ensureRuntimeDirs, writeCompletionSignal } from '../../src/core/runtime-signals.js';
import { nowISO } from '../../src/core/ids.js';
import type { Assignment, Claim, LaneResult } from '../../src/core/schema.js';

/**
 * pln#630 PR3b — the autonomous symmetric request_changes fix cycle in reconcileTurn.
 * A request_changes turn bumps the round (iteration_count += 1), RETAINS the coordinator
 * claim/worktree, and emits a next_turn for re-dispatch; the iteration cap closes to
 * `blocked`. The load-bearing safety property is that the bump is EXACTLY-ONCE (a double
 * bump would mint two turn_ids and spawn two rounds), guarded by iteration-equality.
 * Reconcile-unit tests (no live spawn) supply keyed lanes directly.
 */
const FUTURE = () => new Date(Date.now() + 600_000).toISOString();
const AGENT = 'codex';

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true }); });

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-pr3b-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  ensureRuntimeDirs(dir);
  cleanup.push(dir);
  return dir;
}

function openSymmetricReview(cwd: string, maxIter = 3): { loopId: string; version: number } {
  const loop = openLoop({
    kind: 'review', title: 't', created_by: 'coord', mode: 'symmetric',
    phases: [{ name: 'findings' }],
    stop_condition: { kind: 'any', conditions: [{ kind: 'reviewer_green' }, { kind: 'max_iterations', n: maxIter }] },
    slots: [{ slot_id: 'lsl_r', role: 'reviewer', agent: AGENT, status: 'assigned' }],
  }, cwd);
  return { loopId: loop.id, version: loop.version };
}

function seedClaimAssignment(cwd: string, loopId: string, assignmentId: string): void {
  const claim: Claim = {
    schema_version: 2, id: 'clm_x', agent: AGENT, scope: `review-loop:${loopId}`,
    description: 'turn', created_at: nowISO(), status: 'active',
  };
  saveClaim(claim, cwd);
  const a: Assignment = {
    schema_version: 2, id: assignmentId, short_label: assignmentId, claim_id: 'clm_x', agent: AGENT,
    dispatcher_agent: 'coord', scope: `review-loop:${loopId}`, description: 'turn', status: 'offered',
    created_at: nowISO(), updated_at: nowISO(), offered_at: nowISO(), last_heartbeat_at: nowISO(),
    artifacts: [], retry_count: 0, max_retries: 2, heartbeat_ttl_ms: 30 * 60_000, acceptance_ttl_ms: 15 * 60_000, tags: [],
  };
  saveAssignment(a, cwd);
}

/** Mint a committed+consumed turn-owned attempt for round `iteration` and return a keyed lane. */
function mintTurn(
  cwd: string, loopId: string, version: number, iteration: number, verdict: 'approve' | 'request_changes',
): { turnId: string; runId: string; assignmentId: string; lane: LaneResult } {
  const turnId = deriveTurnId(loopId, 'lsl_r', iteration);
  const { assignment_id, run_id } = deriveChildIds(turnId);
  const token = `gen-${iteration}`;
  reserve({
    turn_id: turnId, loop_id: loopId, slot_id: 'lsl_r', target_slot_generation: iteration,
    loop_version_at_reserve: version, agent: AGENT, claim_id: 'clm_x', phase: 'findings',
    iteration, store_root: cwd, cwd, lease_deadline: FUTURE(),
  }, cwd);
  commitReservation(turnId, cwd);
  armLaunch(turnId, { token, epoch: iteration + 1, lease_deadline: FUTURE() }, cwd);
  consumeLaunchGrant(turnId, token, iteration + 1, cwd);
  createAgentRun({
    id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_x', agent: AGENT,
    transport: 'cli_spawn', scope: `review-loop:${loopId}`, description: 'turn', status: 'created',
    tags: ['turn-owned', 'review', 'loop'],
  }, cwd);
  seedClaimAssignment(cwd, loopId, assignment_id);
  writeCompletionSignal(cwd, assignment_id, { turn_id: turnId, run_id, nonce: token, status: 'completed', at: 'test' });
  const lane: LaneResult = {
    assignment_id, turn_id: turnId, run_id, nonce: token, status: 'completed',
    summary: 'reviewed', review_verdict: verdict, review_summary: 'fix the thing',
  } as LaneResult;
  return { turnId, runId: run_id, assignmentId: assignment_id, lane };
}

describe('pln#630 PR3b — reconcileTurn symmetric fix cycle', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });

  it('A — request_changes bumps the round, RETAINS the claim, emits next_turn, loop stays open', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const { turnId, lane } = mintTurn(cwd, loopId, version, 0, 'request_changes');
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, true);
    assert.ok(r.next_turn, 'a next_turn is emitted for the fix cycle');
    assert.equal(r.next_turn!.iteration, 1, 'next round is iteration 1');
    assert.equal(r.next_turn!.slot_id, 'lsl_r');
    assert.equal(getLoop(loopId, cwd)!.iteration_count, 1, 'iteration bumped 0→1');
    assert.ok(!['closed', 'completed', 'cancelled', 'blocked'].includes(getLoop(loopId, cwd)!.status), 'loop stays open');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'active', 'claim RETAINED for re-dispatch');
    assert.ok(getLoop(loopId, cwd)!.artifacts.some((a) => a.type === 'verdict' && (a.body ?? '').startsWith('changes-requested')));
  });

  it('B — round 1 approve after a round-0 request_changes → reviewer_green closes + claim released', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const t0 = mintTurn(cwd, loopId, version, 0, 'request_changes');
    reconcileTurn({ turn_id: t0.turnId, lane: t0.lane, cwd }); // → iteration 1, retained
    // The re-dispatch resets the slot to `assigned` + binds the new turn (what turn() does).
    const loopV = getLoop(loopId, cwd)!.version;
    const t1turnId = deriveTurnId(loopId, 'lsl_r', 1);
    turn({ id: loopId, slot_id: 'lsl_r', actor: 'coord', turn_id: t1turnId }, cwd);
    const t1 = mintTurn(cwd, loopId, loopV, 1, 'approve');
    const r1 = reconcileTurn({ turn_id: t1.turnId, lane: t1.lane, cwd });
    assert.equal(r1.reconciled, true);
    assert.equal(r1.auto_closed, true, 'approve fires reviewer_green → close');
    assert.ok(['closed', 'completed'].includes(getLoop(loopId, cwd)!.status));
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released', 'terminal close releases the retained claim');
    assert.equal(r1.next_turn, undefined, 'no further re-dispatch after approve');
  });

  it('C — iteration cap (max_iterations:1) → request_changes closes the loop to BLOCKED, no next_turn, claim released', () => {
    const { loopId, version } = openSymmetricReview(cwd, 1);
    const { turnId, lane } = mintTurn(cwd, loopId, version, 0, 'request_changes');
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, true);
    assert.equal(r.next_turn, undefined, 'cap hit → no fix-cycle re-dispatch');
    assert.equal(r.auto_closed, true);
    assert.equal(getLoop(loopId, cwd)!.status, 'blocked', 'max_iterations cap → blocked');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released', 'terminal cap releases the claim');
  });

  it('D — EXACTLY-ONCE bump: reconciling the SAME request_changes turn twice bumps only once', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const { turnId, lane } = mintTurn(cwd, loopId, version, 0, 'request_changes');
    const r1 = reconcileTurn({ turn_id: turnId, lane, cwd });
    const r2 = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(getLoop(loopId, cwd)!.iteration_count, 1, 'iteration bumped ONCE, not twice (no double turn_id → no double-spawn)');
    assert.equal(getLoop(loopId, cwd)!.artifacts.filter((a) => a.type === 'verdict').length, 1, 'single verdict artifact');
    assert.equal(r2.artifacts_added, 0, 'the second reconcile records nothing');
    // The claim must remain RETAINED across both passes (the re-emit window keeps it alive).
    assert.equal(loadClaim('clm_x', cwd)?.status, 'active');
    assert.ok(r1.next_turn, 'first pass emits the fix-cycle turn');
  });

  it('E — a superseded request_changes turn (a newer turn bound the slot) → no-op, no re-bump', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const { turnId, lane } = mintTurn(cwd, loopId, version, 0, 'request_changes');
    // A newer turn rebinds the slot pointer (what the next round's dispatch does).
    turn({ id: loopId, slot_id: 'lsl_r', actor: 'coord', turn_id: 'tat_newer' }, cwd);
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.reconciled, false);
    assert.match(r.reason, /superseded/);
    assert.equal(getLoop(loopId, cwd)!.iteration_count, 0, 'no bump from a superseded turn');
  });

  it('F — fresh-read bump guard: an already-advanced round does NOT double-bump; a never-dispatched round self-heals (Findings 1 + F3)', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const { turnId, lane } = mintTurn(cwd, loopId, version, 0, 'request_changes');
    // Simulate a pass that ALREADY bumped the loop (iteration 0→1) but crashed before dispatching
    // round 1. reservation.iteration is still 0, the LIVE loop is at 1 — the classic TOCTOU. A
    // stale-snapshot guard would bump AGAIN (→2), minting a second turn_id → double-spawn.
    advance({ id: loopId, to_phase: 'findings', actor: 'coord' }, cwd);
    assert.equal(getLoop(loopId, cwd)!.iteration_count, 1, 'precondition: loop pre-bumped to 1, round 1 never dispatched');
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(getLoop(loopId, cwd)!.iteration_count, 1, 'NO second bump — the in-lock re-read saw the fresh iteration');
    // Round 1 has no reservation (never dispatched) → genuine strand → F3 self-heal re-emits.
    assert.ok(r.next_turn, 'strand recovery: a bumped-but-never-dispatched round re-emits next_turn (F3)');
    assert.equal(r.next_turn!.iteration, 1, 're-emits the STUCK round (1), not a new bump');
  });

  it('F2 — a benign re-reconcile whose next round IS already dispatched does NOT re-emit (no churn)', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const { turnId, lane } = mintTurn(cwd, loopId, version, 0, 'request_changes');
    reconcileTurn({ turn_id: turnId, lane, cwd }); // bump → iteration 1, emits round-1 next_turn
    // Round 1 IS dispatched: create its reservation (deriveTurnId(loop,slot,1)). No turn() call —
    // the reconcile-unit fixtures leave slot.current_turn_id unset, so the superseded guard does
    // not fire and we exercise the else-retain "reservation exists → no re-emit" branch directly.
    mintTurn(cwd, loopId, getLoop(loopId, cwd)!.version, 1, 'request_changes');
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.equal(r.next_turn, undefined, 'round 1 already dispatched → no strand → no re-emit (no churn)');
  });

  it('G2 — reconcile on an already-BLOCKED loop releases a leaked claim then no-ops (review Finding 2)', () => {
    const { loopId, version } = openSymmetricReview(cwd, 1);
    const { turnId, lane } = mintTurn(cwd, loopId, version, 0, 'request_changes');
    reconcileTurn({ turn_id: turnId, lane, cwd }); // cap:1 → blocked, claim released
    assert.equal(getLoop(loopId, cwd)!.status, 'blocked');
    // Simulate the crash-before-release leak: a claim left active on the terminal (blocked) loop.
    saveClaim({ schema_version: 2, id: 'clm_x', agent: AGENT, scope: `review-loop:${loopId}`, description: 't', created_at: nowISO(), status: 'active' }, cwd);
    const r = reconcileTurn({ turn_id: turnId, lane, cwd });
    assert.match(r.reason, /idempotent no-op/);
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released', 'the terminal early-return released the leaked claim');
  });

  it('F3 — after round N+1 is REALLY dispatched (turn() rebinds the slot), re-reconciling round N hits the superseded guard, never the strand re-emit', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const t0 = mintTurn(cwd, loopId, version, 0, 'request_changes');
    reconcileTurn({ turn_id: t0.turnId, lane: t0.lane, cwd }); // bump → iteration 1
    // Round 1's real dispatch calls turn(), rebinding slot.current_turn_id to round-1's turnId —
    // the PRIMARY production stopper. A late re-reconcile of the OLD round-0 turn must hit the
    // superseded guard BEFORE the else-branch, so it never mistakes a progressing loop for a strand.
    const t1turnId = deriveTurnId(loopId, 'lsl_r', 1);
    turn({ id: loopId, slot_id: 'lsl_r', actor: 'coord', turn_id: t1turnId }, cwd);
    const r = reconcileTurn({ turn_id: t0.turnId, lane: t0.lane, cwd });
    assert.equal(r.reconciled, false);
    assert.match(r.reason, /superseded/);
    assert.equal(r.next_turn, undefined, 'a superseded old turn never re-emits a strand next_turn');
  });

  it('R1a — a bumped round whose grant was REVOKED (reserved_never_launched) is a STRAND → reconcile re-emits (dec#149 R1)', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const t0 = mintTurn(cwd, loopId, version, 0, 'request_changes');
    reconcileTurn({ turn_id: t0.turnId, lane: t0.lane, cwd }); // bump → iteration 1
    // Round 1 was reserved+committed+armed by a pass that CRASHED before consume; the expiry
    // sweep then revoked its grant. Reservation EXISTS, grant REVOKED — the sibling strand the
    // PR4 detector missed (getReservation was truthy → "in flight"), leaving the loop stuck.
    const t1 = deriveTurnId(loopId, 'lsl_r', 1);
    const loopV = getLoop(loopId, cwd)!.version;
    reserve({ turn_id: t1, loop_id: loopId, slot_id: 'lsl_r', target_slot_generation: 1, loop_version_at_reserve: loopV, agent: AGENT, claim_id: 'clm_x', phase: 'findings', iteration: 1, store_root: cwd, cwd, lease_deadline: FUTURE() }, cwd);
    commitReservation(t1, cwd);
    armLaunch(t1, { token: 'gen-1', epoch: 1, lease_deadline: FUTURE() }, cwd);
    revokeLaunchGrant(t1, 1, 'reserved_never_launched', cwd);
    assert.equal(launchGrant(t1, cwd)?.status, 'revoked', 'precondition: round-1 grant revoked');
    const r = reconcileTurn({ turn_id: t0.turnId, lane: t0.lane, cwd });
    assert.ok(r.next_turn, 'revoked-grant strand now re-emits next_turn (was silently stuck pre-R1)');
    assert.equal(r.next_turn!.iteration, 1, 're-emits the stuck round 1');
  });

  it('R1b — prepareTurnOwnedReviewDispatch RE-ARMS a revoked grant at a higher epoch → re-dispatchable (dec#149 R1)', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const turnId = deriveTurnId(loopId, 'lsl_r', 0);
    reserve({ turn_id: turnId, loop_id: loopId, slot_id: 'lsl_r', target_slot_generation: 0, loop_version_at_reserve: version, agent: AGENT, claim_id: 'clm_x', phase: 'findings', iteration: 0, store_root: cwd, cwd, lease_deadline: FUTURE() }, cwd);
    commitReservation(turnId, cwd);
    armLaunch(turnId, { token: 'gen-0', epoch: 0, lease_deadline: FUTURE() }, cwd);
    revokeLaunchGrant(turnId, 0, 'reserved_never_launched', cwd);
    assert.equal(launchGrant(turnId, cwd)?.status, 'revoked', 'precondition: grant revoked');
    // A re-dispatch adopts the committed reservation, sees the revoked grant, RE-ARMS at epoch+1.
    const prep = prepareViaDispatch({
      loopId, slotId: 'lsl_r', agent: AGENT, phase: 'findings', task: 'fix', description: 'fix',
      scope: `review-loop:${loopId}`, claimId: 'clm_x', dispatcherAgent: 'coord', isReviewer: true, cwd,
    });
    assert.equal(prep.kind, 'won', 'a revoked round re-arms + wins the fence → re-dispatchable');
    assert.equal(launchGrant(turnId, cwd)?.status, 'crossed', 'the re-armed grant was consumed (single spawn authority)');
  });
});

describe('pln#630 PR3b — fix-cycle re-dispatch is exactly-once (fence denies the duplicate)', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });

  it('D2 — after the bump, dispatching round 1 twice: first WON, second DENIED (single spawn)', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const t0 = mintTurn(cwd, loopId, version, 0, 'request_changes');
    reconcileTurn({ turn_id: t0.turnId, lane: t0.lane, cwd }); // bump → iteration 1
    // Two concurrent re-dispatches of the SAME bumped round derive the SAME turn_id
    // (deriveTurnId(loop, slot, 1)); the launch fence must admit exactly one spawner.
    const common = {
      loopId, slotId: 'lsl_r', agent: AGENT, phase: 'findings', task: 'fix', description: 'fix',
      scope: `review-loop:${loopId}`, claimId: 'clm_x', dispatcherAgent: 'coord', isReviewer: true, cwd,
    };
    const first = prepareViaDispatch(common);
    const second = prepareViaDispatch(common);
    const kinds = [first.kind, second.kind].sort();
    assert.deepEqual(kinds, ['denied', 'won'], 'exactly one dispatch WON the launch fence, the other was DENIED');
  });

  it('R1c — the WIRED reconciler revokes an expired armed grant, and the (longer) dispatch lease lets it re-arm: strand is production-reachable AND recoverable (dec#149 R1 / review F1+F2)', () => {
    const { loopId, version } = openSymmetricReview(cwd);
    const turnId = deriveTurnId(loopId, 'lsl_r', 0);
    const { assignment_id, run_id } = deriveChildIds(turnId);
    // Decoupled leases: LONG dispatch lease (recovery window) + SHORT grant lease.
    const dispatchLease = new Date(Date.now() + 30 * 60_000).toISOString();
    const grantLease = new Date(Date.now() + 10 * 60_000).toISOString();
    reserve({ turn_id: turnId, loop_id: loopId, slot_id: 'lsl_r', target_slot_generation: 0, loop_version_at_reserve: version, agent: AGENT, claim_id: 'clm_x', phase: 'findings', iteration: 0, store_root: cwd, cwd, lease_deadline: dispatchLease }, cwd);
    commitReservation(turnId, cwd);
    armLaunch(turnId, { token: 'gen-0', epoch: 0, lease_deadline: grantLease }, cwd);
    createAgentRun({ id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_x', agent: AGENT, transport: 'cli_spawn', scope: `review-loop:${loopId}`, description: 't', status: 'created', tags: ['turn-owned'] }, cwd);
    // Worker crashed before consume. The WIRED lazy reconciler, at a time PAST the grant lease
    // but WITHIN the dispatch lease, must REVOKE the grant (F2) + cancel the run — NOT leave it armed.
    reconcileAgentRun(run_id, cwd, { nowMs: Date.now() + 15 * 60_000, actor: 'reconciler' });
    assert.equal(launchGrant(turnId, cwd)?.status, 'revoked', 'wired reconciler revoked the expired armed grant (F2)');
    assert.equal(loadAgentRun(run_id, cwd)?.status, 'cancelled', 'run cancelled reserved_never_launched');
    // Recovery: the reservation adopts, sees the revoked grant, re-arms at epoch+1 within the
    // still-open dispatch lease → WON (with a single shared lease this was always denied — F1).
    const prep = prepareViaDispatch({ loopId, slotId: 'lsl_r', agent: AGENT, phase: 'findings', task: 'fix', description: 'fix', scope: `review-loop:${loopId}`, claimId: 'clm_x', dispatcherAgent: 'coord', isReviewer: true, cwd });
    assert.equal(prep.kind, 'won', 'the revoked round re-arms + wins within the longer dispatch lease');
    assert.equal(launchGrant(turnId, cwd)?.status, 'crossed', 'the re-armed grant was consumed (single spawn)');
  });
});
