import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { integrateLaneResults, harvestLaneResults, getLaneResultPath, runHarvestLane } from '../../src/commands/harvest.js';
import { openLoop, getLoop, writeThreadFile } from '../../src/core/loops/store.js';
import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, deriveTurnId, deriveChildIds,
} from '../../src/core/loops/attempt-reservation.js';
import { createAgentRun, loadAgentRun, transitionAgentRun } from '../../src/core/agentruns.js';
import { reconcileAgentRun, reconcileDeadPidRunningAgentRunAtRead } from '../../src/core/agentrun-reconciler.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { loadAssignment, saveAssignment } from '../../src/core/assignments.js';
import { ensureRuntimeDirs, writeCompletionSignal } from '../../src/core/runtime-signals.js';
import { listRuntimeEvents } from '../../src/core/events.js';
import { nowISO } from '../../src/core/ids.js';
import type { Assignment, Claim, LaneResult } from '../../src/core/schema.js';
import { addArtifactWithEvidence, turn } from '../../src/core/loops/verbs.js';
import { computeNextExpected } from '../../src/core/loops/next-expected.js';

/**
 * pln#630 PR3a — wire the exactly-once `reconcileTurn` into harvest for TURN-OWNED review
 * lanes (flag-gated by BRAINCLAW_TURN_OWNED_REVIEW). The production case is the load-bearing
 * one: a real reviewer LANE-RESULT is KEYLESS (no turn_id/run_id/nonce — the brief never
 * asks for them), so harvest must source the read-strict evidence from the coordinator's
 * completion SENTINEL. Every fixture writes a keyless lane + a sentinel; no live spawn, no git
 * (a profile-less agent skips commit-on-behalf).
 */
const FUTURE = () => new Date(Date.now() + 600_000).toISOString();
const AGENT = 'test-reviewer'; // profile-less ⇒ workerCanCommit=true ⇒ no git / no on-behalf commit

const cleanup: string[] = [];
afterEach(() => {
  delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-pr3a-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  ensureRuntimeDirs(dir);
  cleanup.push(dir);
  return dir;
}

function wtDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-pr3a-wt-'));
  cleanup.push(d);
  return d;
}

function seedClaim(cwd: string, id: string, loopId: string): void {
  const claim: Claim = {
    schema_version: 2, id, agent: AGENT, scope: `review-loop:${loopId}`,
    description: 'turn', created_at: nowISO(), status: 'active',
  };
  saveClaim(claim, cwd);
}

function seedAssignment(cwd: string, id: string, loopId: string, worktree_path: string): void {
  const a: Assignment = {
    schema_version: 2, id, short_label: id, claim_id: 'clm_x', agent: AGENT,
    dispatcher_agent: 'coordinator', scope: `review-loop:${loopId}`, description: 'turn',
    status: 'offered', created_at: nowISO(), updated_at: nowISO(), offered_at: nowISO(),
    last_heartbeat_at: nowISO(), artifacts: [], retry_count: 0, max_retries: 2,
    heartbeat_ttl_ms: 30 * 60_000, acceptance_ttl_ms: 15 * 60_000, tags: [], worktree_path,
  };
  saveAssignment(a, cwd);
}

function openReviewLoop(cwd: string): { loopId: string; version: number } {
  const loop = openLoop({
    kind: 'review', title: 't', created_by: 'coord', mode: 'symmetric',
    phases: [{ name: 'findings' }], stop_condition: { kind: 'reviewer_green' },
    slots: [{ slot_id: 'lsl_r', role: 'reviewer', agent: AGENT, status: 'assigned' }],
  }, cwd);
  return { loopId: loop.id, version: loop.version };
}

/** A turn-owned attempt: reservation + launch-grant + `created` run + claim/assignment + a
 *  wrapper SENTINEL carrying the nonce + a KEYLESS worker LANE-RESULT.json. */
