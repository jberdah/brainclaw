import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { integrateLaneResults, harvestLaneResults, getLaneResultPath } from '../../src/commands/harvest.js';
import { openLoop, getLoop } from '../../src/core/loops/store.js';
import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, deriveTurnId, deriveChildIds,
} from '../../src/core/loops/attempt-reservation.js';
import { createAgentRun, loadAgentRun } from '../../src/core/agentruns.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { saveAssignment } from '../../src/core/assignments.js';
import { ensureRuntimeDirs, writeCompletionSignal } from '../../src/core/runtime-signals.js';
import { listRuntimeEvents } from '../../src/core/events.js';
import { nowISO } from '../../src/core/ids.js';
import type { Assignment, Claim, LaneResult } from '../../src/core/schema.js';

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
  opts: { verdict?: 'approve' | 'request_changes'; laneNonce?: string; writeSentinel?: boolean } = {},
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
  createAgentRun({
    id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_x', agent: AGENT,
    transport: 'cli_spawn', scope: `review-loop:${loopId}`, description: 'turn',
    status: 'created', tags: ['turn-owned', 'review', 'loop'],
  }, cwd);
  seedClaim(cwd, 'clm_x', loopId);
  const wt = wtDir();
  seedAssignment(cwd, assignment_id, loopId, wt);
  if (opts.writeSentinel !== false) {
    writeCompletionSignal(cwd, assignment_id, { turn_id: turnId, run_id, nonce: 'gen-1', status: 'completed', at: 'test' });
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

  it('T2 flag-on turn-owned REQUEST_CHANGES → verdict recorded, loop stays OPEN, no next_turn, no corruption', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'request_changes' });
    const res = integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(!['closed', 'completed', 'cancelled'].includes(loop.status), `loop stays open (${loop.status})`);
    assert.ok(loop.artifacts.some((a) => a.type === 'verdict' && (a.body ?? '').startsWith('changes-requested')));
    assert.equal(loadAgentRun(runId, cwd)?.status, 'completed', 'run still settled');
    assert.equal(res.next_turns.length, 0, 'no turn-owned re-dispatch (PR3b deferred)');
    // review #1/#6b — document the ACTUAL settlement: reconcileTurn settles an accepted
    // lane (approve OR request_changes) → the claim is released. PR3b must re-establish the
    // claim/worktree when it wires the symmetric fix-cycle re-dispatch.
    assert.equal(loadClaim('clm_x', cwd)?.status, 'released', 'accepted request_changes lane releases the claim');
  });

  it('T3 flag-OFF → LEGACY path even with a full turn-owned fixture: run stays created, zero harvested events', () => {
    // flag unset
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

  it('T8 report→integrate sequence: report neutralizes (loop open), integrate finalizes via reconcile (loop closed)', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.equal(getLoop(loopId, cwd)!.status, 'open', 'report path leaves the turn-owned loop OPEN (finalization deferred)');
    integrateLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    assert.ok(['closed', 'completed'].includes(getLoop(loopId, cwd)!.status), 'integrate finalizes via reconcile');
    assert.equal(harvestedEvents(cwd, runId).length, 1, 'reconcile ran exactly once — on integrate, not report');
  });
});

describe('pln#630 PR3a — report path (harvestLaneResults) neutralized for turn-owned', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });

  it('T5 flag-on: the report path does NOT close a turn-owned loop (finalization deferred to --integrate)', () => {
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    const { loopId, runId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.status, 'open', 'report path must not pre-empt reconcile — loop stays open');
    assert.equal(loadAgentRun(runId, cwd)?.status, 'created', 'run untouched by the report path');
    assert.equal(harvestedEvents(cwd, runId).length, 0);
  });

  it('T5b flag-OFF: the report path still closes a review loop via the legacy closer', () => {
    const { loopId, wt } = seedTurnOwned(cwd, { verdict: 'approve' });
    harvestLaneResults({ worktreePaths: [wt], cwd, agent: 'coordinator' });
    const loop = getLoop(loopId, cwd)!;
    assert.ok(['closed', 'completed'].includes(loop.status), 'legacy report-path close unchanged when flag off');
  });
});
