import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssignment, saveAssignment, loadAssignment, transitionAssignment,
  convergeAssignmentToTerminal,
} from '../../src/core/assignments.js';
import { openLoop, closeLoop } from '../../src/core/loops/store.js';
import { add_artifact, advance } from '../../src/core/loops/verbs.js';
import { reconcileOrphanedLoopAssignments } from '../../src/core/assignment-reconciler.js';
import type { AssignmentStatus } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;
beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-asgnconv-', projectId: 'prj_asgnconv', currentAgent: 'tester' }); });
afterEach(() => { ws.cleanup(); });

function mkAssignment(scope: string, status: AssignmentStatus, id?: string): string {
  const a = createAssignment({ id, claim_id: 'clm_x', agent: 'claude-code', dispatcher_agent: 'bclaw_coordinate', scope, description: 'd' }, ws.dir);
  a.status = status;
  saveAssignment(a, ws.dir);
  return a.id;
}

describe('assignment convergence — force transition + helper (pln#563)', () => {
  it('transitionAssignment offered→completed rejects even when callers pass force-like data', () => {
    const id = mkAssignment('review-loop:lop_a', 'offered');
    assert.throws(() => transitionAssignment(id, 'completed', { actor: 'system' }, ws.dir), /Invalid transition/);
    const forceLikeOptions = { actor: 'system', force: true } as unknown as Parameters<typeof transitionAssignment>[2];
    assert.throws(
      () => transitionAssignment(id, 'completed', forceLikeOptions, ws.dir),
      /Invalid transition/,
    );
    assert.equal(loadAssignment(id, ws.dir)!.status, 'offered');
  });

  it('convergeAssignmentToTerminal converges a stuck offered assignment', () => {
    const id = mkAssignment('review-loop:lop_b', 'offered');
    assert.equal(convergeAssignmentToTerminal(id, 'completed', 'test', ws.dir), true);
    assert.equal(loadAssignment(id, ws.dir)!.status, 'completed');
  });

  it('convergeAssignmentToTerminal is a no-op on an already-terminal or missing assignment', () => {
    const done = mkAssignment('review-loop:lop_c', 'completed');
    assert.equal(convergeAssignmentToTerminal(done, 'cancelled', 'test', ws.dir), false);
    assert.equal(loadAssignment(done, ws.dir)!.status, 'completed', 'real terminal not overwritten');
    assert.equal(convergeAssignmentToTerminal('asgn_missing', 'completed', 'test', ws.dir), false);
  });

  it('does NOT converge a failed/blocked assignment (those carry real signal)', () => {
    const failed = mkAssignment('review-loop:lop_d', 'failed');
    assert.equal(convergeAssignmentToTerminal(failed, 'completed', 'test', ws.dir), false);
    assert.equal(loadAssignment(failed, ws.dir)!.status, 'failed');
  });
});