function seedTurnOwned(
  cwd: string,
  opts: { verdict?: 'approve' | 'request_changes'; laneNonce?: string; writeSentinel?: boolean; sentinelStatus?: 'completed' | 'failed' } = {},
): { loopId: string; turnId: string; runId: string; assignmentId: string; wt: string } {
  const { loopId, version } = openReviewLoop(cwd);
  const turnId = deriveTurnId(loopId, 'lsl_r', 0);
  const { assignment_id, run_id } = deriveChildIds(turnId);
  reserve({
    turn_id: turnId, loop_id: loopId, slot_id: 'lsl_r', target_slot_generation: 0,
    loop_version_at_reserve: version, agent: AGENT, claim_id: 'clm_x',
    phase: 'findings', iteration: 0, store_root: cwd, cwd, lease_deadline: FUTURE(),
  }, cwd);
  commitReservation(turnId, cwd);
  armLaunch(turnId, { token: 'gen-1', epoch: 1, lease_deadline: FUTURE() }, cwd);
  consumeLaunchGrant(turnId, 'gen-1', 1, cwd);
  const wt = wtDir();
  createAgentRun({
    id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_x', agent: AGENT,
    transport: 'cli_spawn', scope: `review-loop:${loopId}`, description: 'turn',
    status: 'created', tags: ['turn-owned', 'review', 'loop'], worktree_path: wt,
  }, cwd);
  seedClaim(cwd, 'clm_x', loopId);
  seedAssignment(cwd, assignment_id, loopId, wt);
  if (opts.writeSentinel !== false) {
    writeCompletionSignal(cwd, assignment_id, { turn_id: turnId, run_id, nonce: 'gen-1', status: opts.sentinelStatus ?? 'completed', at: 'test' });
  }
  // KEYLESS worker lane (production): assignment_id + verdict only, NO turn_id/run_id/nonce
  // — unless a test explicitly overrides laneNonce to probe read-strict rejection.
  const lane: Partial<LaneResult> & { assignment_id: string; status: string; summary: string } = {
    assignment_id, status: 'completed', summary: 'reviewed',
    ...(opts.verdict ? { review_verdict: opts.verdict, review_summary: 'rationale' } : {}),
    ...(opts.laneNonce ? { turn_id: turnId, run_id, nonce: opts.laneNonce } : {}),
  };
  fs.writeFileSync(getLaneResultPath(wt), JSON.stringify(lane));
  return { loopId, turnId, runId: run_id, assignmentId: assignment_id, wt };
}

/** A legacy (non-turn-owned) review lane: no reservation, plain run/claim/assignment. */
function seedLegacy(cwd: string, verdict: 'approve' | 'request_changes'): { loopId: string; wt: string; assignmentId: string } {
  const { loopId } = openReviewLoop(cwd);
  const assignmentId = 'asgn_legacy1';
  seedClaim(cwd, 'clm_x', loopId);
  const wt = wtDir();
  seedAssignment(cwd, assignmentId, loopId, wt);
  const lane = { assignment_id: assignmentId, status: 'completed', summary: 'reviewed', review_verdict: verdict, review_summary: 'r' };
  fs.writeFileSync(getLaneResultPath(wt), JSON.stringify(lane));
  return { loopId, wt, assignmentId };
}

