import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  add_artifact,
  advance,
  closeLoop,
  complete_turn,
  evaluateStopCondition,
  getLoop,
  listLoopEvents,
  openLoop,
  pause,
  provideInput,
  requestInput,
  resume,
  turn,
  type LoopThread,
} from '../../src/core/loops/index.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loops-verbs-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function openReview(cwd: string): LoopThread {
  return openLoop(
    {
      kind: 'review',
      title: 'verbs review',
      created_by: 'agt_test',
      slots: [
        { role: 'author', agent: 'claude-code', agent_id: 'agt_author' },
        { role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer' },
      ],
    },
    cwd,
  );
}

describe('loops verbs — advance', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('transitions to the next phase and records phase_advanced event', () => {
    const loop = openReview(cwd);
    const result = advance({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(result.auto_closed, false);
    assert.equal(result.loop.current_phase, 'findings');
    assert.equal(result.loop.version, loop.version + 1);

    const events = listLoopEvents(loop.id, cwd);
    const last = events[events.length - 1];
    assert.equal(last.kind, 'phase_advanced');
    if (last.kind === 'phase_advanced') {
      assert.equal(last.from_phase, 'change_summary');
      assert.equal(last.to_phase, 'findings');
    }
  });

  it('jumps to a specified to_phase when provided', () => {
    const loop = openReview(cwd);
    const result = advance({ id: loop.id, to_phase: 'verdict', actor: 'agt_test' }, cwd);
    assert.equal(result.loop.current_phase, 'verdict');
  });

  it('throws when already at the last phase', () => {
    const loop = openLoop(
      { kind: 'review', title: 'at-end', created_by: 'agt_test' },
      cwd,
    );
    // Walk to the last phase.
    advance({ id: loop.id, to_phase: 'verdict', actor: 'agt_test' }, cwd);
    assert.throws(
      () => advance({ id: loop.id, actor: 'agt_test' }, cwd),
      /already at last phase/,
    );
  });

  it('auto-closes as completed when reviewer_green fires after adding a verdict', () => {
    const loop = openReview(cwd);
    add_artifact(
      {
        id: loop.id,
        actor: 'agt_reviewer',
        artifact: { phase: 'verdict', type: 'verdict', body: 'accepted' },
      },
      cwd,
    );
    const result = advance({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(result.auto_closed, true);
    assert.equal(result.loop.status, 'completed');
    assert.ok(result.loop.closed_at);
  });

  it('auto-closes as blocked when max_iterations is reached', () => {
    const loop = openLoop(
      {
        kind: 'review',
        title: 'capped',
        created_by: 'agt_test',
        stop_condition: { kind: 'max_iterations', n: 1 },
      },
      cwd,
    );
    // Walk to findings then loop back to change_summary — that bumps iteration_count.
    advance({ id: loop.id, to_phase: 'findings', actor: 'agt_test' }, cwd);
    const result = advance({ id: loop.id, to_phase: 'change_summary', actor: 'agt_test' }, cwd);
    assert.equal(result.auto_closed, true);
    assert.equal(result.loop.status, 'blocked');
  });
});

describe('loops verbs — turn / complete_turn', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('turn flips a slot to assigned and records the phase', () => {
    const loop = openReview(cwd);
    const reviewerSlotId = loop.slots.find((s) => s.role === 'reviewer')!.slot_id;
    const next = turn(
      { id: loop.id, slot_id: reviewerSlotId, assignment_id: 'asg_xyz', actor: 'agt_test' },
      cwd,
    );
    const slot = next.slots.find((s) => s.slot_id === reviewerSlotId)!;
    assert.equal(slot.status, 'assigned');
    assert.equal(slot.assignment_id, 'asg_xyz');
    assert.equal(slot.phase, 'change_summary');

    const events = listLoopEvents(loop.id, cwd);
    const last = events[events.length - 1];
    assert.equal(last.kind, 'turn_assigned');
  });

  it('complete_turn flips slot to done and attaches an artifact', () => {
    const loop = openReview(cwd);
    const reviewerSlotId = loop.slots.find((s) => s.role === 'reviewer')!.slot_id;
    turn({ id: loop.id, slot_id: reviewerSlotId, actor: 'agt_test' }, cwd);
    const next = complete_turn(
      {
        id: loop.id,
        slot_id: reviewerSlotId,
        outcome: 'done',
        artifact: { phase: 'findings', type: 'finding', body: 'LGTM' },
        actor: 'agt_reviewer',
      },
      cwd,
    );
    assert.equal(next.slots.find((s) => s.slot_id === reviewerSlotId)!.status, 'done');
    assert.equal(next.artifacts.length, 1);
    assert.equal(next.artifacts[0].type, 'finding');
  });

  it('complete_turn maps outcome=failed to slot.status=failed (residual #3)', () => {
    const loop = openReview(cwd);
    const reviewerSlotId = loop.slots.find((s) => s.role === 'reviewer')!.slot_id;
    turn({ id: loop.id, slot_id: reviewerSlotId, actor: 'agt_test' }, cwd);
    const next = complete_turn(
      {
        id: loop.id,
        slot_id: reviewerSlotId,
        outcome: 'failed',
        failure_reason: 'tool error',
        actor: 'agt_reviewer',
      },
      cwd,
    );
    assert.equal(next.slots.find((s) => s.slot_id === reviewerSlotId)!.status, 'failed');
  });

  it('complete_turn maps outcome=cancelled to slot.status=cancelled (residual #3)', () => {
    const loop = openReview(cwd);
    const reviewerSlotId = loop.slots.find((s) => s.role === 'reviewer')!.slot_id;
    turn({ id: loop.id, slot_id: reviewerSlotId, actor: 'agt_test' }, cwd);
    const next = complete_turn(
      {
        id: loop.id,
        slot_id: reviewerSlotId,
        outcome: 'cancelled',
        actor: 'agt_reviewer',
      },
      cwd,
    );
    assert.equal(next.slots.find((s) => s.slot_id === reviewerSlotId)!.status, 'cancelled');
  });

  it('complete_turn rejects caller that does not match slot owner (unless admin override)', () => {
    const loop = openReview(cwd);
    const reviewerSlotId = loop.slots.find((s) => s.role === 'reviewer')!.slot_id;
    turn({ id: loop.id, slot_id: reviewerSlotId, actor: 'agt_test' }, cwd);
    assert.throws(
      () =>
        complete_turn(
          {
            id: loop.id,
            slot_id: reviewerSlotId,
            outcome: 'done',
            actor: 'agt_impersonator',
            caller_agent_id: 'agt_impersonator',
          },
          cwd,
        ),
      /unauthorized_slot_write/,
    );
    // Admin override (loop creator) succeeds.
    assert.doesNotThrow(() =>
      complete_turn(
        {
          id: loop.id,
          slot_id: reviewerSlotId,
          outcome: 'done',
          actor: 'agt_test',
          caller_agent_id: 'agt_test',
        },
        cwd,
      ),
    );
  });

  it('complete_turn still rejects non-creator callers when the slot has no agent_id', () => {
    const loop = openLoop(
      {
        kind: 'review',
        title: 'ownerless-slot',
        created_by: 'agt_test',
        slots: [{ role: 'reviewer', agent: 'codex' }],
      },
      cwd,
    );
    const reviewerSlotId = loop.slots[0].slot_id;
    turn({ id: loop.id, slot_id: reviewerSlotId, actor: 'agt_test' }, cwd);

    assert.throws(
      () =>
        complete_turn(
          {
            id: loop.id,
            slot_id: reviewerSlotId,
            actor: 'agt_other',
            caller_agent_id: 'agt_other',
          },
          cwd,
        ),
      /unauthorized_slot_write/,
    );

    assert.doesNotThrow(() =>
      complete_turn(
        {
          id: loop.id,
          slot_id: reviewerSlotId,
          actor: 'agt_test',
          caller_agent_id: 'agt_test',
        },
        cwd,
      ),
    );
  });
});

describe('loops verbs — add_artifact / pause / resume', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('add_artifact appends and emits artifact_added event', () => {
    const loop = openReview(cwd);
    const next = add_artifact(
      {
        id: loop.id,
        actor: 'agt_test',
        artifact: { phase: 'change_summary', type: 'note', body: 'small doc' },
      },
      cwd,
    );
    assert.equal(next.artifacts.length, 1);
    assert.match(next.artifacts[0].artifact_id, /^art_/);
    const events = listLoopEvents(loop.id, cwd);
    assert.equal(events[events.length - 1].kind, 'artifact_added');
  });

  it('pause then resume round-trips status', () => {
    const loop = openReview(cwd);
    const paused = pause({ id: loop.id, actor: 'agt_test', reason: 'afk' }, cwd);
    assert.equal(paused.status, 'paused');
    const resumed = resume({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(resumed.status, 'open');
  });

  it('advance on a paused loop throws', () => {
    const loop = openReview(cwd);
    pause({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.throws(() => advance({ id: loop.id, actor: 'agt_test' }, cwd), /paused/);
  });
});

describe('loops — evaluateStopCondition', () => {
  const base: LoopThread = {
    schema_version: 1,
    id: 'lop_unit',
    version: 1,
    mutation_id: 'mut_unit',
    kind: 'review',
    title: 'unit',
    status: 'open',
    phases: [{ name: 'findings' }, { name: 'verdict' }],
    current_phase: 'findings',
    iteration_count: 0,
    open_questions: [],
    slots: [],
    artifacts: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'agt_test',
  };

  it('manual never fires', () => {
    assert.equal(evaluateStopCondition(base, { kind: 'manual' }), false);
  });

  it('phase_reached fires on exact match', () => {
    assert.equal(evaluateStopCondition(base, { kind: 'phase_reached', phase: 'findings' }), true);
    assert.equal(evaluateStopCondition(base, { kind: 'phase_reached', phase: 'verdict' }), false);
  });

  it('max_iterations fires when threshold met', () => {
    assert.equal(evaluateStopCondition({ ...base, iteration_count: 3 }, { kind: 'max_iterations', n: 3 }), true);
    assert.equal(evaluateStopCondition({ ...base, iteration_count: 2 }, { kind: 'max_iterations', n: 3 }), false);
  });

  it('reviewer_green fires on an accepted verdict artifact', () => {
    const withVerdict = {
      ...base,
      artifacts: [
        {
          artifact_id: 'art_1',
          phase: 'verdict',
          type: 'verdict',
          body: 'accepted',
          produced_at: new Date().toISOString(),
        },
      ],
    };
    assert.equal(evaluateStopCondition(withVerdict, { kind: 'reviewer_green' }), true);
  });

  it('reviewer_green does not fire for non-accepted verdict text', () => {
    const withVerdict = {
      ...base,
      artifacts: [
        {
          artifact_id: 'art_1',
          phase: 'verdict',
          type: 'verdict',
          body: 'approved',
          produced_at: new Date().toISOString(),
        },
      ],
    };
    assert.equal(evaluateStopCondition(withVerdict, { kind: 'reviewer_green' }), false);
  });

  it('any / all compose correctly', () => {
    const condition = {
      kind: 'any' as const,
      conditions: [{ kind: 'manual' as const }, { kind: 'phase_reached' as const, phase: 'findings' }],
    };
    assert.equal(evaluateStopCondition(base, condition), true);

    const all = {
      kind: 'all' as const,
      conditions: [{ kind: 'phase_reached' as const, phase: 'findings' }, { kind: 'manual' as const }],
    };
    assert.equal(evaluateStopCondition(base, all), false);
  });
});

describe('closeLoop interaction with verbs', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('cannot advance after close', () => {
    const loop = openReview(cwd);
    closeLoop({ id: loop.id, final_status: 'cancelled', actor: 'agt_test' }, cwd);
    assert.throws(() => advance({ id: loop.id, actor: 'agt_test' }, cwd), /already cancelled/);
  });

  it('getLoop sees the final closed state', () => {
    const loop = openReview(cwd);
    closeLoop({ id: loop.id, final_status: 'completed', actor: 'agt_test' }, cwd);
    const onDisk = getLoop(loop.id, cwd);
    assert.equal(onDisk?.status, 'completed');
  });
});

/* ============= pln#508 step 3 — FSM invariant regression coverage ========== */

describe('FSM invariant 1 — assertMutable refuses terminal loops on every mutating verb', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  function closedLoop(status: 'completed' | 'cancelled' | 'blocked'): LoopThread {
    const loop = openReview(cwd);
    closeLoop({ id: loop.id, final_status: status, actor: 'agt_test' }, cwd);
    return getLoop(loop.id, cwd)!;
  }

  it('advance refuses on completed', () => {
    const loop = closedLoop('completed');
    assert.throws(() => advance({ id: loop.id, actor: 'agt_test' }, cwd), /already completed/);
  });

  it('turn refuses on cancelled', () => {
    const loop = closedLoop('cancelled');
    assert.throws(
      () => turn({ id: loop.id, slot_id: loop.slots[0].slot_id, actor: 'agt_test' }, cwd),
      /already cancelled/,
    );
  });

  it('complete_turn refuses on blocked', () => {
    const loop = closedLoop('blocked');
    assert.throws(
      () =>
        complete_turn(
          { id: loop.id, slot_id: loop.slots[0].slot_id, outcome: 'done', actor: 'agt_test' },
          cwd,
        ),
      /already blocked/,
    );
  });

  it('add_artifact refuses on completed', () => {
    const loop = closedLoop('completed');
    assert.throws(
      () =>
        add_artifact(
          {
            id: loop.id,
            actor: 'agt_test',
            artifact: { phase: loop.current_phase, type: 'note', body: 'late' },
          },
          cwd,
        ),
      /already completed/,
    );
  });

  it('request_input refuses on cancelled', () => {
    const loop = closedLoop('cancelled');
    assert.throws(
      () =>
        requestInput(
          {
            loop_id: loop.id,
            slot_id: loop.slots[0].slot_id,
            phase: loop.current_phase,
            question_text: 'too late',
            evidence: ['e'],
            pause_scope: 'loop',
            on_timeout: 'continue_incomplete',
            actor: 'agt_test',
          },
          cwd,
        ),
      /already cancelled/,
    );
  });

  it('provide_input refuses on cancelled', () => {
    // Build a paused-on-question loop first, then cancel it, then attempt to
    // resolve the question. The terminal check should fire before the
    // duplicate-replay or unknown-question branches.
    const loop = openReview(cwd);
    const slot = loop.slots[0];
    const future = new Date(Date.now() + 60_000).toISOString();
    const ask = requestInput(
      {
        loop_id: loop.id,
        slot_id: slot.slot_id,
        phase: loop.current_phase,
        question_text: 'will not be answered',
        evidence: ['e'],
        suggested_default: 'X',
        pause_scope: 'loop',
        on_timeout: 'use_default',
        timeout_at: future,
        actor: 'agt_test',
      },
      cwd,
    );
    closeLoop({ id: loop.id, final_status: 'cancelled', actor: 'agt_test' }, cwd);
    assert.throws(
      () =>
        provideInput(
          {
            loop_id: loop.id,
            replies_to: ask.question_id,
            resolved_via: 'answer',
            answer_text: 'too late',
            actor: 'agt_test',
          },
          cwd,
        ),
      /already cancelled/,
    );
  });
});

describe('FSM invariant 2 — pause() pause_reason coercion + freeform back-compat', () => {
  // Design decision (pln#508 step 3): pause() does NOT reject freeform
  // `reason` strings — it accepts them for backward compatibility with
  // legacy callers and only coerces them onto `thread.pause_reason` when
  // they match the PAUSE_REASONS enum. New callers should pass the
  // structured `pause_reason` parameter instead.
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('coerces a known PauseReason from the freeform reason onto thread.pause_reason', () => {
    const loop = openReview(cwd);
    const paused = pause({ id: loop.id, reason: 'awaiting_operator', actor: 'agt_test' }, cwd);
    assert.equal(paused.pause_reason, 'awaiting_operator');
  });

  it('honours the structured pause_reason param when set, even with a freeform reason alongside', () => {
    const loop = openReview(cwd);
    const paused = pause(
      { id: loop.id, reason: 'a freeform string', pause_reason: 'awaiting_file_apply', actor: 'agt_test' },
      cwd,
    );
    assert.equal(paused.pause_reason, 'awaiting_file_apply');
  });

  it('accepts freeform reason without throwing (back-compat); pause_reason stays undefined', () => {
    const loop = openReview(cwd);
    const paused = pause({ id: loop.id, reason: 'operator afk', actor: 'agt_test' }, cwd);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pause_reason, undefined);
  });

  it('resume() clears pause_reason so the schema invariant holds', () => {
    const loop = openReview(cwd);
    pause({ id: loop.id, pause_reason: 'awaiting_operator', actor: 'agt_test' }, cwd);
    const resumed = resume({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(resumed.status, 'open');
    assert.equal(resumed.pause_reason, undefined);
  });
});