describe('assignment convergence — closeLoop cascade (pln#563 layer A)', () => {
  function openReviewLoopWithAssignment(loopId: string, assignmentStatus: AssignmentStatus): string {
    const asgnId = mkAssignment(`review-loop:${loopId}`, assignmentStatus);
    openLoop({
      kind: 'review', title: 'review', created_by: 'bclaw_coordinate', mode: 'symmetric',
      slots: [
        { role: 'author', agent: 'bclaw_coordinate' },
        { role: 'reviewer', agent: 'claude-code', assignment_id: asgnId, status: 'assigned' },
      ],
    }, ws.dir);
    return asgnId;
  }

  it('closing a loop as completed converges its slot assignment to completed', () => {
    // openLoop generates the loop id; capture it from the returned thread.
    const asgnId = mkAssignment('review-loop:placeholder', 'offered');
    const loop = openLoop({
      kind: 'review', title: 'r', created_by: 'bclaw_coordinate', mode: 'symmetric',
      slots: [{ role: 'reviewer', agent: 'claude-code', assignment_id: asgnId, status: 'assigned' }],
    }, ws.dir);
    closeLoop({ id: loop.id, final_status: 'completed', reason: 'lgtm', actor: 'tester' }, ws.dir);
    assert.equal(loadAssignment(asgnId, ws.dir)!.status, 'completed');
  });

  it('closing a loop as cancelled converges its slot assignment to cancelled', () => {
    const asgnId = mkAssignment('review-loop:placeholder', 'started');
    const loop = openLoop({
      kind: 'review', title: 'r', created_by: 'bclaw_coordinate', mode: 'symmetric',
      slots: [{ role: 'reviewer', agent: 'claude-code', assignment_id: asgnId, status: 'working' }],
    }, ws.dir);
    closeLoop({ id: loop.id, final_status: 'cancelled', reason: 'abandoned', actor: 'tester' }, ws.dir);
    assert.equal(loadAssignment(asgnId, ws.dir)!.status, 'cancelled');
  });

  it('cascade leaves an already-failed slot assignment untouched', () => {
    const asgnId = mkAssignment('review-loop:placeholder', 'failed');
    const loop = openLoop({
      kind: 'review', title: 'r', created_by: 'bclaw_coordinate', mode: 'symmetric',
      slots: [{ role: 'reviewer', agent: 'claude-code', assignment_id: asgnId, status: 'failed' }],
    }, ws.dir);
    closeLoop({ id: loop.id, final_status: 'completed', reason: 'x', actor: 'tester' }, ws.dir);
    assert.equal(loadAssignment(asgnId, ws.dir)!.status, 'failed');
  });

  it('advance auto-close also converges slot assignments', () => {
    const asgnId = mkAssignment('review-loop:placeholder', 'offered');
    const loop = openLoop({
      kind: 'review',
      title: 'r',
      created_by: 'bclaw_coordinate',
      phases: [{ name: 'findings' }],
      stop_condition: { kind: 'artifact_produced', phase: 'findings', type: 'verdict' },
      slots: [{ role: 'reviewer', agent: 'claude-code', assignment_id: asgnId, status: 'assigned' }],
    }, ws.dir);
    add_artifact({
      id: loop.id,
      actor: 'tester',
      artifact: { phase: 'findings', type: 'verdict', body: 'accepted' },
    }, ws.dir);

    const result = advance({ id: loop.id, actor: 'tester' }, ws.dir);

    assert.equal(result.auto_closed, true);
    assert.equal(result.loop.status, 'completed');
    assert.equal(loadAssignment(asgnId, ws.dir)!.status, 'completed');
  });
  void openReviewLoopWithAssignment; // (helper kept for readability of intent)
});

describe('assignment convergence — lazy reconciler (pln#563 layer B)', () => {
  it('converges an orphan whose loop is already terminal', () => {
    const loop = openLoop({ kind: 'review', title: 'r', created_by: 'c', mode: 'symmetric', slots: [{ role: 'reviewer' }] }, ws.dir);
    // Assignment stuck offered, scoped to that loop; close the loop WITHOUT a
    // slot assignment_id so the cascade doesn't touch it — only the reconciler can.
    const orphan = mkAssignment(`review-loop:${loop.id}`, 'offered');
    closeLoop({ id: loop.id, final_status: 'completed', reason: 'done', actor: 't' }, ws.dir);
    assert.equal(loadAssignment(orphan, ws.dir)!.status, 'offered', 'cascade did not reach it (no slot link)');

    const converged = reconcileOrphanedLoopAssignments(ws.dir);
    assert.equal(converged, 1);
    assert.equal(loadAssignment(orphan, ws.dir)!.status, 'completed');
  });

  it('does NOT converge an assignment whose loop is still open', () => {
    const loop = openLoop({ kind: 'review', title: 'r', created_by: 'c', mode: 'symmetric', slots: [{ role: 'reviewer' }] }, ws.dir);
    const live = mkAssignment(`review-loop:${loop.id}`, 'started');
    assert.equal(reconcileOrphanedLoopAssignments(ws.dir), 0);
    assert.equal(loadAssignment(live, ws.dir)!.status, 'started');
  });

  it('ignores non-review-loop assignments entirely', () => {
    const plain = mkAssignment('src/foo.ts', 'offered');
    assert.equal(reconcileOrphanedLoopAssignments(ws.dir), 0);
    assert.equal(loadAssignment(plain, ws.dir)!.status, 'offered');
  });
});