function seedRepairableThirdCritic(cwd: string): { loopId: string; assignmentId: string; wt: string } {
  const loop = openLoop({
    kind: 'ideation', title: 'repairable critique', created_by: 'coord',
    phases: [
      { name: 'critique', advance_gate: { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' } },
      { name: 'revision' },
    ],
    stop_condition: { kind: 'max_iterations', n: 3 },
    slots: [
      { slot_id: 'lsl_c1', role: 'critic', agent: AGENT, phase: 'critique', status: 'done' },
      { slot_id: 'lsl_c2', role: 'critic', agent: AGENT, phase: 'critique', status: 'done' },
      { slot_id: 'lsl_c3', role: 'critic', agent: AGENT, phase: 'critique', status: 'open' },
    ],
  }, cwd);
  for (const [slotId, body] of [['lsl_c1', 'critique one'], ['lsl_c2', 'critique two']] as const) {
    addArtifactWithEvidence({
      id: loop.id,
      actor: AGENT,
      evidence_context: { channel: 'complete_turn', producer_kind: 'slot', producer_id: AGENT, slot_id: slotId, slot_role: 'critic' },
      artifact: { phase: 'critique', type: 'critique', body },
    }, cwd);
  }
  const beforeTurn = getLoop(loop.id, cwd)!;
  const turnId = deriveTurnId(loop.id, 'lsl_c3', 0);
  const { assignment_id, run_id } = deriveChildIds(turnId);
  reserve({
    turn_id: turnId, loop_id: loop.id, slot_id: 'lsl_c3', target_slot_generation: 0,
    loop_version_at_reserve: beforeTurn.version, agent: AGENT, claim_id: 'clm_x',
    phase: 'critique', iteration: 0, store_root: cwd, cwd, lease_deadline: FUTURE(),
    expected_artifacts: [{
      logical_name: 'critique',
      worker_path: 'LANE-RESULT.json',
      loop_artifact_type: 'critique',
      completion_policy: 'required',
    }],
  }, cwd);
  commitReservation(turnId, cwd);
  armLaunch(turnId, { token: 'gen-critique', epoch: 1, lease_deadline: FUTURE() }, cwd);
  consumeLaunchGrant(turnId, 'gen-critique', 1, cwd);
  const wt = wtDir();
  seedClaim(cwd, 'clm_x', loop.id);
  seedAssignment(cwd, assignment_id, loop.id, wt);
  createAgentRun({
    id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_x', agent: AGENT,
    transport: 'cli_spawn', scope: `ideate-loop:${loop.id}`, description: 'critic turn',
    status: 'created', tags: ['turn-owned', 'ideation', 'loop'], worktree_path: wt,
  }, cwd);
  turn({ id: loop.id, slot_id: 'lsl_c3', actor: 'coord', assignment_id, claim_id: 'clm_x', turn_id: turnId }, cwd);
  writeCompletionSignal(cwd, assignment_id, { turn_id: turnId, run_id, nonce: 'gen-critique', status: 'completed', at: 'test' });
  fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
    assignment_id, status: 'completed', summary: 'third critique', body: 'critique three',
    artifacts: [{ type: 'file', ref: 'CRITIQUE.md', description: 'worker output' }],
  }));
  return { loopId: loop.id, assignmentId: assignment_id, wt };
}

const harvestedEvents = (cwd: string, runId: string) =>
  listRuntimeEvents(cwd).filter((e) => e.event_type === 'loop_artifact_harvested' && e.run_id === runId);

