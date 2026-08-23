import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { listAgentRuns, loadAgentRun } from '../../src/core/agentruns.js';
import { loadAssignment } from '../../src/core/assignments.js';
import { saveClaim } from '../../src/core/claims.js';
import {
  deriveChildIds,
  deriveTurnId,
  getReservation,
  launchGrant,
} from '../../src/core/loops/attempt-reservation.js';
import { getLoop, listLoopEvents, openLoop } from '../../src/core/loops/store.js';
import {
  dispatchReviewLoopTurn,
  prepareTurnOwnedReviewDispatch,
  type DispatchReviewLoopTurnInput,
  type PrepareTurnOwnedReviewInput,
  type TurnProjectionFaultPoint,
} from '../../src/core/review-loop-turn-dispatch.js';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function temporaryProject(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-review-replay-'));
  cleanup.push(cwd);
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# crash replay fixture\n');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'fixture@brainclaw.dev'],
    ['config', 'user.name', 'Brainclaw Fixture'],
    ['add', 'README.md'],
    ['commit', '-m', 'fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }
  return cwd;
}

function reviewLoop(cwd: string) {
  return openLoop({
    kind: 'review',
    title: 'P0B crash replay proof',
    created_by: 'coordinator',
    mode: 'symmetric',
    phases: [{ name: 'findings' }],
    slots: [{ slot_id: 'lsl_reviewer', role: 'reviewer', agent: 'codex' }],
  }, cwd);
}

function oneShotFault(point: TurnProjectionFaultPoint): (seen: TurnProjectionFaultPoint) => void {
  let fired = false;
  return (seen) => {
    if (!fired && seen === point) {
      fired = true;
      throw new Error(`p0b-crash:${point}`);
    }
  };
}

function prepareFixture(cwd: string): {
  input: PrepareTurnOwnedReviewInput;
  turnId: string;
  assignmentId: string;
  runId: string;
} {
  const loop = reviewLoop(cwd);
  const slotId = loop.slots[0]!.slot_id;
  const turnId = deriveTurnId(loop.id, slotId, 0);
  const children = deriveChildIds(turnId);
  const claimId = 'clm_crash_replay';
  const scope = `review-loop:${loop.id}`;
  saveClaim({
    schema_version: 2,
    id: claimId,
    agent: 'codex',
    scope,
    description: 'P0B crash replay',
    created_at: new Date().toISOString(),
    status: 'active',
  }, cwd);
  return {
    turnId,
    assignmentId: children.assignment_id,
    runId: children.run_id,
    input: {
      loopId: loop.id,
      slotId,
      agent: 'codex',
      phase: 'findings',
      task: 'review crash boundaries',
      description: 'P0B crash replay',
      scope,
      claimId,
      worktreePath: path.join(cwd, 'prepared-worktree'),
      dispatcherAgent: 'coordinator',
      isReviewer: true,
      cwd,
    },
  };
}

function assertSingleCompleteProjection(
  cwd: string,
  loopId: string,
  slotId: string,
  turnId: string,
  assignmentId: string,
  runId: string,
): void {
  assert.equal(loadAssignment(assignmentId, cwd)?.id, assignmentId);
  assert.equal(loadAgentRun(runId, cwd)?.assignment_id, assignmentId);
  assert.equal(listAgentRuns(cwd, { assignment_id: assignmentId }).length, 1);
  const slot = getLoop(loopId, cwd)!.slots.find((candidate) => candidate.slot_id === slotId)!;
  assert.equal(slot.current_turn_id, turnId);
  assert.equal(slot.assignment_id, assignmentId);
  assert.equal(
    listLoopEvents(loopId, cwd).filter((event) => event.kind === 'turn_assigned').length,
    1,
  );
}

describe('P0B review dispatch crash/replay evidence', () => {
  for (const point of ['after_reservation', 'after_commit'] as const) {
    it(`${point}: an identical replay repairs the same authority and projections`, () => {
      const cwd = temporaryProject();
      const fixture = prepareFixture(cwd);
      const crashed = prepareTurnOwnedReviewDispatch({
        ...fixture.input,
        faultInjector: oneShotFault(point),
      });
      assert.equal(crashed.kind, 'denied');
      assert.equal(getReservation(fixture.turnId, cwd)?.claim_id, fixture.input.claimId);
      assert.equal(
        getReservation(fixture.turnId, cwd)?.decision,
        point === 'after_reservation' ? 'prepared' : 'committed',
      );

      const replay = prepareTurnOwnedReviewDispatch(fixture.input);
      assert.equal(replay.kind, 'won');
      if (replay.kind !== 'won') return;
      assert.equal(replay.assignmentId, fixture.assignmentId);
      assert.equal(replay.runId, fixture.runId);
      assert.equal(launchGrant(fixture.turnId, cwd)?.status, 'crossed');
      assertSingleCompleteProjection(
        cwd,
        fixture.input.loopId,
        fixture.input.slotId,
        fixture.turnId,
        fixture.assignmentId,
        fixture.runId,
      );
    });
  }

  for (const point of ['after_consume', 'after_spawn'] as const) {
    it(`${point}: replay never double-spawns and exposes crossed_unknown without signals`, async () => {
      const cwd = temporaryProject();
      const loop = reviewLoop(cwd);
      const slot = loop.slots[0]!;
      let spawnCalls = 0;
      const executionAttempt: NonNullable<DispatchReviewLoopTurnInput['executionAttempt']> = async () => {
        spawnCalls += 1;
        return {
          execution_status: 'delivered_and_started',
          pid: 4242,
          started_at: '2026-08-23T00:00:00.000Z',
        };
      };
      const input: DispatchReviewLoopTurnInput = {
        loopId: loop.id,
        slot,
        phase: 'findings',
        task: 'review crash boundary',
        dispatcherAgent: 'coordinator',
        cwd,
        executionAttempt,
      };

      const crashed = await dispatchReviewLoopTurn({
        ...input,
        faultInjector: oneShotFault(point),
      });
      if (crashed.worktree_path && !path.resolve(crashed.worktree_path).startsWith(path.resolve(cwd))) {
        cleanup.push(crashed.worktree_path);
      }
      assert.match(crashed.error ?? '', new RegExp(`p0b-crash:${point}`));
      assert.equal(spawnCalls, point === 'after_spawn' ? 1 : 0);

      const replay = await dispatchReviewLoopTurn(input);
      assert.equal(replay.execution_status, 'inbox_only');
      assert.equal(replay.authority_state, 'crossed_unknown');
      assert.equal(replay.needs_operator, true);
      assert.equal(spawnCalls, point === 'after_spawn' ? 1 : 0, 'replay must not call execution again');

      const turnId = deriveTurnId(loop.id, slot.slot_id, 0);
      const children = deriveChildIds(turnId);
      assert.equal(launchGrant(turnId, cwd)?.status, 'crossed');
      assertSingleCompleteProjection(
        cwd,
        loop.id,
        slot.slot_id,
        turnId,
        children.assignment_id,
        children.run_id,
      );
    });
  }
});
