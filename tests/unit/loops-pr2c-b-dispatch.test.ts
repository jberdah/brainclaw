import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { prepareTurnOwnedReviewDispatch } from '../../src/core/review-loop-turn-dispatch.js';
import {
  getReservation, launchGrant, deriveTurnId, deriveChildIds,
  reserve, commitReservation, armLaunch, consumeLaunchGrant,
} from '../../src/core/loops/attempt-reservation.js';
import { loadAgentRun, listAgentRuns } from '../../src/core/agentruns.js';
import { saveClaim } from '../../src/core/claims.js';
import { acquireLock } from '../../src/core/loops/lock.js';
import { memoryDir } from '../../src/core/io.js';
import { phasePolicy } from '../../src/core/loops/kind-policies.js';

// pln#630 PR2c-b (dec#144) — coordinator-inline-consume: the exactly-once turn
// machine wired into review dispatch. prepareTurnOwnedReviewDispatch runs the
// reserve→commit→arm→consume gate + deterministic mint + slot bind, WITHOUT
// spawning — so it is unit-testable in isolation.

const SLOT = 'lsl_r';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-pr2cb-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function openReviewLoop(cwd: string): string {
  const loop = openLoop({
    kind: 'review', title: 't', created_by: 'coordinator', mode: 'symmetric',
    phases: [{ name: 'findings' }],
    slots: [{ slot_id: SLOT, role: 'reviewer', agent: 'claude-code' }],
  }, cwd);
  saveClaim({
    schema_version: 2,
    id: 'clm_coord',
    agent: 'claude-code',
    scope: `review-loop:${loop.id}`,
    description: 'review turn',
    created_at: new Date().toISOString(),
    status: 'active',
  }, cwd);
  return loop.id;
}

function prepInput(cwd: string, loopId: string) {
  return {
    loopId, slotId: SLOT, agent: 'claude-code', phase: 'findings',
    task: 'review the change', description: 'review turn', scope: `review-loop:${loopId}`,
    claimId: 'clm_coord', worktreePath: path.join(cwd, 'wt'),
    dispatcherAgent: 'coordinator', isReviewer: true, cwd,
  };
}