describe('pln#630 PR3a — harvest → reconcileTurn wiring (integrate path)', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });

  it('T1 flag-on turn-owned APPROVE (keyless lane + sentinel) → reconcile finalizes: loop closes, run settled, one harvested event', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    const res = integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.equal(res.integrated.length, 1);
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), `loop terminal via reconcile (${loop.status})`);
    assert.ok(loop.artifacts.some((a) => a.type === 'verdict' && /^accepted/i.test(a.body ?? '')));
    assert.equal(loadAgentRun(runId, cwd)?.status, 'completed', 'turn-owned run settled created→completed');
    // Proves it was reconcileTurn (not the legacy closer): exactly one harvested event, keyed to the run.
    assert.equal(harvestedEvents(cwd, runId).length, 1, 'exactly one loop_artifact_harvested for this run');
    assert.equal(res.integrated[0]!.review_loop?.action, 'closed');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released', 'approve close releases the coordinator claim (review #6a)');
  });

  it('T2 flag-on turn-owned symmetric REQUEST_CHANGES → verdict recorded, round bumped, claim RETAINED, next_turn emitted (PR3b)', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'request_changes' });
    const res = integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(!['closed', 'completed', 'cancelled'].includes(loop.status), `loop stays open (${loop.status})`);
    assert.ok(loop.artifacts.some((a) => a.type === 'verdict' && (a.body ?? '').startsWith('changes-requested')));
    assert.equal(loadAgentRun(runId, cwd)?.status, 'completed', 'the old turn run is settled');
    // pln#630 PR3b — the symmetric fix cycle now continues autonomously: the round is bumped,
    // the coordinator claim/worktree is RETAINED, and a next_turn is handed to harvest.
    assert.equal(loop.iteration_count, 1, 'iteration bumped 0→1 for the next fix round');
    assert.equal(res.next_turns.length, 1, 'a fix-cycle re-dispatch turn is emitted');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'active', 'claim RETAINED across the fix cycle (worktree reused)');
  });

  it('T3 KILL-SWITCH (BRAINCLAW_TURN_OWNED_REVIEW=0) → LEGACY path even with a full turn-owned fixture: zero harvested events', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '0'; // explicit opt-out (turn-owned is the default now)
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'legacy closer still closes on approve');
    // The `loop_artifact_harvested` event is emitted ONLY by reconcileTurn — its absence
    // proves the legacy path ran, not reconcile. (The turn-owned RUN may still be settled
    // created→completed by the orthogonal sentinel-driven agentrun-reconciler; that is not a
    // PR3a signal, so we do not assert on run status here.)
    assert.equal(harvestedEvents(cwd, runId).length, 0, 'no reconcile ⇒ no loop_artifact_harvested event');
  });

  it('DEFAULT (env unset) → turn-owned is ON: a turn-owned approve lane converges via reconcileTurn', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW; // the shipped default is now ON
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.ok(['closed', 'completed'].includes(getLoop(loopId, cwd)!.status), 'default-on closes via reconcile');
    assert.equal(harvestedEvents(cwd, runId).length, 1, 'default-on ⇒ reconcileTurn finalized (harvested event present)');
  });

  it('review Finding 1 — a turn-owned reservation with NO sentinel (inbox/manual reviewer, no ack-wrapper) falls back to LEGACY and still converges (no stall)', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW; // default ON
    // A won turn-owned dispatch that never ack-wrap-spawned: reservation exists, NO completion
    // sentinel, keyless worker lane → no turn-keyed evidence. Must NOT stall on read-strict.
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve', writeSentinel: false });
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'no sentinel ⇒ LEGACY closer converges (not a silent stall)');
    assert.ok(loop.artifacts.some((a) => a.type === 'verdict'), 'verdict recorded via the legacy path');
    assert.equal(harvestedEvents(cwd, runId).length, 0, 'reconcileTurn did NOT run (no evidence) ⇒ no harvested event');
  });

  it('T4 flag-on but NON-turn-owned lane (no reservation) → legacy path, zero harvested events', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, wt } = seedLegacy(cwd, 'approve');
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'legacy lane closes via legacy path');
    assert.equal(listRuntimeEvents(cwd).filter((e) => e.event_type === 'loop_artifact_harvested').length, 0);
  });

  it('T6 flag-on turn-owned but WRONG nonce (sentinel absent + lane carries a stale nonce) → read-strict REJECTS, loop stays open, no verdict', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    // No sentinel written, and the keyless-lane override supplies a WRONG nonce so evidence cannot match.
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve', laneNonce: 'WRONG-GEN', writeSentinel: false });
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.status, 'open', 'stale/mismatched evidence never converges the loop');
    assert.ok(!loop.artifacts.some((a) => a.type === 'verdict'), 'no verdict recorded from rejected evidence');
    assert.equal(harvestedEvents(cwd, runId).length, 0, 'rejected evidence ⇒ reconcile never harvested');
    // Claim NOT released — reconcileTurn rejects at the evidence gate BEFORE settling, so the
    // loop stays live for a retry. (Run status is governed by the orthogonal reconciler.)
    assert.equal(loadClaim('clm_x', cwd)?.status, 'active');
    // review #2 — an unconverged turn-owned lane that carried a verdict must NOT stall
    // silently: an observable run_blocked event is emitted so a doctor/operator can see it.
    const unconverged = listRuntimeEvents(cwd).filter(
      (e) => e.event_type === 'run_blocked' && (e.tags ?? []).includes('unconverged'),
    );
    assert.equal(unconverged.length, 1, 'a not-converged turn-owned lane emits one observability event');
  });

  it('T7 idempotent — re-integrating a turn-owned APPROVE lane twice never double-finalizes (exactly-once)', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    // The lane file is still present; a second integrate must hit reconcile's terminal-loop
    // idempotent no-op (or be skipped) — either way NO duplicate verdict, loop stays terminal.
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'loop remains terminal after re-integrate');
    assert.equal(loop.artifacts.filter((a) => a.type === 'verdict').length, 1, 'exactly one verdict — no double-finalize');
  });

  it('T8 report→integrate sequence (pln#644 semantics): report ALREADY finalizes an approve lane; integrate is an idempotent no-op', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.ok(['closed', 'completed'].includes(getLoop(loopId, cwd)!.status), 'report path converges an approve turn-owned lane (pln#644)');
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'loop stays terminal after integrate');
    assert.equal(loop.artifacts.filter((a) => a.type === 'verdict').length, 1, 'exactly one verdict — integrate never double-finalizes');
    assert.equal(harvestedEvents(cwd, runId).length, 1, 'reconcile finalized exactly once — on report');
  });

  it('T8b report→integrate for REQUEST_CHANGES: report defers (loudly), integrate still owns the fix cycle', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'request_changes' });
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.equal(getLoop(loopId, cwd)!.status, 'open', 'report path leaves the RC fix cycle to --integrate');
    assert.equal(report.warnings.filter((w) => w.code === 'review_turn_not_converged').length, 1, '…but says so');
    const integ = integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.iteration_count, 1, 'integrate bumps the fix round');
    assert.equal(integ.next_turns.length, 1, 'integrate emits the fix-cycle re-dispatch turn');
  });
});

