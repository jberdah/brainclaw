import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadState, saveState } from '../../src/core/state.js';
import { saveClaim, releaseClaimWithCascade, releaseClaimsCascade, logCascadeReleaseResult } from '../../src/core/claims.js';
import { listRuntimeEvents } from '../../src/core/events.js';
import { nowISO } from '../../src/core/ids.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function makeClaimId(suffix: string): string {
  return `clm_${suffix}`;
}

function makePlanId(suffix: string): string {
  return `pln_${suffix}`;
}

function seedPlan(workspace: TestWorkspace, planId: string): void {
  const state = loadState(workspace.dir);
  state.plan_items.push({
    id: planId,
    text: 'Test plan',
    created_at: nowISO(),
    updated_at: nowISO(),
    author: workspace.currentAgent.agent_name,
    status: 'in_progress',
    priority: 'medium',
    tags: [],
    depends_on: [],
  });
  saveState(state, workspace.dir);
}

function seedClaim(workspace: TestWorkspace, claimId: string, planId: string): void {
  saveClaim(
    {
      id: claimId,
      agent: workspace.currentAgent.agent_name,
      scope: `src/${claimId}`,
      description: `Claim ${claimId}`,
      plan_id: planId,
      created_at: nowISO(),
      status: 'active',
    },
    workspace.dir,
  );
}

