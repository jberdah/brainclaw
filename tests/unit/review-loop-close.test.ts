import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, advance, turn, getLoop, type LoopThread } from '../../src/core/loops/index.js';
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

function reviewAssignment(loopId: string): Pick<Assignment, 'scope' | 'agent'> {
  return { scope: `review-loop:${loopId}`, agent: 'codex' };
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
    const res = closeReviewLoopFromLaneResult({ scope: 'src/core/foo.ts', agent: 'codex' }, laneWith('approve'), 'coordinator', cwd);
    assert.equal(res, undefined);
  });

  it('returns undefined when the lane carries no review_verdict', () => {
    const loop = setupReviewAtFindings(cwd);
    const res = closeReviewLoopFromLaneResult(reviewAssignment(loop.id), laneWith(undefined), 'coordinator', cwd);
    assert.equal(res, undefined, 'no verdict → callback does not fire');
    assert.equal(getLoop(loop.id, cwd)!.status, 'open', 'loop untouched');
  });

  it('no-ops gracefully when the referenced loop does not exist', () => {
    const res = closeReviewLoopFromLaneResult({ scope: 'review-loop:lop_deadbeef', agent: 'codex' }, laneWith('approve'), 'coordinator', cwd);
    assert.ok(res);
    assert.equal(res!.action, 'noop');
    assert.match(res!.reason, /loop not found/);
  });
});