describe('pln#692 P0 — lazy AgentRun reconciliation harvests LANE-RESULT authoritatively', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });

  it('converges the worker artifact and every linked projection without an explicit harvest command', () => {
    const { loopId, runId, assignmentId } = seedTurnOwned(cwd, { verdict: 'approve' });

    const result = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0, actor: 'lazy-reconciler' });

    assert.equal(result.action, 'reconciled_turn');
    const loop = getLoop(loopId, cwd)!;
    const verdict = loop.artifacts.find((artifact) => artifact.type === 'verdict');
    assert.ok(verdict, 'the worker verdict is harvested into the loop');
    assert.equal(verdict.produced_by, AGENT, 'artifact provenance names the worker, not the harvester');
    assert.equal(verdict.evidence?.producer.kind, 'slot');
    assert.equal(verdict.evidence?.producer.id, AGENT);
    assert.equal(loadAgentRun(runId, cwd)?.status, 'completed');
    assert.equal(loadAssignment(assignmentId, cwd)?.status, 'completed', 'offered assignment converges through the system FSM');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released');
    assert.equal(harvestedEvents(cwd, runId).length, 1, 'harvester identity stays on the runtime observation channel');

    const replay = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0, actor: 'lazy-reconciler' });
    assert.equal(replay.action, 'reconciled_turn');
    assert.equal(getLoop(loopId, cwd)!.artifacts.filter((artifact) => artifact.type === 'verdict').length, 1);
  });

  it('withholds every projection when LANE-RESULT is malformed even if completion sentinel exists', () => {
    const { loopId, runId, assignmentId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    fs.writeFileSync(getLaneResultPath(wt), '{ malformed', 'utf8');

    const result = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0 });

    assert.equal(result.action, 'health_check_unverified');
    assert.match(result.reason, /invalid LANE-RESULT/);
    assert.equal(loadAgentRun(runId, cwd)?.status, 'created');
    assert.equal(loadAssignment(assignmentId, cwd)?.status, 'offered');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'active');
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.slots[0]?.status, 'assigned');
    assert.equal(loop.artifacts.length, 0);
  });

  it('a malformed LANE-RESULT cannot mask an authoritative failed sentinel', () => {
    const { loopId, runId, assignmentId, wt } = seedTurnOwned(cwd, { verdict: 'approve', sentinelStatus: 'failed' });
    fs.writeFileSync(getLaneResultPath(wt), '{ malformed', 'utf8');

    const result = reconcileAgentRun(runId, cwd, { healthCheckGraceMs: 0 });

    assert.equal(result.action, 'inferred_failed');
    assert.match(result.reason, /invalid_lane_result_with_conclusive_failure/);
    assert.equal(loadAgentRun(runId, cwd)?.status, 'failed');
    assert.notEqual(loadAssignment(assignmentId, cwd)?.status, 'offered');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released');
    assert.equal(getLoop(loopId, cwd)?.slots[0]?.status, 'failed');
  });

  it('also converges through the canonical dead-PID running read path', () => {
    const { loopId, runId, assignmentId } = seedTurnOwned(cwd, { verdict: 'approve' });
    transitionAgentRun(runId, 'running', { actor: 'test' }, cwd);

    const result = reconcileDeadPidRunningAgentRunAtRead(runId, cwd, { actor: 'read-reconciler' });

    assert.equal(result.action, 'reconciled_turn');
    assert.equal(loadAgentRun(runId, cwd)?.status, 'completed');
    assert.equal(loadAssignment(assignmentId, cwd)?.status, 'completed');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released');
    assert.equal(getLoop(loopId, cwd)!.artifacts.filter((artifact) => artifact.type === 'verdict').length, 1);
  });
});

