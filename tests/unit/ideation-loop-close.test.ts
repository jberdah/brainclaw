import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { advance } from '../../src/core/loops/verbs.js';
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

/** An ideation loop with N bound critic slots, forced into the `critique` phase. */
function openInCritique(cwd: string, criticCount: number): string {
  const slots = Array.from({ length: criticCount }, (_, i) => ({
    slot_id: `lsl_c${i}`,
    role: 'critic',
    agent: 'codex',
    assignment_id: `asg_c${i}`,
    status: 'assigned' as const,
  }));
  const loop = openLoop({ kind: 'ideation', title: 'p2bis', created_by: 'coord', slots }, cwd);
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
