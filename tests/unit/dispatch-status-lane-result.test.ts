/**
 * pln#642 / trp_e824d2af — the LANE-RESULT ownership gate in dispatch_status.
 *
 * LANE-RESULT.json is the #1 verdict signal (pln#532): present at the worktree
 * root, it means "the worker FINISHED". But a REUSED worktree keeps the PRIOR
 * turn's file at the root, and dispatch_status read it unmatched: a
 * freshly-spawned round 2 was declared "worker reported done" with round 1's
 * verdict (observed live 2026-08-02, lop_626271ee10ad09d8 — the coordinator
 * almost harvested the wrong round). assignment_id is REQUIRED on
 * LaneResultSchema, so ownership is decidable: only a result naming THIS
 * assignment is terminal; anything else is surfaced as stale, never a verdict.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDispatchStatus } from '../../src/core/dispatch-status.js';
import { createAssignment } from '../../src/core/assignments.js';
import { saveClaim } from '../../src/core/claims.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('dispatch_status — LANE-RESULT ownership (trp_e824d2af)', { concurrency: false }, () => {
  let ws: TestWorkspace;
  let wtDir: string;

  beforeEach(() => {
    ws = createTestWorkspace({ prefix: 'bclaw-ds-lane-' });
    wtDir = fs.mkdtempSync(path.join(ws.dir, 'wt-'));
    saveClaim({
      schema_version: 2, id: 'clm_lane', agent: 'codex', scope: 'review-loop:lop_x',
      description: 'lane claim', created_at: new Date().toISOString(), status: 'active',
      worktree_path: wtDir,
    }, ws.dir);
    createAssignment({
      id: 'asgn_target', short_label: 'asgn#t', agent: 'codex', dispatcher_agent: 'coord',
      claim_id: 'clm_lane', scope: 'review-loop:lop_x', description: 'round 2 turn',
    }, ws.dir);
  });

  afterEach(() => {
    ws.cleanup();
  });

  function writeLaneResult(assignmentId: string): void {
    fs.writeFileSync(path.join(wtDir, 'LANE-RESULT.json'), JSON.stringify({
      assignment_id: assignmentId, status: 'completed', summary: 'verdict body',
    }));
  }

  it('a PRIOR turn\'s LANE-RESULT is stale — surfaced, never terminal', () => {
    writeLaneResult('asgn_round1');
    const status = getDispatchStatus({ target_id: 'asgn_target', cwd: ws.dir });
    assert.equal(status.runtime.lane_result, undefined, 'a foreign result is not THIS dispatch\'s verdict');
    assert.equal(status.runtime.lane_result_stale?.assignment_id, 'asgn_round1', 'surfaced for observability');
    assert.notEqual(status.diagnosis.health, 'terminal', 'a fresh round must not be declared done on round N-1\'s file');
    assert.doesNotMatch(status.diagnosis.summary, /worker reported done/);
  });

  it('the dispatch\'s OWN LANE-RESULT stays the #1 terminal signal (pln#532 preserved)', () => {
    writeLaneResult('asgn_target');
    const status = getDispatchStatus({ target_id: 'asgn_target', cwd: ws.dir });
    assert.equal(status.runtime.lane_result?.status, 'completed');
    assert.equal(status.runtime.lane_result_stale, undefined);
    assert.equal(status.diagnosis.health, 'terminal');
    assert.match(status.diagnosis.summary, /worker reported done/);
  });

  it('recovers the dispatch result when an agent used a different JSON filename', () => {
    fs.writeFileSync(path.join(wtDir, 'ideation-critique.json'), JSON.stringify({
      assignment_id: 'asgn_target', status: 'completed', summary: 'right payload, wrong filename',
    }));
    const status = getDispatchStatus({ target_id: 'asgn_target', cwd: ws.dir });
    assert.equal(status.runtime.lane_result?.status, 'completed');
    assert.equal(status.diagnosis.health, 'terminal');
  });
});