/**
 * pln#644 — the report path used to SKIP turn-owned finalization entirely (deferred to
 * `--integrate`) with no signal on any channel. That silently stalled two live review loops
 * on 2026-08-02/03 (lop_626271ee10ad09d8, lop_4d869568bd99ddc0): the coordinator ran
 * `brainclaw harvest <asgn>`, read "1 harvested, 0 error(s)", and converged both turns by
 * hand hours later. New contract: the report path converges an APPROVE lane via the same
 * exactly-once reconcileTurn, and every non-converged turn-owned lane whose turn is still
 * live yields a `review_turn_not_converged` warning naming the recovery.
 */
describe('pln#644 — report path (harvestLaneResults) converges or warns, never silently stalls', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });

  it('2/3 + repairable third result stays replayable, then corrected harvest advances with strict evidence', () => {
    const { loopId, assignmentId, wt } = seedRepairableThirdCritic(cwd);
    const first = harvestLaneResults({ assignmentId, worktreePaths: [wt], cwd, agent: 'coordinator' });
    const afterMalformed = getLoop(loopId, cwd)!;
    assert.equal(afterMalformed.current_phase, 'critique');
    assert.equal(afterMalformed.slots.find((slot) => slot.slot_id === 'lsl_c3')?.status, 'assigned');
    assert.equal(loadAssignment(assignmentId, cwd)?.status, 'offered');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'active');
    assert.match(first.warnings.map((warning) => warning.message).join('\n'), /repairable worker result|artifact_type='critique'/);

    const next = computeNextExpected(afterMalformed);
    assert.equal(next?.action, 'complete_turn');
    assert.notEqual(next?.role, 'champion');

    const repaired = JSON.parse(fs.readFileSync(getLaneResultPath(wt), 'utf8')) as Record<string, unknown>;
    repaired.artifact_type = 'critique';
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify(repaired));
    harvestLaneResults({ assignmentId, worktreePaths: [wt], cwd, agent: 'coordinator' });
    const converged = getLoop(loopId, cwd)!;
    assert.equal(converged.current_phase, 'revision');
    assert.equal(converged.artifacts.filter((artifact) => artifact.type === 'critique').length, 3);
    assert.equal(loadAssignment(assignmentId, cwd)?.status, 'completed');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released');
  });

  it('counterfactual (2026-08-02 scenario) — keyless APPROVE lane + wrapper sentinel: plain report harvest CONVERGES the turn', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW; // shipped default: turn-owned ON
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), `report path finalizes an approve lane (${loop.status})`);
    assert.ok(loop.artifacts.some((a) => a.type === 'verdict' && /^accepted/i.test(a.body ?? '')), 'verdict recorded');
    assert.equal(loadAgentRun(runId, cwd)?.status, 'completed', 'turn-owned run settled created→completed');
    assert.equal(harvestedEvents(cwd, runId).length, 1, 'exactly one loop_artifact_harvested — reconcileTurn ran, exactly once');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released', 'approve close releases the coordinator claim');
    assert.equal(report.warnings.length, 0, 'a converged lane needs no warning');
  });

  it('REQUEST_CHANGES lane: loop untouched (no premature fix-cycle) but ONE warning names the open turn + `--integrate <asgn>`', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    const { loopId, runId, assignmentId, wt } = seedTurnOwned(cwd, { verdict: 'request_changes' });
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.status, 'open', 'report path never advances a fix cycle it cannot follow through on');
    assert.equal(loop.iteration_count, 0, 'no premature round bump');
    assert.equal(loadClaim('clm_x', cwd)?.status, 'active', 'claim untouched');
    assert.equal(harvestedEvents(cwd, runId).length, 0, 'reconcileTurn did not run');
    const warns = report.warnings.filter((w) => w.code === 'review_turn_not_converged');
    assert.equal(warns.length, 1, 'exactly one loud warning');
    assert.ok(warns[0]!.message.includes(`--integrate ${assignmentId}`), 'the warning names the exact recovery command');
    assert.ok(warns[0]!.message.includes(loopId), 'the warning names the stalled loop');
  });

  it('verdict-less turn-owned lane: no convergence (ambiguous evidence) but a warning says WHY', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    const { loopId, wt } = seedTurnOwned(cwd, {}); // no review_verdict at all
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.equal(getLoop(loopId, cwd)!.status, 'open');
    const warns = report.warnings.filter((w) => w.code === 'review_turn_not_converged');
    assert.equal(warns.length, 1);
    assert.ok(warns[0]!.message.includes('no review_verdict'), 'the warning names the missing evidence');
  });

  it('read-strict NOT weakened — wrong-nonce approve lane is refused AND the refusal is loud (was: silent skip)', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    // Lane carries a stale/wrong nonce, no sentinel: evidence can never match the attempt.
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve', laneNonce: 'WRONG-GEN', writeSentinel: false });
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.status, 'open', 'mismatched evidence never converges the loop');
    assert.ok(!loop.artifacts.some((a) => a.type === 'verdict'), 'no verdict from rejected evidence');
    assert.equal(harvestedEvents(cwd, runId).length, 0);
    const warns = report.warnings.filter((w) => w.code === 'review_turn_not_converged');
    assert.equal(warns.length, 1, 'the refusal surfaces as a warning');
    assert.ok(warns[0]!.message.includes('reconcileTurn refused'), 'the warning carries the read-strict reason');
  });

  it('idempotent + quiet once terminal: re-running report harvest on a converged approve lane warns nothing and never double-finalizes', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const second = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'loop stays terminal');
    assert.equal(loop.artifacts.filter((a) => a.type === 'verdict').length, 1, 'exactly one verdict across re-harvests');
    assert.equal(second.warnings.length, 0, 'a terminal loop is a healthy no-op, not a warning');
  });

  it('T5b KILL-SWITCH (=0): the report path still closes a review loop via the legacy closer', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '0'; // explicit opt-out (turn-owned is the default now)
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'legacy report-path close unchanged under the kill-switch');
  });

  it('CLI (`harvest <asgn> --json`) surfaces the warnings channel — the second silence of the lived stalls', async () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    const { assignmentId, wt } = seedTurnOwned(cwd, { verdict: 'request_changes' });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (s?: unknown) => { lines.push(String(s)); };
    try {
      await runHarvestLane(assignmentId, { worktree: [wt], cwd, json: true });
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(lines.join('\n')) as { warnings?: Array<{ code: string; message: string }> };
    assert.ok(parsed.warnings, 'JSON output carries the warnings field');
    assert.equal(parsed.warnings!.length, 1);
    assert.equal(parsed.warnings![0]!.code, 'review_turn_not_converged');
    assert.ok(parsed.warnings![0]!.message.includes(`--integrate ${assignmentId}`));
  });

  it('PR #171 P2-1 — a BLOCKED loop (iteration cap) is terminal for reconcile: RC lane re-scan stays QUIET', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'request_changes' });
    const thread = getLoop(loopId, cwd)!;
    thread.status = 'blocked';
    writeThreadFile(thread, cwd);
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.equal(getLoop(loopId, cwd)!.status, 'blocked', 'loop untouched');
    assert.equal(report.warnings.length, 0, 'a blocked loop is not awaiting convergence — no false alarm');
  });

  it('PR #171 P2-1 — a PAUSED loop refuses advancement until resume: RC lane stays QUIET (advising --integrate would be a lie)', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'request_changes' });
    const thread = getLoop(loopId, cwd)!;
    thread.status = 'paused';
    writeThreadFile(thread, cwd);
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.equal(getLoop(loopId, cwd)!.status, 'paused', 'loop untouched');
    assert.equal(report.warnings.length, 0, 'a deliberately paused loop is an operator choice, not a stall');
  });

  it('PR #171 P2-2 — an UNEXPECTED reconcile failure (corrupt loop store) is swallowed but LOUD, not "1 harvested, 0 error(s)"', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    // Corrupt the loop thread file: getLoop propagates the parse error out of
    // reconcileTurn, exercising the harvest catch — which used to swallow it silently.
    fs.writeFileSync(path.join(cwd, '.brainclaw', 'loops', 'threads', `${loopId}.json`), '{ not json');
    const report = harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const warns = report.warnings.filter((w) => w.code === 'review_turn_not_converged');
    assert.equal(warns.length, 1, 'the swallowed failure surfaces as a warning');
    assert.ok(warns[0]!.message.includes('loop-close failed unexpectedly'), 'the warning names the failure mode');
    assert.ok(warns[0]!.message.includes(loopId), 'the warning still names the loop (from the reservation, not the broken store)');
  });
});
