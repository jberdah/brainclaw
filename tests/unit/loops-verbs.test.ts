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