describe('claims cascade — last-claim rule', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-cascade-', projectId: 'prj_cascade_test' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('last claim + planStatus=done → transitions plan to done', () => {
    const planId = makePlanId('cascade_single');
    const claimId = makeClaimId('a1a1a1a1');
    seedPlan(workspace, planId);
    seedClaim(workspace, claimId, planId);

    const result = releaseClaimWithCascade(claimId, { planStatus: 'done', cwd: workspace.dir });

    assert.equal(result.claim.status, 'released');
    assert.equal(result.planTransitioned, true);
    assert.equal(result.newPlanStatus, 'done');
    assert.equal(result.planId, planId);
    assert.ok(!result.planWarning, 'no warning when last claim released');

    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.id === planId);
    assert.ok(plan);
    assert.equal(plan.status, 'done');
    assert.ok(plan.completed_at, 'completed_at should be set');
  });

  it('multi-claim: release one → plan stays in_progress, warning returned', () => {
    const planId = makePlanId('cascade_multi');
    const claimId1 = makeClaimId('b1b1b1b1');
    const claimId2 = makeClaimId('b2b2b2b2');
    seedPlan(workspace, planId);
    seedClaim(workspace, claimId1, planId);
    seedClaim(workspace, claimId2, planId);

    const result = releaseClaimWithCascade(claimId1, { planStatus: 'done', cwd: workspace.dir });

    assert.equal(result.claim.status, 'released');
    assert.equal(result.planTransitioned, false);
    assert.ok(result.planWarning, 'warning should be set when other claims still active');
    assert.ok(result.planWarning!.includes('1 other active claim'), `warning: ${result.planWarning}`);
    assert.equal(result.otherActiveClaimsCount, 1);

    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.id === planId);
    assert.ok(plan);
    assert.equal(plan.status, 'in_progress', 'plan must remain in_progress');
  });

  it('multi-claim: release last claim → plan transitions to done', () => {
    const planId = makePlanId('cascade_last');
    const claimId1 = makeClaimId('c1c1c1c1');
    const claimId2 = makeClaimId('c2c2c2c2');
    seedPlan(workspace, planId);
    seedClaim(workspace, claimId1, planId);
    seedClaim(workspace, claimId2, planId);

    // Release first claim — plan stays in_progress
    releaseClaimWithCascade(claimId1, { planStatus: 'done', cwd: workspace.dir });

    // Release second (last) claim — now plan should go done
    const result = releaseClaimWithCascade(claimId2, { planStatus: 'done', cwd: workspace.dir });

    assert.equal(result.claim.status, 'released');
    assert.equal(result.planTransitioned, true);
    assert.equal(result.newPlanStatus, 'done');
    assert.ok(!result.planWarning);

    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.id === planId);
    assert.ok(plan);
    assert.equal(plan.status, 'done');
  });

  it('idempotent double-release does not crash', () => {
    const planId = makePlanId('cascade_idem');
    const claimId = makeClaimId('d1d1d1d1');
    seedPlan(workspace, planId);
    seedClaim(workspace, claimId, planId);

    // First release — valid
    releaseClaimWithCascade(claimId, { planStatus: 'done', cwd: workspace.dir });

    // Second release — claim is already released; loadClaim still returns it
    // The function should not crash even though claim is already released
    assert.doesNotThrow(() => {
      releaseClaimWithCascade(claimId, { planStatus: 'done', cwd: workspace.dir });
    });
  });

  describe('releaseClaimsCascade + logCascadeReleaseResult (trp#928)', () => {
    it('emits a per-claim entry with reason=released for each released active claim', () => {
      const planId = makePlanId('cascadelog_1');
      seedPlan(workspace, planId);
      const claimIds = ['clm_batch_a', 'clm_batch_b', 'clm_batch_c'];
      for (const id of claimIds) seedClaim(workspace, id, planId);

      const cascade = releaseClaimsCascade(claimIds, { cwd: workspace.dir });

      assert.equal(cascade.released_count, 3);
      assert.equal(cascade.entries.length, 3);
      for (const entry of cascade.entries) {
        assert.equal(entry.released, true);
        assert.equal(entry.reason, 'released');
      }
    });

    it('logs skipped for an already-terminal claim (does not fail the batch)', () => {
      const planId = makePlanId('cascadelog_2');
      seedPlan(workspace, planId);
      seedClaim(workspace, 'clm_terminal_a', planId);
      seedClaim(workspace, 'clm_terminal_b', planId);
      // Release one manually so it is already terminal by the time the cascade runs.
      releaseClaimWithCascade('clm_terminal_a', { cwd: workspace.dir });

      const cascade = releaseClaimsCascade(['clm_terminal_a', 'clm_terminal_b'], { cwd: workspace.dir });

      assert.equal(cascade.released_count, 1, 'only the active one released');
      const skipped = cascade.entries.find((e) => e.claim_id === 'clm_terminal_a');
      assert.ok(skipped);
      assert.equal(skipped.released, false);
      assert.equal(skipped.reason, 'already_terminal');
    });

    it('logs ownership_denied for a foreign claim without coordinator_override + surfaces via runtime event', () => {
      const claimId = 'clm_denied_owner';
      saveClaim({
        id: claimId,
        agent: 'other-worker',
        scope: 'src/foreign',
        description: 'foreign claim',
        created_at: nowISO(),
        status: 'active',
      }, workspace.dir);

      const cascade = releaseClaimsCascade([claimId], {
        cwd: workspace.dir,
        auth: { agent: 'coordinator', override: false },
      });
      assert.equal(cascade.released_count, 0);
      assert.equal(cascade.error_count, 1);
      const entry = cascade.entries[0];
      assert.ok(entry);
      assert.equal(entry.reason, 'ownership_denied');
      assert.ok(entry.error && /coordinator_override/i.test(entry.error), 'error must expose the executable hint');

      logCascadeReleaseResult({
        actor: 'coordinator',
        trigger: 'plan_done',
        cascade,
        cwd: workspace.dir,
      });
      const events = listRuntimeEvents(workspace.dir);
      const cascadeEvents = events.filter((e) => Array.isArray(e.tags) && e.tags.includes('cascade'));
      assert.ok(cascadeEvents.length > 0, 'a cascade runtime event must be emitted');
      const evt = cascadeEvents[cascadeEvents.length - 1]!;
      assert.ok(evt.tags?.includes('ownership-issue'), 'event must carry ownership-issue tag');
      assert.ok(evt.text?.includes(claimId), 'event text should name the denied claim');
    });
  });

  it('planStatus=blocked always propagates to plan regardless of other claims', () => {
    const planId = makePlanId('cascade_blocked');
    const claimId1 = makeClaimId('e1e1e1e1');
    const claimId2 = makeClaimId('e2e2e2e2');
    seedPlan(workspace, planId);
    seedClaim(workspace, claimId1, planId);
    seedClaim(workspace, claimId2, planId);

    // Release first claim with blocked — plan should immediately reflect blocked
    const result = releaseClaimWithCascade(claimId1, { planStatus: 'blocked', cwd: workspace.dir });

    assert.equal(result.claim.status, 'released');
    assert.equal(result.planTransitioned, true);
    assert.equal(result.newPlanStatus, 'blocked');
    assert.ok(!result.planWarning);

    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.id === planId);
    assert.ok(plan);
    assert.equal(plan.status, 'blocked');
  });
});
