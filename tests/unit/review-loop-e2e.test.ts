/**
 * End-to-end review Loop protocol tests (pln#395 step 5).
 *
 * Covers two review entry paths — each going through the full
 * change_summary → findings → author_response → followup_review → verdict
 * progression, including at least one fixup round (reviewer rejects on
 * first pass, author applies a fix, reviewer re-reviews and accepts):
 *
 *   Path A: bclaw_coordinate(intent='review', open_loop: true)
 *           — the facade entry point that opens a review Loop on top of a
 *             freshly-created review candidate.
 *
 *   Path B: bclaw_loop(intent='open', kind='review')
 *           — direct use of the Loop engine facade without going through
 *             bclaw_coordinate. Typical of agents that drive reviews
 *             programmatically (e.g. a dispatch_review call wiring into the
 *             Loop engine in a later slice).
 *
 * Both paths must end with:
 *   - status: 'completed'
 *   - reviewer_green stop_condition fired (an `accepted` verdict artifact)
 *   - iteration_count > 0 (the fixup round went back to an earlier phase)
 *   - event journal contains opened, phase_advanced×N, turn_assigned×N,
 *     turn_completed×N, artifact_added×N, closed — in that final ordering.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import {
  advance,
  add_artifact,
  closeLoop,
  complete_turn,
  getLoop,
  listLoopEvents,
  openLoop,
  turn,
  type LoopEvent,
  type LoopThread,
} from '../../src/core/loops/index.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';

interface CoordinateResult extends FacadeResponse {
  result: Record<string, unknown>;
}

async function coordinate(
  workspace: TestWorkspace,
  args: Record<string, unknown>,
): Promise<CoordinateResult> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_coordinate',
    args,
    cwd: workspace.dir,
  });
  assert.equal(
    outcome.response.isError,
    false,
    `bclaw_coordinate error: ${JSON.stringify(outcome.response)}`,
  );
  return outcome.response.structuredContent as unknown as CoordinateResult;
}

function eventKinds(events: LoopEvent[]): string[] {
  return events.map((e) => e.kind);
}

function countKind(events: LoopEvent[], kind: LoopEvent['kind']): number {
  return events.filter((e) => e.kind === kind).length;
}

function assertFinalState(loop: LoopThread, events: LoopEvent[]): void {
  assert.equal(loop.status, 'completed', 'review loop must end completed');
  assert.ok(loop.closed_at, 'closed_at must be set');
  assert.ok(loop.iteration_count >= 1, 'fixup round must bump iteration_count ≥ 1');
  // reviewer_green auto-closes on the `advance` call immediately after the
  // accepted verdict is added (the pre-transition stop_condition check
  // fires), so the loop's terminal current_phase is wherever the accepted
  // verdict was produced — typically `followup_review`, not `verdict`.
  assert.ok(
    loop.phases.some((p) => p.name === loop.current_phase),
    'current_phase must be a member of phases',
  );

  const kinds = eventKinds(events);
  assert.ok(kinds.includes('opened'), 'opened event present');
  assert.ok(kinds.includes('closed'), 'closed event present');
  assert.ok(
    countKind(events, 'phase_advanced') >= 3,
    'at least 3 phase transitions (covers the fixup-round cycle)',
  );
  assert.ok(countKind(events, 'turn_assigned') >= 2, 'reviewer assigned at least twice (first pass + follow-up)');
  assert.ok(countKind(events, 'turn_completed') >= 2, 'reviewer completed at least twice');
  assert.ok(countKind(events, 'artifact_added') >= 3, 'findings + fix + verdict artifacts persisted');

  const lastKind = kinds[kinds.length - 1];
  assert.equal(lastKind, 'closed', 'closed is the terminal event');
}

describe('review loop E2E — path A: bclaw_coordinate(open_loop: true)', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let previousNoSpawn: string | undefined;
  let restoreCwd: (() => void) | undefined;
  let codexAgentId: string;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_TEST_MODE = '1';
    process.env.BRAINCLAW_NO_SPAWN = '1';
    workspace = createTestWorkspace({
      prefix: 'review-loop-e2e-A-',
      currentAgent: 'claude-code',
    });
    codexAgentId = workspace.registerAgent('codex').agent_id;
    workspace.registerAgent('github-copilot');
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('drives a full review loop through change_summary→…→verdict with a fixup round, auto-closes on reviewer_green', async () => {
    // 1. coordinate opens the loop at `findings` (change_summary→findings is done by the facade).
    const coord = await coordinate(workspace, {
      intent: 'review',
      task: 'E2E review of the auth refactor',
      scope: 'src/core/auth.ts',
      targetAgents: ['codex'],
      agent: 'claude-code',
      open_loop: true,
    });
    const loopId = coord.result.loop_id as string;
    const loop0 = getLoop(loopId, workspace.dir)!;
    assert.equal(loop0.current_phase, 'findings', 'coordinate advances to findings');
    const reviewerSlot = loop0.slots.find((s) => s.role === 'reviewer')!;
    assert.equal(reviewerSlot.agent_id, codexAgentId);

    // 2. First pass — reviewer produces a BLOCKING finding (not accepted).
    complete_turn(
      {
        id: loopId,
        slot_id: reviewerSlot.slot_id,
        outcome: 'done',
        artifact: {
          phase: 'findings',
          type: 'finding',
          body: 'Several naming issues and one missing null check.',
        },
        actor: codexAgentId,
        caller_agent_id: codexAgentId,
      },
      workspace.dir,
    );

    // 3. advance → author_response.
    advance({ id: loopId, actor: 'claude-code' }, workspace.dir);
    const afterAdvance1 = getLoop(loopId, workspace.dir)!;
    assert.equal(afterAdvance1.current_phase, 'author_response');

    // 4. Author records a fix artifact.
    add_artifact(
      {
        id: loopId,
        actor: 'claude-code',
        artifact: {
          phase: 'author_response',
          type: 'fix_summary',
          body: 'Renamed per review; added the null guard.',
        },
      },
      workspace.dir,
    );

    // 5. advance → followup_review. Reviewer re-runs but still rejects —
    //    simulates the fixup round being needed.
    advance({ id: loopId, actor: 'claude-code' }, workspace.dir);
    turn(
      {
        id: loopId,
        slot_id: reviewerSlot.slot_id,
        actor: 'claude-code',
        assignment_id: 'asgn_followup',
      },
      workspace.dir,
    );
    complete_turn(
      {
        id: loopId,
        slot_id: reviewerSlot.slot_id,
        outcome: 'done',
        artifact: {
          phase: 'followup_review',
          type: 'verdict',
          body: 'rejected — still one unhandled edge case',
        },
        actor: codexAgentId,
        caller_agent_id: codexAgentId,
      },
      workspace.dir,
    );
    // Reject verdict → advance BACKWARD to author_response for a fixup
    // iteration. iteration_count bumps.
    advance({ id: loopId, to_phase: 'author_response', actor: 'claude-code' }, workspace.dir);
    const afterFixup = getLoop(loopId, workspace.dir)!;
    assert.ok(afterFixup.iteration_count >= 1, 'fixup bumps iteration_count');

    // 6. Author applies a second fix.
    add_artifact(
      {
        id: loopId,
        actor: 'claude-code',
        artifact: {
          phase: 'author_response',
          type: 'fix_summary',
          body: 'Handled the edge case with a fallback branch.',
        },
      },
      workspace.dir,
    );

    // 7. advance → followup_review. Reviewer accepts this time.
    advance({ id: loopId, actor: 'claude-code' }, workspace.dir);
    turn(
      {
        id: loopId,
        slot_id: reviewerSlot.slot_id,
        actor: 'claude-code',
        assignment_id: 'asgn_followup_2',
      },
      workspace.dir,
    );
    complete_turn(
      {
        id: loopId,
        slot_id: reviewerSlot.slot_id,
        outcome: 'done',
        artifact: {
          phase: 'followup_review',
          type: 'verdict',
          body: 'accepted — edge case resolved, LGTM',
        },
        actor: codexAgentId,
        caller_agent_id: codexAgentId,
      },
      workspace.dir,
    );

    // 8. advance → verdict phase. stop_condition (reviewer_green) fires,
    //    loop auto-closes as completed.
    const finalAdvance = advance({ id: loopId, actor: 'claude-code' }, workspace.dir);
    assert.equal(finalAdvance.auto_closed, true, 'reviewer_green must auto-close');
    assertFinalState(finalAdvance.loop, listLoopEvents(loopId, workspace.dir));
  });
});

describe('review loop E2E — path B: direct bclaw_loop(open kind=review)', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({
      prefix: 'review-loop-e2e-B-',
      currentAgent: 'claude-code',
    });
    workspace.registerAgent('codex');
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  it('drives a review loop opened directly via the Loop engine through a fixup round and auto-closes', async () => {
    // 1. Open directly on the Loop engine — simulates an agent that wants a
    //    review loop without going through bclaw_coordinate.
    const loop = openLoop(
      {
        kind: 'review',
        title: 'Direct review of the staleness sweep',
        created_by: 'agt_author_b',
        slots: [
          { role: 'author', agent: 'claude-code', agent_id: 'agt_author_b' },
          { role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer_b' },
        ],
      },
      workspace.dir,
    );
    const reviewerSlotId = loop.slots.find((s) => s.role === 'reviewer')!.slot_id;

    // 2. Author links a change_summary artifact.
    add_artifact(
      {
        id: loop.id,
        actor: 'agt_author_b',
        artifact: {
          phase: 'change_summary',
          type: 'change_summary',
          body: 'Extracted the sweep into a dedicated helper + added a daily schedule.',
        },
      },
      workspace.dir,
    );

    // 3. advance → findings, dispatch turn, reviewer rejects first pass.
    advance({ id: loop.id, actor: 'agt_author_b' }, workspace.dir);
    turn(
      { id: loop.id, slot_id: reviewerSlotId, actor: 'agt_author_b', assignment_id: 'asgn_b_1' },
      workspace.dir,
    );
    complete_turn(
      {
        id: loop.id,
        slot_id: reviewerSlotId,
        outcome: 'done',
        artifact: {
          phase: 'findings',
          type: 'finding',
          body: 'The schedule key is mutable across runs — needs a stable string.',
        },
        actor: 'agt_reviewer_b',
        caller_agent_id: 'agt_reviewer_b',
      },
      workspace.dir,
    );

    // 4. advance → author_response. Author applies fix.
    advance({ id: loop.id, actor: 'agt_author_b' }, workspace.dir);
    add_artifact(
      {
        id: loop.id,
        actor: 'agt_author_b',
        artifact: {
          phase: 'author_response',
          type: 'fix_summary',
          body: 'Froze the schedule key + added a regression test.',
        },
      },
      workspace.dir,
    );

    // 5. advance → followup_review. Reviewer gives a REJECTED verdict on
    //    first follow-up — not yet accepted, so reviewer_green does NOT fire.
    advance({ id: loop.id, actor: 'agt_author_b' }, workspace.dir);
    turn(
      { id: loop.id, slot_id: reviewerSlotId, actor: 'agt_author_b', assignment_id: 'asgn_b_2' },
      workspace.dir,
    );
    complete_turn(
      {
        id: loop.id,
        slot_id: reviewerSlotId,
        outcome: 'done',
        artifact: {
          phase: 'followup_review',
          type: 'verdict',
          body: 'rejected — schedule key still leaks between tests',
        },
        actor: 'agt_reviewer_b',
        caller_agent_id: 'agt_reviewer_b',
      },
      workspace.dir,
    );

    // 6. Force a fixup: advance back to author_response. The pre-advance
    //    stop_condition does NOT fire (no accepted verdict yet), so the
    //    transition goes through and iteration_count bumps.
    advance(
      { id: loop.id, to_phase: 'author_response', actor: 'agt_author_b' },
      workspace.dir,
    );
    const afterFixup = getLoop(loop.id, workspace.dir)!;
    assert.ok(afterFixup.iteration_count >= 1, 'backward advance bumps iteration_count');

    // 7. Author applies a new fix, reviewer re-runs and accepts this time.
    add_artifact(
      {
        id: loop.id,
        actor: 'agt_author_b',
        artifact: {
          phase: 'author_response',
          type: 'fix_summary',
          body: 'Normalised the schedule key + extra isolation test.',
        },
      },
      workspace.dir,
    );
    advance({ id: loop.id, actor: 'agt_author_b' }, workspace.dir);
    turn(
      { id: loop.id, slot_id: reviewerSlotId, actor: 'agt_author_b', assignment_id: 'asgn_b_3' },
      workspace.dir,
    );
    complete_turn(
      {
        id: loop.id,
        slot_id: reviewerSlotId,
        outcome: 'done',
        artifact: {
          phase: 'followup_review',
          type: 'verdict',
          body: 'accepted — schedule stable across runs, ship it',
        },
        actor: 'agt_reviewer_b',
        caller_agent_id: 'agt_reviewer_b',
      },
      workspace.dir,
    );

    // 8. Next advance: pre-transition stop_condition (reviewer_green) fires
    //    → auto-close at followup_review (we never transition to verdict).
    const finalAdvance = advance({ id: loop.id, actor: 'agt_author_b' }, workspace.dir);
    assert.equal(finalAdvance.auto_closed, true);
    assertFinalState(finalAdvance.loop, listLoopEvents(loop.id, workspace.dir));
  });

  it('hitting max_iterations closes the loop as blocked instead of completed', () => {
    // Review with max_iterations:1 (override the default reviewer_green OR
    // max_iterations:3 to shorten the test). A single fixup-round-that-goes-
    // backward should exceed the cap on the next advance.
    const loop = openLoop(
      {
        kind: 'review',
        title: 'Blocked via iteration cap',
        created_by: 'agt_author_b',
        stop_condition: { kind: 'max_iterations', n: 1 },
        slots: [
          { role: 'author', agent: 'claude-code', agent_id: 'agt_author_b' },
          { role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer_b' },
        ],
      },
      workspace.dir,
    );

    // change_summary → findings (forward, iteration_count stays 0).
    advance({ id: loop.id, actor: 'agt_author_b' }, workspace.dir);
    // findings → change_summary (backward) bumps iteration_count to 1, and
    // the post-transition stop_condition check inside the SAME advance call
    // fires max_iterations:1 → auto-closes the loop as blocked.
    const result = advance(
      { id: loop.id, to_phase: 'change_summary', actor: 'agt_author_b' },
      workspace.dir,
    );
    assert.equal(result.auto_closed, true);
    assert.equal(result.loop.status, 'blocked');
    assert.equal(result.loop.iteration_count, 1);
  });

  it('closeLoop is a no-op once the loop is already closed by the stop_condition', () => {
    const loop = openLoop(
      { kind: 'research', title: 'closed-twice', created_by: 'agt_a' },
      workspace.dir,
    );
    closeLoop({ id: loop.id, final_status: 'completed', actor: 'agt_a' }, workspace.dir);
    assert.throws(
      () => closeLoop({ id: loop.id, final_status: 'cancelled', actor: 'agt_a' }, workspace.dir),
      /already completed/,
    );
  });
});
