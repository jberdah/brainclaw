import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, advance, turn, complete_turn, getLoop, type LoopThread } from '../../src/core/loops/index.js';
import { closeReviewLoopFromLaneResult } from '../../src/core/review-loop-close.js';
import type { Assignment, LaneResult } from '../../src/core/schema.js';

// pln#628 Focus 4B — the harvest→loop callback. A harvested review lane carrying
// a review_verdict must map onto the loop: approve → reviewer_green → auto-close;
// request_changes → advance to author_response (no close). Idempotent + a no-op
// for non-review lanes or lanes without a verdict.

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-review-loop-close-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

/** Open a review loop and put it in the state the reviewer turn runs in:
 * advanced to `findings` with the reviewer slot assigned (mirrors the real
 * bclaw_coordinate(intent='review', open_loop=true) flow). */
function setupReviewAtFindings(cwd: string): LoopThread {
  const loop = openLoop(
    {
      kind: 'review',
      title: 'focus-4b review',
      created_by: 'agt_test',
      slots: [
        { role: 'author', agent: 'claude-code', agent_id: 'agt_author' },
        { role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer' },
      ],
    },
    cwd,
  );
  advance({ id: loop.id, actor: 'agt_test' }, cwd); // change_summary → findings
  const reviewer = getLoop(loop.id, cwd)!.slots.find((s) => s.role === 'reviewer')!;
  turn({ id: loop.id, slot_id: reviewer.slot_id, actor: 'agt_test', input: 'review this' }, cwd);
  return getLoop(loop.id, cwd)!;
}

function reviewAssignment(loopId: string, id = 'asgn_rev'): Pick<Assignment, 'id' | 'scope' | 'agent'> {
  return { id, scope: `review-loop:${loopId}`, agent: 'codex' };
}

function laneWith(verdict?: LaneResult['review_verdict'], summary?: string): Pick<LaneResult, 'review_verdict' | 'review_summary'> {
  return { review_verdict: verdict, review_summary: summary };
}

describe('closeReviewLoopFromLaneResult (pln#628 Focus 4B)', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('approve → records an accepted verdict and auto-closes the loop (reviewer_green, no human)', () => {
    const loop = setupReviewAtFindings(cwd);
    const res = closeReviewLoopFromLaneResult(reviewAssignment(loop.id), laneWith('approve', 'looks good'), 'coordinator', cwd);

    assert.ok(res, 'callback fires for a review lane with a verdict');
    assert.equal(res!.action, 'closed');
    assert.equal(res!.loop_status, 'completed');

    const after = getLoop(loop.id, cwd)!;
    assert.equal(after.status, 'completed', 'loop auto-closed on reviewer_green');
    const verdictArtifact = after.artifacts.find((a) => a.type === 'verdict');
    assert.ok(verdictArtifact, 'a verdict artifact was recorded');
    assert.match(verdictArtifact!.body ?? '', /^accepted/, 'approve maps to an "accepted…" body so reviewer_green fires');
    assert.match(verdictArtifact!.body ?? '', /looks good/, 'the review_summary is carried into the verdict body');
  });

  it('request_changes → records the verdict and advances to author_response WITHOUT closing', () => {
    const loop = setupReviewAtFindings(cwd);
    const res = closeReviewLoopFromLaneResult(reviewAssignment(loop.id), laneWith('request_changes', 'fix the guard'), 'coordinator', cwd);

    assert.ok(res);
    assert.equal(res!.action, 'advanced');
    assert.equal(res!.loop_status, 'open', 'loop stays open (re-review cycle is PR2)');

    const after = getLoop(loop.id, cwd)!;
    assert.equal(after.status, 'open');
    assert.equal(after.current_phase, 'author_response', 'advanced one phase past findings');
    const verdictArtifact = after.artifacts.find((a) => a.type === 'verdict');
    assert.ok(verdictArtifact);
    assert.doesNotMatch(verdictArtifact!.body ?? '', /^accepted/, 'request_changes must NOT produce an accepted body');
    assert.match(verdictArtifact!.body ?? '', /^changes-requested/, 'request_changes body is explicit');
  });

  it('is idempotent — a second harvest pass on an already-closed loop is a no-op', () => {
    const loop = setupReviewAtFindings(cwd);
    const first = closeReviewLoopFromLaneResult(reviewAssignment(loop.id), laneWith('approve'), 'coordinator', cwd);
    assert.equal(first!.action, 'closed');

    const second = closeReviewLoopFromLaneResult(reviewAssignment(loop.id), laneWith('approve'), 'coordinator', cwd);
    assert.ok(second);
    assert.equal(second!.action, 'noop', 'terminal loop is not mutated again');
    assert.match(second!.reason, /already completed/);
    assert.equal(getLoop(loop.id, cwd)!.status, 'completed', 'loop unchanged after the repeat');
  });

  it('returns undefined for a non-review-loop scope (harvest proceeds unchanged)', () => {
    const res = closeReviewLoopFromLaneResult({ id: 'asgn_x', scope: 'src/core/foo.ts', agent: 'codex' }, laneWith('approve'), 'coordinator', cwd);
    assert.equal(res, undefined);
  });

  it('returns undefined when the lane carries no review_verdict', () => {
    const loop = setupReviewAtFindings(cwd);
    const res = closeReviewLoopFromLaneResult(reviewAssignment(loop.id), laneWith(undefined), 'coordinator', cwd);
    assert.equal(res, undefined, 'no verdict → callback does not fire');
    assert.equal(getLoop(loop.id, cwd)!.status, 'open', 'loop untouched');
  });

  it('no-ops gracefully when the referenced loop does not exist', () => {
    const res = closeReviewLoopFromLaneResult({ id: 'asgn_x', scope: 'review-loop:lop_deadbeef', agent: 'codex' }, laneWith('approve'), 'coordinator', cwd);
    assert.ok(res);
    assert.equal(res!.action, 'noop');
    assert.match(res!.reason, /loop not found/);
  });

  // BLOCKING 2 (Codex review of #87) — symmetric loops have >1 reviewer slot.
  // The verdict must land on the slot BOUND to this lane's assignment_id, never
  // "any active reviewer" (which would complete the wrong reviewer's turn).
  it('completes the slot bound to THIS assignment, not a sibling reviewer (symmetric binding)', () => {
    const loop = openLoop({
      kind: 'review', title: 'symmetric', created_by: 'agt_test', mode: 'symmetric',
      slots: [
        { role: 'author', agent: 'claude-code', agent_id: 'agt_author' },
        { role: 'reviewer', agent: 'codex', agent_id: 'agt_r1' },
        { role: 'reviewer', agent: 'codex', agent_id: 'agt_r2' },
      ],
    }, cwd);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → findings
    const [rA, rB] = getLoop(loop.id, cwd)!.slots.filter((s) => s.role === 'reviewer');
    // Bind each reviewer slot to a distinct assignment (the #87 coordinate fix).
    turn({ id: loop.id, slot_id: rA!.slot_id, actor: 'agt_test', assignment_id: 'asgn_A' }, cwd);
    turn({ id: loop.id, slot_id: rB!.slot_id, actor: 'agt_test', assignment_id: 'asgn_B' }, cwd);

    // Harvest the lane for assignment A with request_changes (so the loop stays
    // open and we can inspect both slots afterwards).
    const res = closeReviewLoopFromLaneResult(reviewAssignment(loop.id, 'asgn_A'), laneWith('request_changes', 'A says fix'), 'coordinator', cwd);
    assert.ok(res);
    const after = getLoop(loop.id, cwd)!;
    const slotA = after.slots.find((s) => s.assignment_id === 'asgn_A')!;
    const slotB = after.slots.find((s) => s.assignment_id === 'asgn_B')!;
    assert.equal(slotA.status, 'done', 'the bound slot (asgn_A) got the verdict');
    assert.notEqual(slotB.status, 'done', 'the sibling reviewer (asgn_B) is untouched');
    // The verdict artifact was produced by slot A, not B.
    const verdict = after.artifacts.find((a) => a.type === 'verdict');
    assert.equal(verdict?.produced_by, slotA.slot_id, 'verdict attributed to the correct reviewer slot');
  });

  // BLOCKING 3 (Codex review of #87) — if a prior pass recorded an accepted
  // verdict but died BEFORE advancing (interruption between the two writes), a
  // later harvest must RESUME the advance and close, not no-op on the done slot.
  it('resumes an interrupted approve: verdict recorded, advance never ran → later pass closes', () => {
    const loop = setupReviewAtFindings(cwd);
    const reviewer = getLoop(loop.id, cwd)!.slots.find((s) => s.role === 'reviewer')!;
    // Simulate the crash window: complete the reviewer turn with an accepted
    // verdict, but do NOT advance.
    complete_turn(
      { id: loop.id, slot_id: reviewer.slot_id, actor: 'coordinator', artifact: { phase: 'findings', type: 'verdict', body: 'accepted: prior pass' } },
      cwd,
    );
    assert.equal(getLoop(loop.id, cwd)!.status, 'open', 'precondition: verdict recorded but loop not advanced/closed');

    const res = closeReviewLoopFromLaneResult(reviewAssignment(loop.id), laneWith('approve'), 'coordinator', cwd);
    assert.ok(res);
    assert.equal(res!.action, 'closed', 'the stuck approve is resumed and closed');
    assert.equal(getLoop(loop.id, cwd)!.status, 'completed');
  });
});
