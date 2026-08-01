/**
 * pln#639 BUG-2 — a lane that returns AFTER a phase advance must have its work
 * filed under the phase it was DISPATCHED in.
 *
 * `turn()` stamps `slot.phase = current_phase` when a slot is handed out. Both
 * loop closers, however, recorded their artifact with `phase: loop.current_phase`
 * — the phase at CLOSE time. A critique arriving after the loop advanced was
 * therefore written into `revision`: invisible to the critique gate that was
 * waiting for it, and a false record of what the agent had been asked to do.
 *
 * NOT HYPOTHETICAL. The pln#638 1a/1b ideation advanced ~90 seconds after its
 * last critic returned. A slower critic would have hit exactly this.
 *
 * Truthful attribution is also the fix for "don't count a late return": the gate
 * filters on `artifact.phase === current_phase`, so an out-of-phase artifact stops
 * satisfying the current gate by construction — no separate refusal path needed,
 * and the content is preserved rather than dropped.
 *
 * SCOPE, STATED PLAINLY: this pins phase attribution. It does NOT add version/CAS
 * enforcement — `expected_version` is accepted across the loop facade but
 * documented as "not enforced until lock/idempotency wiring lands", so building
 * CAS here would front-run a project-wide decision.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { advance } from '../../src/core/loops/verbs.js';
import { closeIdeationLoopFromLaneResult } from '../../src/core/ideation-loop-close.js';
import type { LaneResult } from '../../src/core/schema.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-latephase-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  cleanup.push(dir);
  return dir;
}

/** A critic slot carrying the phase `turn()` would have stamped at dispatch. */
function openWithDispatchedCritic(cwd: string, dispatchPhase: string | undefined): string {
  const slots: Array<Record<string, unknown>> = [
    { slot_id: 'lsl_champ', role: 'champion', agent: 'coord', status: 'open' },
    {
      slot_id: 'lsl_c0',
      role: 'critic',
      agent: 'codex',
      assignment_id: 'asg_c0',
      status: 'assigned',
      ...(dispatchPhase ? { phase: dispatchPhase } : {}),
    },
  ];
  const loop = openLoop({ kind: 'ideation', title: 'late return', created_by: 'coord', slots: slots as never }, cwd);
  advance({ id: loop.id, actor: 'coord', to_phase: 'critique', force: true }, cwd);
  return loop.id;
}

const lane = (assignmentId: string): LaneResult =>
  ({ assignment_id: assignmentId, status: 'completed', summary: 'the proposal misses X', body: 'full critique body' } as LaneResult);
const asg = (loopId: string) => ({ id: 'asg_c0', scope: `ideate-loop:${loopId}:lsl_c0`, agent: 'codex' });

describe('pln#639 BUG-2 — late lane return keeps its dispatch phase', () => {
  it('a critique returning after the advance is filed under critique, NOT revision', () => {
    const cwd = ws();
    const loopId = openWithDispatchedCritic(cwd, 'critique');

    // The loop moves on while the critic is still working.
    advance({ id: loopId, actor: 'coord', to_phase: 'revision', force: true }, cwd);
    assert.equal(getLoop(loopId, cwd)!.current_phase, 'revision', 'precondition: the loop advanced');

    closeIdeationLoopFromLaneResult(asg(loopId), lane('asg_c0'), 'coord', cwd);

    const critique = getLoop(loopId, cwd)!.artifacts.find((a) => a.type === 'critique');
    assert.ok(critique, 'the critique must still be recorded — never dropped');
    assert.equal(
      critique.phase, 'critique',
      'the artifact belongs to the phase the slot was dispatched in, not the phase the loop reached',
    );
  });

  it('and therefore does not satisfy the phase it arrived into', () => {
    // The "do not count it automatically" half, obtained for free from truthful
    // attribution rather than from a bespoke rejection branch.
    const cwd = ws();
    const loopId = openWithDispatchedCritic(cwd, 'critique');
    advance({ id: loopId, actor: 'coord', to_phase: 'revision', force: true }, cwd);
    closeIdeationLoopFromLaneResult(asg(loopId), lane('asg_c0'), 'coord', cwd);

    const loop = getLoop(loopId, cwd)!;
    const inRevision = loop.artifacts.filter((a) => a.phase === 'revision' && a.type === 'critique');
    assert.deepEqual(inRevision, [], 'nothing lands in the phase the loop had moved to');
  });

  it('a slot with NO dispatch phase falls back to current_phase (legacy, unchanged)', () => {
    // Slots created before turn() stamped a phase — and the fixtures of the
    // pre-existing close tests — must behave exactly as before.
    const cwd = ws();
    const loopId = openWithDispatchedCritic(cwd, undefined);
    closeIdeationLoopFromLaneResult(asg(loopId), lane('asg_c0'), 'coord', cwd);

    const critique = getLoop(loopId, cwd)!.artifacts.find((a) => a.type === 'critique');
    assert.ok(critique);
    assert.equal(critique.phase, 'critique', 'falls back to the loop phase when the slot carries none');
  });

  it('the ordinary same-phase return is untouched', () => {
    const cwd = ws();
    const loopId = openWithDispatchedCritic(cwd, 'critique');
    closeIdeationLoopFromLaneResult(asg(loopId), lane('asg_c0'), 'coord', cwd);

    const critique = getLoop(loopId, cwd)!.artifacts.find((a) => a.type === 'critique');
    assert.equal(critique?.phase, 'critique');
  });
});
