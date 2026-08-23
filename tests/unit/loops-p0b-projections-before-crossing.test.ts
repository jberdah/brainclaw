/**
 * P0B — projections-before-crossing fault matrix (pln#677 / dec#171).
 *
 * Every crash before consume must leave the grant armed and repairable; a crash
 * after consume must leave complete projections and never regain spawn authority.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAssignment, ensureAssignmentProjection, loadAssignment } from '../../src/core/assignments.js';
import { createAgentRun, ensureAgentRunProjection, listAgentRuns, loadAgentRun } from '../../src/core/agentruns.js';
import {
  ClaimAssignmentConflictError,
  ensureClaimAssignmentBinding,
  loadClaim,
  saveClaim,
} from '../../src/core/claims.js';
import {
  consumeLaunchGrant,
  consumeLaunchGrantWithProjection,
  deriveChildIds,
  deriveTurnId,
  getReservation,
  launchGrant,
} from '../../src/core/loops/attempt-reservation.js';
import { listLoopEvents, openLoop, getLoop } from '../../src/core/loops/store.js';
import { bindTurnProjection, TurnProjectionConflictError } from '../../src/core/loops/verbs.js';
import {
  prepareTurnOwnedReviewDispatch,
  type PrepareTurnOwnedReviewInput,
  type TurnProjectionFaultPoint,
} from '../../src/core/review-loop-turn-dispatch.js';

const CLAIM_ID = 'clm_p0b';
const AGENT = 'codex';

function makeWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-p0b-'));
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  return cwd;
}

interface Fixture {
  cwd: string;
  loopId: string;
  slotId: string;
  turnId: string;
  assignmentId: string;
  runId: string;
  input: PrepareTurnOwnedReviewInput;
}

function fixture(cwd: string): Fixture {
  const loop = openLoop({
    kind: 'review', title: 'P0B projection order', created_by: 'coordinator', mode: 'symmetric',
    phases: [{ name: 'findings' }], slots: [{ role: 'reviewer', agent: AGENT }],
  }, cwd);
  const slotId = loop.slots[0].slot_id;
  const turnId = deriveTurnId(loop.id, slotId, 0);
  const children = deriveChildIds(turnId);
  saveClaim({
    schema_version: 2, id: CLAIM_ID, agent: AGENT, scope: `review-loop:${loop.id}`,
    description: 'P0B turn', created_at: new Date().toISOString(), status: 'active',
  }, cwd);
  return {
    cwd, loopId: loop.id, slotId, turnId,
    assignmentId: children.assignment_id, runId: children.run_id,
    input: {
      loopId: loop.id, slotId, agent: AGENT, phase: 'findings', task: 'review P0B',
      description: 'P0B turn', scope: `review-loop:${loop.id}`, claimId: CLAIM_ID,
      agentId: 'agt_p0b', worktreePath: path.join(cwd, 'wt'),
      dispatcherAgent: 'coordinator', isReviewer: true, cwd,
    },
  };
}

function oneShotFault(point: TurnProjectionFaultPoint): (seen: TurnProjectionFaultPoint) => void {
  let fired = false;
  return (seen) => {
    if (!fired && seen === point) {
      fired = true;
      throw new Error(`p0b-fault:${point}`);
    }
  };
}

function turnEvents(f: Fixture): number {
  return listLoopEvents(f.loopId, f.cwd).filter((event) => event.kind === 'turn_assigned').length;
}

function assertCompleteProjection(f: Fixture): void {
  const assignment = loadAssignment(f.assignmentId, f.cwd);
  const run = loadAgentRun(f.runId, f.cwd);
  const claim = loadClaim(CLAIM_ID, f.cwd);
  const slot = getLoop(f.loopId, f.cwd)?.slots.find((candidate) => candidate.slot_id === f.slotId);
  assert.equal(assignment?.claim_id, CLAIM_ID);
  assert.equal(run?.assignment_id, f.assignmentId);
  assert.equal(run?.claim_id, CLAIM_ID);
  assert.equal(run?.attempt_index, 1);
  assert.equal(claim.assignment_id, f.assignmentId);
  assert.equal(slot?.assignment_id, f.assignmentId);
  assert.equal(slot?.claim_id, CLAIM_ID);
  assert.equal(slot?.current_turn_id, f.turnId);
}

describe('P0B dispatch crash boundaries', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  for (const point of [
    'after_assignment', 'after_run', 'after_claim_binding', 'after_slot_binding', 'before_consume',
  ] as const satisfies readonly TurnProjectionFaultPoint[]) {
    it(`${point}: grant stays armed and identical replay repairs without duplicates`, () => {
      const f = fixture(cwd);
      const crashed = prepareTurnOwnedReviewDispatch({ ...f.input, faultInjector: oneShotFault(point) });
      assert.equal(crashed.kind, 'denied');
      if (crashed.kind === 'denied') assert.match(crashed.reason, new RegExp(`p0b-fault:${point}`));
      assert.equal(launchGrant(f.turnId, cwd)?.status, 'armed');

      const replay = prepareTurnOwnedReviewDispatch(f.input);
      assert.equal(replay.kind, 'won');
      assert.equal(launchGrant(f.turnId, cwd)?.status, 'crossed');
      assertCompleteProjection(f);
      assert.equal(listAgentRuns(cwd, { assignment_id: f.assignmentId }).length, 1);
      assert.equal(turnEvents(f), 1, 'slot replay must not duplicate turn_assigned');
    });
  }

  it('after_consume: complete projections survive, retry cannot regain spawn authority', () => {
    const f = fixture(cwd);
    const crashed = prepareTurnOwnedReviewDispatch({ ...f.input, faultInjector: oneShotFault('after_consume') });
    assert.equal(crashed.kind, 'denied');
    assert.equal(launchGrant(f.turnId, cwd)?.status, 'crossed');
    assertCompleteProjection(f);
    assert.equal(turnEvents(f), 1);

    const grant = launchGrant(f.turnId, cwd)!;
    assert.equal(consumeLaunchGrant(f.turnId, grant.token, grant.epoch, cwd).wonTransition, false);
    assert.equal(prepareTurnOwnedReviewDispatch(f.input).kind, 'denied');
    assert.equal(listAgentRuns(cwd, { assignment_id: f.assignmentId }).length, 1);
    assert.equal(turnEvents(f), 1);
  });

  it('an adopted reservation with a different caller claim fails closed before projections', () => {
    const f = fixture(cwd);
    assert.equal(prepareTurnOwnedReviewDispatch({
      ...f.input, faultInjector: oneShotFault('after_reservation'),
    }).kind, 'denied');
    saveClaim({
      schema_version: 2, id: 'clm_other', agent: AGENT, scope: f.input.scope,
      description: 'other caller', created_at: new Date().toISOString(), status: 'active',
    }, cwd);
    const mismatch = prepareTurnOwnedReviewDispatch({ ...f.input, claimId: 'clm_other' });
    assert.equal(mismatch.kind, 'denied');
    if (mismatch.kind === 'denied') assert.match(mismatch.reason, /claim mismatch/);
    // P0C strict immutable adoption: a foreign claim cannot commit/arm the
    // owner's prepared reservation merely by retrying the same turn id.
    assert.equal(getReservation(f.turnId, cwd)?.decision, 'prepared');
    assert.equal(launchGrant(f.turnId, cwd), undefined);
    assert.equal(loadAssignment(f.assignmentId, cwd), undefined);
    assert.equal(loadAgentRun(f.runId, cwd), undefined);
    assert.equal(turnEvents(f), 0);
  });
});

describe('P0B create-or-validate projections', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('Assignment and AgentRun helpers are idempotent and preserve one deterministic run', () => {
    const f = fixture(cwd);
    const assignmentOptions = {
      id: f.assignmentId, short_label: f.assignmentId, claim_id: CLAIM_ID, agent: AGENT,
      dispatcher_agent: 'coordinator', scope: f.input.scope, description: f.input.description,
      tags: ['coordinate', 'review', 'loop', 'turn-owned', 're-review'],
    };
    assert.equal(ensureAssignmentProjection(assignmentOptions, cwd).created, true);
    assert.equal(ensureAssignmentProjection(assignmentOptions, cwd).created, false);
    const enrichedAssignment = ensureAssignmentProjection({
      ...assignmentOptions,
      tags: [...assignmentOptions.tags, 'projection-repair'],
    }, cwd);
    assert.equal(enrichedAssignment.created, false);
    assert.equal(enrichedAssignment.repaired, true);
    assert.ok(enrichedAssignment.assignment.tags.includes('projection-repair'));
    const runOptions = {
      id: f.runId, short_label: f.runId, assignment_id: f.assignmentId, claim_id: CLAIM_ID,
      attempt_index: 1, agent: AGENT, transport: 'cli_spawn' as const, status: 'created' as const,
      scope: f.input.scope, description: f.input.description, worktree_path: f.input.worktreePath,
      tags: ['turn-owned', 'review', 'loop'],
    };
    assert.equal(ensureAgentRunProjection(runOptions, cwd).created, true);
    assert.equal(ensureAgentRunProjection(runOptions, cwd).created, false);
    assert.equal(listAgentRuns(cwd, { assignment_id: f.assignmentId }).length, 1);
  });

  it('preserves an explicit physical generation index for AttemptAuthority v2', () => {
    const f = fixture(cwd);
    const generationRunId = `${f.runId}_g2`;
    const options = {
      id: generationRunId,
      short_label: generationRunId,
      assignment_id: f.assignmentId,
      claim_id: CLAIM_ID,
      attempt_index: 2,
      agent: AGENT,
      agent_id: f.input.agentId,
      transport: 'cli_spawn' as const,
      status: 'created' as const,
      scope: f.input.scope,
      description: f.input.description,
      worktree_path: f.input.worktreePath,
      tags: ['turn-owned', 'loop', 'attempt-generation:2'],
    };

    assert.equal(ensureAgentRunProjection(options, cwd).run.attempt_index, 2);
    assert.equal(ensureAgentRunProjection(options, cwd).run.attempt_index, 2);
  });

  it('adopts and enriches a pre-P0B Assignment that omitted agent_id', () => {
    const f = fixture(cwd);
    const legacyOptions = {
      id: f.assignmentId, short_label: f.assignmentId, claim_id: CLAIM_ID, agent: AGENT,
      dispatcher_agent: 'coordinator', scope: f.input.scope, description: f.input.description,
      tags: ['coordinate', 'review', 'loop', 'turn-owned', 're-review'],
    };
    createAssignment(legacyOptions, cwd);
    assert.equal(loadAssignment(f.assignmentId, cwd)?.agent_id, undefined);

    const repaired = ensureAssignmentProjection({ ...legacyOptions, agent_id: f.input.agentId }, cwd);
    assert.equal(repaired.created, false);
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.assignment.agent_id, f.input.agentId);
  });

  it('rejects a terminal deterministic AgentRun instead of resurrecting it', () => {
    const f = fixture(cwd);
    const options = {
      id: f.runId, short_label: f.runId, assignment_id: f.assignmentId, claim_id: CLAIM_ID,
      attempt_index: 1, agent: AGENT, agent_id: f.input.agentId, transport: 'cli_spawn' as const,
      status: 'cancelled' as const, status_reason: 'reserved_never_launched: legacy terminal',
      scope: f.input.scope, description: f.input.description, worktree_path: f.input.worktreePath,
      tags: ['turn-owned', 'review', 'loop'],
    };
    createAgentRun(options, cwd);
    assert.throws(
      () => ensureAgentRunProjection({ ...options, status: 'created' as const }, cwd),
      /AgentRun projection conflict/,
    );
    assert.equal(loadAgentRun(f.runId, cwd)?.status, 'cancelled');
  });

  it('claim binding is idempotent and rejects a live conflicting assignment', () => {
    const f = fixture(cwd);
    ensureClaimAssignmentBinding(CLAIM_ID, f.assignmentId, cwd);
    ensureClaimAssignmentBinding(CLAIM_ID, f.assignmentId, cwd);
    assert.equal(loadClaim(CLAIM_ID, cwd).assignment_id, f.assignmentId);
    assert.throws(() => ensureClaimAssignmentBinding(CLAIM_ID, 'asgn_hijack', cwd), ClaimAssignmentConflictError);
  });

  it('slot binding is idempotent and rejects a divergent tuple for the same turn', () => {
    const f = fixture(cwd);
    const bind = {
      id: f.loopId, slot_id: f.slotId, turn_id: f.turnId, assignment_id: f.assignmentId,
      claim_id: CLAIM_ID, actor: 'coordinator', input: f.input.task,
    };
    bindTurnProjection(bind, cwd);
    bindTurnProjection(bind, cwd);
    assert.equal(turnEvents(f), 1);
    assert.throws(() => bindTurnProjection({ ...bind, claim_id: 'clm_hijack' }, cwd), TurnProjectionConflictError);
  });

  it('a conflicting deterministic Assignment is never overwritten', () => {
    const f = fixture(cwd);
    const options = {
      id: f.assignmentId, short_label: f.assignmentId, claim_id: 'clm_hijack', agent: AGENT,
      dispatcher_agent: 'coordinator', scope: f.input.scope, description: f.input.description,
      tags: ['coordinate', 'review', 'loop', 'turn-owned', 're-review'],
    };
    createAssignment(options, cwd);
    assert.throws(() => ensureAssignmentProjection({ ...options, claim_id: CLAIM_ID }, cwd), /Assignment projection conflict/);
    assert.equal(loadAssignment(f.assignmentId, cwd)?.claim_id, 'clm_hijack');
  });

  it('generic projection callback runs before crossed CAS and a replay is adopted', () => {
    const f = fixture(cwd);
    assert.equal(prepareTurnOwnedReviewDispatch({
      ...f.input, faultInjector: oneShotFault('after_arm'),
    }).kind, 'denied');
    const grant = launchGrant(f.turnId, cwd)!;
    let projected = 0;
    const first = consumeLaunchGrantWithProjection(
      f.turnId, grant.token, grant.epoch, () => { projected += 1; }, cwd,
    );
    assert.equal(first.wonTransition, true);
    const replay = consumeLaunchGrantWithProjection(
      f.turnId, grant.token, grant.epoch, () => { projected += 1; }, cwd,
    );
    assert.equal(replay.wonTransition, false);
    assert.equal(projected, 1, 'an already-crossed replay must not rerun projection side effects');
  });
});
