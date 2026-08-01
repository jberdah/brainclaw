import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getLaneResultPath, runHarvestLane } from '../../src/commands/harvest.js';
import { listRuntimeEvents } from '../../src/core/events.js';
import { nowISO } from '../../src/core/ids.js';
import { saveAssignment } from '../../src/core/assignments.js';
import { saveClaim } from '../../src/core/claims.js';
import { advance, getLoop, openLoop } from '../../src/core/loops/index.js';
import { LANE_RESULT_BODY_MAX_BYTES, LaneResultSchema, type Assignment, type Claim } from '../../src/core/schema.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cli-'));
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  cleanup.push(cwd);
  return cwd;
}

function worktree(): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cli-wt-'));
  cleanup.push(wt);
  return wt;
}

function saveLaneAssignment(cwd: string, assignmentId: string, claimId: string, scope: string, wt: string): void {
  const createdAt = nowISO();
  const claim: Claim = {
    schema_version: 2, id: claimId, agent: 'test-critic', scope,
    description: 'lane test', created_at: createdAt, status: 'active', worktree_path: wt,
  };
  saveClaim(claim, cwd);
  const assignment: Assignment = {
    schema_version: 2, id: assignmentId, short_label: assignmentId, claim_id: claimId,
    agent: 'test-critic', dispatcher_agent: 'coordinator', scope, description: 'lane test',
    status: 'offered', created_at: createdAt, updated_at: createdAt, offered_at: createdAt,
    last_heartbeat_at: createdAt, artifacts: [], retry_count: 0, max_retries: 2,
    heartbeat_ttl_ms: 30 * 60_000, acceptance_ttl_ms: 15 * 60_000, tags: [], worktree_path: wt,
  };
  saveAssignment(assignment, cwd);
}

function seedIdeationLane(cwd: string, assignmentId: string, body: string, artifactType?: string): { loopId: string; wt: string } {
  const wt = worktree();
  const loop = openLoop({
    kind: 'ideation', title: 'CLI harvest', created_by: 'coordinator',
    slots: [
      { slot_id: 'lsl_champ', role: 'champion', agent: 'coordinator', status: 'open' },
      { slot_id: 'lsl_critic', role: 'critic', agent: 'test-critic', assignment_id: assignmentId, status: 'assigned' },
    ],
  }, cwd);
  advance({ id: loop.id, actor: 'coordinator', to_phase: 'critique', force: true }, cwd);
  saveLaneAssignment(cwd, assignmentId, `clm_${assignmentId}`, `ideate-loop:${loop.id}:lsl_critic`, wt);
  fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
    assignment_id: assignmentId, status: 'completed', summary: 'short critic summary', body,
    ...(artifactType ? { artifacts: [artifactType] } : {}),
  }));
  return { loopId: loop.id, wt };
}

function seedReviewLane(cwd: string, assignmentId: string, body: string): { loopId: string; wt: string } {
  const wt = worktree();
  const loop = openLoop({
    kind: 'review', title: 'CLI body round-trip', created_by: 'coordinator', mode: 'symmetric',
    phases: [{ name: 'findings' }], stop_condition: { kind: 'reviewer_green' },
    slots: [{ slot_id: 'lsl_reviewer', role: 'reviewer', agent: 'test-critic', status: 'assigned' }],
  }, cwd);
  saveLaneAssignment(cwd, assignmentId, `clm_${assignmentId}`, `review-loop:${loop.id}`, wt);
  fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
    assignment_id: assignmentId, status: 'completed', summary: 'one-line fallback',
    review_verdict: 'approve', review_summary: 'one-line rationale', body,
  }));
  return { loopId: loop.id, wt };
}

async function quietlyRunHarvest(assignmentId: string, options: Parameters<typeof runHarvestLane>[1]): Promise<void> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await runHarvestLane(assignmentId, options);
  } finally {
    console.log = originalLog;
  }
}

describe('pln#638 — CLI lane harvest convergence and bodies', () => {
  it('converges an ideation critic through both CLI report and --integrate paths', async () => {
    for (const integrate of [false, true]) {
      const cwd = workspace();
      const assignmentId = integrate ? 'asgn_cli_integrate' : 'asgn_cli_report';
      const { loopId, wt } = seedIdeationLane(cwd, assignmentId, 'The body reaches the critic artifact.');
      await quietlyRunHarvest(assignmentId, { cwd, worktree: [wt], integrate });

      const loop = getLoop(loopId, cwd)!;
      assert.equal(loop.slots.find((slot) => slot.slot_id === 'lsl_critic')?.status, 'done', `critic slot converges (${integrate ? '--integrate' : 'report'})`);
      assert.equal(loop.artifacts.filter((artifact) => artifact.type === 'critique').length, 1);
      const event = listRuntimeEvents(cwd).find((item) => item.event_type === (integrate ? 'lane_integrated' : 'lane_result_harvested'));
      assert.equal(event?.metadata?.body, 'The body reaches the critic artifact.', `body is ingested (${integrate ? '--integrate' : 'report'})`);
    }
  });

  it('round-trips a substantive review body into the loop and durable harvest event', async () => {
    const cwd = workspace();
    const body = 'Finding 1: the null branch is untested.\n\nFinding 2: the retry path drops the claim.';
    const { loopId, wt } = seedReviewLane(cwd, 'asgn_review_body', body);
    await quietlyRunHarvest('asgn_review_body', { cwd, worktree: [wt] });

    const verdict = getLoop(loopId, cwd)!.artifacts.find((artifact) => artifact.type === 'verdict');
    assert.match(verdict?.body ?? '', /Finding 1/, 'the loop sees the full body, not review_summary only');
    assert.doesNotMatch(verdict?.body ?? '', /one-line rationale/);
    fs.rmSync(wt, { recursive: true, force: true });
    const event = listRuntimeEvents(cwd).find((item) => item.event_type === 'lane_result_harvested');
    assert.equal(event?.metadata?.body, body, 'body survives source-worktree cleanup in coordinator storage');
  });

  it('reconciles a critic body declared with coverage_gap to the required critique type', async () => {
    const cwd = workspace();
    const { loopId, wt } = seedIdeationLane(cwd, 'asgn_wrong_type', 'A real critique under the wrong worker type.', 'coverage_gap');
    await quietlyRunHarvest('asgn_wrong_type', { cwd, worktree: [wt] });

    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.artifacts.filter((artifact) => artifact.type === 'critique').length, 1, 'gate-facing type is reconciled');
    assert.equal(loop.artifacts.find((artifact) => artifact.type === 'critique')?.body, 'A real critique under the wrong worker type.');
    const event = listRuntimeEvents(cwd).find((item) => item.event_type === 'lane_result_harvested');
    const convergence = event?.metadata?.ideation_loop as { reason?: string } | undefined;
    assert.match(convergence?.reason ?? '', /reconciled reported artifact type "coverage_gap" to expected "critique"/);
  });
  it('enforces the inline body byte cap', () => {
    assert.throws(() => LaneResultSchema.parse({
      assignment_id: 'asgn_body_cap', status: 'completed', summary: 'too large',
      body: 'x'.repeat(LANE_RESULT_BODY_MAX_BYTES + 1),
    }), /LANE-RESULT\.body/);
  });
});
