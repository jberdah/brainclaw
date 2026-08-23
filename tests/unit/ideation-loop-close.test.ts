import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { advance, completeTurnWithEvidence } from '../../src/core/loops/verbs.js';
import { closeIdeationLoopFromLaneResult } from '../../src/core/ideation-loop-close.js';
import type { LaneResult } from '../../src/core/schema.js';

/**
 * pln#521 P2-bis — closeIdeationLoopFromLaneResult: a harvested critic lane records a
 * `critique` artifact + completes its slot; once the critique gate (n:3) accumulates,
 * the loop advances critique → revision. The convergence direction the ideation loop was
 * missing (its dispatch landed in pln#626). Mirrors the review-close tests.
 */
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ideclose-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  cleanup.push(dir);
  return dir;
}

/**
 * An ideation loop in the REAL coordinate topology: an unbound `champion` slot (never
 * completed by lane-harvest) + N bound `critic` slots, forced into the `critique` phase.
 */
function openInCritique(cwd: string, criticCount: number): string {
  const slots: Array<Record<string, unknown>> = [{ slot_id: 'lsl_champ', role: 'champion', agent: 'coord', status: 'open' as const }];
  for (let i = 0; i < criticCount; i++) {
    slots.push({ slot_id: `lsl_c${i}`, role: 'critic', agent: 'codex', assignment_id: `asg_c${i}`, status: 'assigned' as const });
  }
  const loop = openLoop({ kind: 'ideation', title: 'p2bis', created_by: 'coord', slots: slots as never }, cwd);
  advance({ id: loop.id, actor: 'coord', to_phase: 'critique', force: true }, cwd);
  return loop.id;
}

const lane = (assignmentId: string, summary = 'the proposal misses X and Y', notes?: string): Pick<LaneResult, 'status' | 'summary' | 'notes'> =>
  ({ assignment_id: assignmentId, status: 'completed', summary, ...(notes ? { notes } : {}) } as LaneResult);
const asg = (loopId: string, i: number) => ({ id: `asg_c${i}`, scope: `ideate-loop:${loopId}:lsl_c${i}`, agent: 'codex' });

describe('pln#521 P2-bis closeIdeationLoopFromLaneResult', () => {
  it('records a critique artifact + completes the slot; gate not yet met → critique_recorded', () => {
    const cwd = ws();
    const loopId = openInCritique(cwd, 3);
    const res = closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0'), 'coord', cwd);
    assert.equal(res?.action, 'critique_recorded', 'n:3 gate not met after 1 critique');
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.artifacts.filter((a) => a.type === 'critique').length, 1, 'one critique artifact recorded');
    assert.equal(loop.slots.find((s) => s.slot_id === 'lsl_c0')?.status, 'done', 'critic slot completed');
    assert.equal(loop.current_phase, 'critique', 'loop stays in critique until the gate opens');
  });

  it('advances to revision once the n:3 critique gate is satisfied', () => {
    const cwd = ws();
    const loopId = openInCritique(cwd, 3);
    closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0'), 'coord', cwd);
    closeIdeationLoopFromLaneResult(asg(loopId, 1), lane('asg_c1'), 'coord', cwd);
    const third = closeIdeationLoopFromLaneResult(asg(loopId, 2), lane('asg_c2'), 'coord', cwd);
    assert.equal(third?.action, 'advanced', 'third critique meets n:3 → advance');
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.current_phase, 'revision', 'loop advanced critique → revision');
    assert.equal(loop.artifacts.filter((a) => a.type === 'critique').length, 3);
  });

  it('a bare critic lane (no critique content) FAILS the slot — no fake gate progress', () => {
    const cwd = ws();
    const loopId = openInCritique(cwd, 3);
    const res = closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0', ''), 'coord', cwd);
    assert.equal(res?.action, 'failed');
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.slots.find((s) => s.slot_id === 'lsl_c0')?.status, 'failed');
    assert.equal(loop.artifacts.filter((a) => a.type === 'critique').length, 0, 'no critique recorded from a bare lane');
  });

  it('is idempotent — re-harvesting a completed critic lane is a noop (never steals a sibling slot)', () => {
    const cwd = ws();
    const loopId = openInCritique(cwd, 3);
    closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0'), 'coord', cwd);
    const second = closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0'), 'coord', cwd);
    assert.equal(second?.action, 'noop', 'the second harvest of c0 does not touch the still-active c1/c2 slots');
    assert.equal(getLoop(loopId, cwd)!.artifacts.filter((a) => a.type === 'critique').length, 1);
  });

  it('never completes the CHAMPION slot on a re-harvest after the critics finish (review F-A)', () => {
    const cwd = ws();
    const loopId = openInCritique(cwd, 3);
    closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0'), 'coord', cwd);
    closeIdeationLoopFromLaneResult(asg(loopId, 1), lane('asg_c1'), 'coord', cwd);
    closeIdeationLoopFromLaneResult(asg(loopId, 2), lane('asg_c2'), 'coord', cwd); // → revision
    // A routine re-harvest of an already-done critic must NOT fall through to the champion.
    const res = closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0'), 'coord', cwd);
    assert.equal(res?.action, 'noop', 'no critic slot + no critique gate in revision → noop');
    const loop = getLoop(loopId, cwd)!;
    const champ = loop.slots.find((s) => s.slot_id === 'lsl_champ')!;
    assert.notEqual(champ.status, 'done', 'the champion slot is untouched (drives revision/synthesis)');
    assert.equal(loop.artifacts.filter((a) => a.type === 'critique').length, 3, 'no stray 4th critique injected');
    assert.equal(loop.current_phase, 'revision', 'loop not cycled backward');
  });

  it('RESUMES advance when critiques were recorded but the loop is stuck in critique (review F-B)', () => {
    const cwd = ws();
    const loopId = openInCritique(cwd, 3);
    // Simulate a crash-between-complete_turn-and-advance: record 3 critiques + complete
    // the 3 critic slots WITHOUT advancing (complete_turn doesn't advance) → the loop is
    // stuck in `critique` with the n:3 gate satisfied and all critic slots done.
    for (let i = 0; i < 3; i++) {
      completeTurnWithEvidence({
        id: loopId,
        slot_id: `lsl_c${i}`,
        actor: 'coord',
        outcome: 'done',
        artifact: { phase: 'critique', type: 'critique', body: `crit ${i}` },
        evidence_context: {
          channel: 'complete_turn',
          producer_kind: 'slot',
          producer_id: `lsl_c${i}`,
          slot_id: `lsl_c${i}`,
          slot_role: 'critic',
          assignment_id: `asg_c${i}`,
        },
      }, cwd);
    }
    assert.equal(getLoop(loopId, cwd)!.current_phase, 'critique', 'precondition: stuck in critique with gate met');
    // A re-harvest finds no active critic slot but the gate is met → resume the advance.
    const res = closeIdeationLoopFromLaneResult(asg(loopId, 0), lane('asg_c0'), 'coord', cwd);
    assert.equal(res?.action, 'advanced', 'resumed the stuck advance');
    assert.equal(getLoop(loopId, cwd)!.current_phase, 'revision');
  });

  it('returns undefined for a non-ideate scope (harvest proceeds unchanged)', () => {
    const cwd = ws();
    const res = closeIdeationLoopFromLaneResult(
      { id: 'asg_r', scope: 'review-loop:lop_x', agent: 'codex' },
      lane('asg_r'),
      'coord',
      cwd,
    );
    assert.equal(res, undefined);
  });
});