describe('PR2c-b prepareTurnOwnedReviewDispatch (pln#630 dec#144)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('WON: reserve→commit→arm→consume, mints created run, binds slot, returns turn-keyed echo', () => {
    const loopId = openReviewLoop(cwd);
    const prep = prepareTurnOwnedReviewDispatch(prepInput(cwd, loopId));
    assert.equal(prep.kind, 'won');
    if (prep.kind !== 'won') return;

    const turnId = deriveTurnId(loopId, SLOT, 0);
    const { run_id, assignment_id } = deriveChildIds(turnId);
    assert.equal(prep.turnId, turnId);
    assert.equal(prep.runId, run_id);
    assert.equal(prep.assignmentId, assignment_id);

    // Reservation committed + grant crossed (the fence was consumed by this call).
    assert.equal(getReservation(turnId, cwd)?.decision, 'committed');
    const grant = launchGrant(turnId, cwd);
    assert.equal(grant?.status, 'crossed');
    // The turn echo's nonce is EXACTLY the (authoritative) launch token — the
    // read-strict acceptance path matches on this (dec#144 #4).
    assert.equal(prep.nonce, grant?.token);

    // Run preallocated `created` (not running — prepare does not spawn).
    const run = loadAgentRun(run_id, cwd);
    assert.equal(run?.status, 'created');
    assert.equal(run?.claim_id, 'clm_coord', 'run bound to the winner live claim');

    // Slot stamped with current_turn_id.
    const slot = getLoop(loopId, cwd)?.slots.find((s) => s.slot_id === SLOT);
    assert.equal(slot?.current_turn_id, turnId);
  });

  it('DENIED on duplicate dispatch: 2nd prepare adopts a crossed grant, no second run', () => {
    const loopId = openReviewLoop(cwd);
    const first = prepareTurnOwnedReviewDispatch(prepInput(cwd, loopId));
    assert.equal(first.kind, 'won');

    const second = prepareTurnOwnedReviewDispatch(prepInput(cwd, loopId));
    assert.equal(second.kind, 'denied', 'a concurrent/duplicate dispatch must NOT win again');
    if (second.kind === 'denied') assert.match(second.reason, /launch_denied|crossed/);

    // Exactly one turn-owned run exists (idempotent id + no re-mint).
    const turnId = deriveTurnId(loopId, SLOT, 0);
    const { run_id } = deriveChildIds(turnId);
    const runsForTurn = listAgentRuns(cwd).filter((r) => r.id === run_id);
    assert.equal(runsForTurn.length, 1, 'no double-mint of the deterministic run');
  });

  it('DENIED on crash-recovery of a CROSSED grant: prepare must not re-spawn (launch_attempted_unknown)', () => {
    const loopId = openReviewLoop(cwd);
    const turnId = deriveTurnId(loopId, SLOT, 0);
    const policy = phasePolicy('review', 'findings')!;
    // Simulate a prior dispatch that reserved+committed+armed+CROSSED then crashed.
    reserve({
      turn_id: turnId, loop_id: loopId, slot_id: SLOT, target_slot_generation: 0,
      loop_version_at_reserve: 1, agent: 'claude-code', claim_id: 'clm_coord',
      phase: 'findings', iteration: 0, store_root: cwd, cwd,
      completion_mode: policy.completion_mode, expected_artifacts: policy.expected_artifacts,
      lease_deadline: new Date(Date.now() + 600_000).toISOString(),
    }, cwd);
    commitReservation(turnId, cwd);
    armLaunch(turnId, { token: 'tok-dead', epoch: 0, lease_deadline: new Date(Date.now() + 600_000).toISOString() }, cwd);
    consumeLaunchGrant(turnId, 'tok-dead', 0, cwd); // crossed by the "dead" attempt

    const prep = prepareTurnOwnedReviewDispatch(prepInput(cwd, loopId));
    assert.equal(prep.kind, 'denied', 'a crossed grant is launch_attempted_unknown — never re-spawn');
    if (prep.kind === 'denied') assert.match(prep.reason, /crossed|launch_denied/);
  });

  it('LEGACY when the loop is not found (fail-open BEFORE any identity is reserved)', () => {
    const prep = prepareTurnOwnedReviewDispatch(prepInput(cwd, 'lop_doesnotexist'));
    assert.equal(prep.kind, 'legacy', 'a pre-identity failure degrades to the legacy path');
    // No reservation was created for a would-be turn_id.
    assert.equal(getReservation(deriveTurnId('lop_doesnotexist', SLOT, 0), cwd), undefined);
  });

  it('DENIED (not legacy) when reserve is INDETERMINATE — a held reservation lock (review Finding 1)', () => {
    // A live holder of the per-turn reservation lock makes reserve() time out
    // (LockTimeoutError), which is NOT proof that no identity exists. Degrading to
    // `legacy` here would spawn a second, ungated worker beside a reservation that
    // may well exist → double-spawn. It MUST fail closed (denied).
    const loopId = openReviewLoop(cwd);
    const turnId = deriveTurnId(loopId, SLOT, 0);
    const lockPath = path.join(memoryDir(cwd), 'loops', 'reservations', 'locks', `${turnId}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Hold the lock (this process, alive → not stale) so reserve's acquireLock
    // exhausts its backoff budget and throws LockTimeoutError.
    const held = acquireLock({ lockPath, agentId: 'other-holder', intent: 'reservation', maxMutationDurationMs: 30_000 });
    try {
      const prep = prepareTurnOwnedReviewDispatch(prepInput(cwd, loopId));
      assert.equal(prep.kind, 'denied', 'an indeterminate reserve must fail closed, never legacy');
      if (prep.kind === 'denied') assert.match(prep.reason, /indeterminate|fail-closed/);
    } finally {
      held.release();
    }
  });
});
