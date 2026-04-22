import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeSequence, generateBrief, dispatch, findReviewableHandoffs, generateReviewBrief, dispatchReview, selectWorktreeBaseForReadyLane } from '../../src/core/dispatcher.js';
import { saveSequence } from '../../src/core/sequence.js';
import { saveClaim } from '../../src/core/claims.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState, loadState } from '../../src/core/state.js';
import type { Sequence, PlanItem, Claim, Handoff } from '../../src/core/schema.js';

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-dispatch-test-'));
  const bc = path.join(dir, '.brainclaw');
  // Create all needed directories
  for (const sub of [
    'coordination/plans', 'coordination/sequences', 'coordination/claims',
    'coordination/handoffs', 'coordination/inbox', 'coordination/sessions',
    'memory/constraints', 'memory/decisions', 'memory/traps',
    'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_test\n');
  return dir;
}

function cleanupTestStore(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makePlan(overrides: Partial<PlanItem> & { id: string; text: string }): PlanItem {
  return {
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    author: 'test',
    status: 'todo',
    priority: 'medium',
    tags: [],
    depends_on: [],
    ...overrides,
  };
}

function makeHandoff(overrides: Partial<Handoff> & { id: string }): Handoff {
  return {
    from: 'claude-code',
    to: 'codex',
    text: 'Work done',
    created_at: '2026-04-01T00:00:00Z',
    author: 'claude-code',
    status: 'open',
    tags: [],
    ...overrides,
  };
}

function makeSequence(items: Sequence['items']): Sequence {
  return {
    schema_version: 2,
    id: 'seq_test1234',
    name: 'test-sequence',
    status: 'active',
    items,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    author: 'test',
    tags: [],
  };
}

function setupAgents(dir: string): void {
  saveAgentIdentity({
    version: 1,
    agent_id: 'agt_claude',
    agent_name: 'claude-code',
    kind: 'agent',
    trust_level: 'trusted',
    capabilities: [],
    created_at: '2026-04-01T00:00:00Z',
  }, dir);
  saveAgentIdentity({
    version: 1,
    agent_id: 'agt_codex',
    agent_name: 'codex',
    kind: 'agent',
    trust_level: 'contributor',
    capabilities: [],
    created_at: '2026-04-01T00:00:00Z',
  }, dir);
}

describe('core/dispatcher', () => {
  let testDir: string;

  let previousNoSpawn: string | undefined;

  beforeEach(() => {
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1';
    testDir = createTestStore();
    setupAgents(testDir);
  });

  afterEach(() => {
    cleanupTestStore(testDir);
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  describe('analyzeSequence', () => {
    it('returns null when no active sequence', () => {
      const result = analyzeSequence(testDir);
      assert.equal(result, null);
    });

    it('identifies ready lanes when all deps are met', () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'done' }),
        makePlan({ id: 'pln_b', text: 'Task B', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
        { planId: 'pln_b', rank: 2, hard_after: ['pln_a'], soft_after: [] },
      ]), testDir);

      const result = analyzeSequence(testDir)!;
      assert.ok(result);
      assert.equal(result.done.length, 1);
      assert.equal(result.ready.length, 1);
      assert.equal(result.ready[0]!.plan.id, 'pln_b');
    });

    it('selects integrated HEAD as worktree base for ready lanes with satisfied hard_after deps', () => {
      const plans = [
        makePlan({ id: 'pln_dep', text: 'Dependency', status: 'done' }),
        makePlan({ id: 'pln_downstream', text: 'Downstream', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_dep', rank: 1, hard_after: [], soft_after: [] },
        { planId: 'pln_downstream', rank: 2, hard_after: ['pln_dep'], soft_after: [] },
      ]), testDir);

      const analysis = analyzeSequence(testDir)!;
      const downstream = analysis.ready.find((entry) => entry.plan.id === 'pln_downstream')!;
      const selection = selectWorktreeBaseForReadyLane(downstream.item, analysis);

      assert.equal(selection.baseRef, 'HEAD');
      assert.equal(selection.resetExistingBranch, true);
      assert.ok(selection.reason?.includes('pln_dep'));
    });

    it('keeps default worktree base for lanes without hard_after deps', () => {
      const plans = [makePlan({ id: 'pln_root', text: 'Root task', status: 'todo' })];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_root', rank: 1, hard_after: [], soft_after: [] },
      ]), testDir);

      const analysis = analyzeSequence(testDir)!;
      const selection = selectWorktreeBaseForReadyLane(analysis.ready[0]!.item, analysis);

      assert.equal(selection.baseRef, undefined);
      assert.equal(selection.resetExistingBranch, undefined);
    });

    it('identifies blocked lanes with unmet hard deps', () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'todo' }),
        makePlan({ id: 'pln_b', text: 'Task B', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
        { planId: 'pln_b', rank: 2, hard_after: ['pln_a'], soft_after: [] },
      ]), testDir);

      const result = analyzeSequence(testDir)!;
      assert.equal(result.ready.length, 1);
      assert.equal(result.ready[0]!.plan.id, 'pln_a');
      assert.equal(result.blocked.length, 1);
      assert.equal(result.blocked[0]!.item.planId, 'pln_b');
      assert.ok(result.blocked[0]!.reason.includes('hard dependencies'));
    });

    it('identifies active lanes with claims', () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'in_progress' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveClaim({
        schema_version: 2,
        id: 'clm_test1',
        agent: 'claude-code',
        scope: 'src/core/foo.ts',
        description: 'Working on Task A',
        created_at: '2026-04-01T00:00:00Z',
        plan_id: 'pln_a',
        status: 'active',
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
      ]), testDir);

      const result = analyzeSequence(testDir)!;
      assert.equal(result.active.length, 1);
      assert.equal(result.active[0]!.agent, 'claude-code');
      assert.equal(result.ready.length, 0);
    });

    it('agents with claims still available if they have remaining capacity', () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'in_progress' }),
        makePlan({ id: 'pln_b', text: 'Task B', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveClaim({
        schema_version: 2,
        id: 'clm_test1',
        agent: 'claude-code',
        scope: 'src/foo.ts',
        description: 'Working',
        created_at: '2026-04-01T00:00:00Z',
        plan_id: 'pln_a',
        status: 'active',
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
        { planId: 'pln_b', rank: 2, hard_after: [], soft_after: [] },
      ]), testDir);

      const result = analyzeSequence(testDir)!;
      // claude-code has max_concurrent_tasks=3, 1 claim → 2 slots remaining → still available
      assert.ok(result.available_agents.includes('claude-code'), 'claude-code still available (1/3 slots used)');
      assert.ok(result.available_agents.includes('codex'), 'codex available (0 claims)');
      // Check agent_capacity
      const claudeCapacity = result.agent_capacity.find(a => a.agent === 'claude-code')!;
      assert.equal(claudeCapacity.active_claims, 1);
      assert.equal(claudeCapacity.max_tasks, 3);
      assert.equal(claudeCapacity.slots_remaining, 2);
    });

    it('handles parallel lanes correctly', () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A (vscode)', status: 'todo' }),
        makePlan({ id: 'pln_b', text: 'Task B (testing)', status: 'todo' }),
        makePlan({ id: 'pln_c', text: 'Task C (coordination)', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [], lane: 'vscode' },
        { planId: 'pln_b', rank: 2, hard_after: [], soft_after: [], lane: 'testing' },
        { planId: 'pln_c', rank: 3, hard_after: [], soft_after: [], lane: 'coordination' },
      ]), testDir);

      const result = analyzeSequence(testDir)!;
      assert.equal(result.ready.length, 3);
      assert.deepEqual(result.ready.map(r => r.lane).sort(), ['coordination', 'testing', 'vscode']);
    });
  });

  describe('generateBrief', () => {
    it('generates a brief with plan details', () => {
      const plan = makePlan({
        id: 'pln_a',
        text: 'Implement feature X',
        priority: 'high',
        tags: ['sprint-5'],
        estimated_effort: 60,
      });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: [plan],
      }, testDir);

      const item = { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [], lane: 'vscode', rationale: 'First priority' };
      const brief = generateBrief(plan, item, testDir);

      assert.ok(brief.includes('Implement feature X'));
      assert.ok(brief.includes('Priority: high'));
      assert.ok(brief.includes('Lane: vscode'));
      assert.ok(brief.includes('First priority'));
      assert.ok(brief.includes('60 minutes'));
      assert.ok(brief.includes('bclaw_claim'));
    });

    it('includes handoff narrative from prior work', () => {
      const plan = makePlan({ id: 'pln_a', text: 'Continue feature X' });
      const handoff: Handoff = {
        id: 'hnd_test1',
        from: 'claude-code',
        to: 'codex',
        text: 'Started the work',
        created_at: '2026-04-01T01:00:00Z',
        author: 'claude-code',
        status: 'open',
        plan_id: 'pln_a',
        narrative: 'I implemented the core logic but tests are still missing.',
        tags: [],
      };
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const item = { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] };
      const brief = generateBrief(plan, item, testDir);

      assert.ok(brief.includes('Prior work on this plan'));
      assert.ok(brief.includes('I implemented the core logic'));
    });
  });

  describe('dispatch', () => {
    it('sends assignment messages to available agents', async () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'todo' }),
        makePlan({ id: 'pln_b', text: 'Task B', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [], lane: 'vscode' },
        { planId: 'pln_b', rank: 2, hard_after: [], soft_after: [], lane: 'testing' },
      ]), testDir);

      const result = (await dispatch({
        dispatcherAgent: 'coordinator',
      }, testDir))!;

      assert.ok(result);
      assert.equal(result.result.messages_sent.length, 2);
      // Each agent gets one assignment
      const agents = result.result.messages_sent.map(m => m.agent);
      assert.ok(agents.includes('claude-code'));
      assert.ok(agents.includes('codex'));
    });

    it('respects plan assignee preference', async () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'todo', assignee: 'codex' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
      ]), testDir);

      const result = (await dispatch({
        dispatcherAgent: 'coordinator',
      }, testDir))!;

      assert.equal(result.result.messages_sent[0]!.agent, 'codex');
    });

    it('dry run does not send messages', async () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
      ]), testDir);

      const result = (await dispatch({
        dispatcherAgent: 'coordinator',
        dryRun: true,
      }, testDir))!;

      assert.equal(result.result.messages_sent.length, 1);
      assert.equal(result.result.messages_sent[0]!.message_id, '(dry-run)');

      // Verify no actual message files created
      const inboxDir = path.join(testDir, '.brainclaw', 'coordination', 'inbox');
      const agentDirs = fs.readdirSync(inboxDir).filter(f =>
        fs.statSync(path.join(inboxDir, f)).isDirectory()
      );
      assert.equal(agentDirs.length, 0);
    });

    it('skips when all agents at full capacity', async () => {
      // claude-code has max_concurrent_tasks=3, codex has 5
      // Create enough plans+claims to saturate both
      const plans = [
        makePlan({ id: 'pln_target', text: 'Target task', status: 'todo' }),
        // 3 plans to saturate claude-code
        makePlan({ id: 'pln_cc1', text: 'CC1', status: 'in_progress' }),
        makePlan({ id: 'pln_cc2', text: 'CC2', status: 'in_progress' }),
        makePlan({ id: 'pln_cc3', text: 'CC3', status: 'in_progress' }),
        // 5 plans to saturate codex
        makePlan({ id: 'pln_cx1', text: 'CX1', status: 'in_progress' }),
        makePlan({ id: 'pln_cx2', text: 'CX2', status: 'in_progress' }),
        makePlan({ id: 'pln_cx3', text: 'CX3', status: 'in_progress' }),
        makePlan({ id: 'pln_cx4', text: 'CX4', status: 'in_progress' }),
        makePlan({ id: 'pln_cx5', text: 'CX5', status: 'in_progress' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      // Saturate claude-code (3 claims = max)
      saveClaim({ schema_version: 2, id: 'clm_cc1', agent: 'claude-code', scope: 'a', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cc1', status: 'active' }, testDir);
      saveClaim({ schema_version: 2, id: 'clm_cc2', agent: 'claude-code', scope: 'b', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cc2', status: 'active' }, testDir);
      saveClaim({ schema_version: 2, id: 'clm_cc3', agent: 'claude-code', scope: 'c', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cc3', status: 'active' }, testDir);
      // Saturate codex (5 claims = max)
      saveClaim({ schema_version: 2, id: 'clm_cx1', agent: 'codex', scope: 'd', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cx1', status: 'active' }, testDir);
      saveClaim({ schema_version: 2, id: 'clm_cx2', agent: 'codex', scope: 'e', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cx2', status: 'active' }, testDir);
      saveClaim({ schema_version: 2, id: 'clm_cx3', agent: 'codex', scope: 'f', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cx3', status: 'active' }, testDir);
      saveClaim({ schema_version: 2, id: 'clm_cx4', agent: 'codex', scope: 'g', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cx4', status: 'active' }, testDir);
      saveClaim({ schema_version: 2, id: 'clm_cx5', agent: 'codex', scope: 'h', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_cx5', status: 'active' }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_target', rank: 1, hard_after: [], soft_after: [] },
        { planId: 'pln_cc1', rank: 2, hard_after: [], soft_after: [] },
        { planId: 'pln_cc2', rank: 3, hard_after: [], soft_after: [] },
        { planId: 'pln_cc3', rank: 4, hard_after: [], soft_after: [] },
        { planId: 'pln_cx1', rank: 5, hard_after: [], soft_after: [] },
        { planId: 'pln_cx2', rank: 6, hard_after: [], soft_after: [] },
        { planId: 'pln_cx3', rank: 7, hard_after: [], soft_after: [] },
        { planId: 'pln_cx4', rank: 8, hard_after: [], soft_after: [] },
        { planId: 'pln_cx5', rank: 9, hard_after: [], soft_after: [] },
      ]), testDir);

      const result = (await dispatch({ dispatcherAgent: 'coordinator' }, testDir))!;
      assert.equal(result.result.messages_sent.length, 0, 'no messages — all agents at capacity');
      assert.equal(result.result.skipped.length, 1);
      assert.ok(result.result.skipped[0]!.reason.includes('No available agent'));
    });

    it('filters by lane', async () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'todo' }),
        makePlan({ id: 'pln_b', text: 'Task B', status: 'todo' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [], lane: 'vscode' },
        { planId: 'pln_b', rank: 2, hard_after: [], soft_after: [], lane: 'testing' },
      ]), testDir);

      const result = (await dispatch({
        dispatcherAgent: 'coordinator',
        lanes: ['testing'],
      }, testDir))!;

      assert.equal(result.result.messages_sent.length, 1);
      assert.equal(result.result.messages_sent[0]!.lane, 'testing');
    });

    it('returns null when no active sequence', async () => {
      const result = await dispatch({ dispatcherAgent: 'coordinator' }, testDir);
      assert.equal(result, null);
    });

    it('is idempotent — does not duplicate assignments on second run', async () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'todo', assignee: 'codex' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
      ]), testDir);

      // First dispatch — sends assignment and creates coordinator-owned claim
      const result1 = (await dispatch({ dispatcherAgent: 'coordinator' }, testDir))!;
      assert.equal(result1.result.messages_sent.length, 1);

      // Second dispatch — plan now has active claim, so it moves to "active" (not "ready")
      // This is the coordinator-owned claim idempotency: claimed plans are never re-dispatched
      const analysis2 = analyzeSequence(testDir)!;
      assert.equal(analysis2.ready.length, 0, 'plan with active claim is not ready');
      assert.equal(analysis2.active.length, 1, 'plan is active (has claim)');

      const result2 = (await dispatch({ dispatcherAgent: 'coordinator' }, testDir))!;
      assert.equal(result2.result.messages_sent.length, 0);
    });
  });

  describe('findReviewableHandoffs', () => {
    it('skips handoffs without plan_id', () => {
      const handoff = makeHandoff({ id: 'hnd_noplan', status: 'open' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = findReviewableHandoffs(testDir);
      assert.equal(result.length, 0);
    });

    it('skips handoffs when linked plan is not found', () => {
      const handoff = makeHandoff({ id: 'hnd_missing', status: 'open', plan_id: 'pln_ghost' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [],
      }, testDir);

      const result = findReviewableHandoffs(testDir);
      assert.equal(result.length, 0);
    });

    it('skips handoffs when plan is not done', () => {
      const handoff = makeHandoff({ id: 'hnd_notdone', status: 'open', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'in_progress' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = findReviewableHandoffs(testDir);
      assert.equal(result.length, 0);
    });

    it('skips closed handoffs', () => {
      const handoff = makeHandoff({ id: 'hnd_closed', status: 'closed', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = findReviewableHandoffs(testDir);
      assert.equal(result.length, 0);
    });

    it('skips handoffs with active review message', () => {
      const handoff = makeHandoff({ id: 'hnd_reviewed', status: 'open', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      // Create a review message in an agent inbox
      const inboxDir = path.join(testDir, '.brainclaw', 'coordination', 'inbox', 'codex');
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(path.join(inboxDir, 'msg_review1.json'), JSON.stringify({
        schema_version: 1,
        id: 'msg_review1',
        from: 'coordinator',
        to: 'codex',
        type: 'review',
        text: 'Review this',
        ref: 'hnd_reviewed',
        status: 'pending',
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
        author: 'coordinator',
        tags: ['review'],
      }));

      const result = findReviewableHandoffs(testDir);
      assert.equal(result.length, 0);
    });

    it('returns valid reviewable handoffs', () => {
      const handoff = makeHandoff({ id: 'hnd_good', status: 'open', plan_id: 'pln_a', narrative: 'Did the work' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = findReviewableHandoffs(testDir);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.handoff.id, 'hnd_good');
      assert.equal(result[0]!.plan!.id, 'pln_a');
    });
  });

  describe('dispatchReview', () => {
    it('sends review to available agent', () => {
      const handoff = makeHandoff({ id: 'hnd_ok', status: 'open', plan_id: 'pln_a', narrative: 'Completed the task' });
      const plan = makePlan({ id: 'pln_a', text: 'Implement feature', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = dispatchReview({
        dispatcherAgent: 'coordinator',
      }, testDir);

      assert.equal(result.reviews_sent.length, 1);
      assert.equal(result.reviews_sent[0]!.handoff_id, 'hnd_ok');
      assert.equal(result.reviews_sent[0]!.plan_id, 'pln_a');
      assert.equal(result.reviews_sent[0]!.channel, 'inbox');
      assert.ok(result.reviews_sent[0]!.thread_id?.startsWith('thr_'));
      // Reviewer should not be the author
      assert.notEqual(result.reviews_sent[0]!.reviewer, 'claude-code');

      const updated = loadState(testDir);
      const updatedHandoff = updated.open_handoffs.find((entry) => entry.id === 'hnd_ok');
      assert.equal(updatedHandoff?.review?.requester, 'coordinator');
      assert.equal(updatedHandoff?.review?.reviewer, result.reviews_sent[0]!.reviewer);
      assert.equal(updatedHandoff?.review?.thread_id, result.reviews_sent[0]!.thread_id);
      assert.equal(updatedHandoff?.review?.message_id, result.reviews_sent[0]!.message_id);
    });

    it('explicit handoffId applies same reviewability checks — closed', () => {
      const handoff = makeHandoff({ id: 'hnd_closed2', status: 'closed', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = dispatchReview({
        handoffId: 'hnd_closed2',
        dispatcherAgent: 'coordinator',
      }, testDir);

      assert.equal(result.reviews_sent.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.ok(result.skipped[0]!.reason.includes('closed'));
    });

    it('explicit handoffId applies same reviewability checks — no plan_id', () => {
      const handoff = makeHandoff({ id: 'hnd_noplan2', status: 'open' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [],
      }, testDir);

      const result = dispatchReview({
        handoffId: 'hnd_noplan2',
        dispatcherAgent: 'coordinator',
      }, testDir);

      assert.equal(result.reviews_sent.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.ok(result.skipped[0]!.reason.includes('no linked plan'));
    });

    it('explicit handoffId applies same reviewability checks — plan not done', () => {
      const handoff = makeHandoff({ id: 'hnd_notdone2', status: 'open', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'in_progress' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = dispatchReview({
        handoffId: 'hnd_notdone2',
        dispatcherAgent: 'coordinator',
      }, testDir);

      assert.equal(result.reviews_sent.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.ok(result.skipped[0]!.reason.includes('not done'));
    });

    it('explicit handoffId applies same reviewability checks — active review exists', () => {
      const handoff = makeHandoff({ id: 'hnd_hasreview', status: 'open', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      // Create existing review message
      const inboxDir = path.join(testDir, '.brainclaw', 'coordination', 'inbox', 'codex');
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(path.join(inboxDir, 'msg_rev2.json'), JSON.stringify({
        schema_version: 1,
        id: 'msg_rev2',
        from: 'coordinator',
        to: 'codex',
        type: 'review',
        text: 'Review this',
        ref: 'hnd_hasreview',
        status: 'pending',
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
        author: 'coordinator',
        tags: ['review'],
      }));

      const result = dispatchReview({
        handoffId: 'hnd_hasreview',
        dispatcherAgent: 'coordinator',
      }, testDir);

      assert.equal(result.reviews_sent.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.ok(result.skipped[0]!.reason.includes('review already exists'));
    });

    it('dry run does not send messages', () => {
      const handoff = makeHandoff({ id: 'hnd_dry', status: 'open', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Task A', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = dispatchReview({
        dispatcherAgent: 'coordinator',
        dryRun: true,
      }, testDir);

      assert.equal(result.reviews_sent.length, 1);
      assert.equal(result.reviews_sent[0]!.message_id, '(dry-run)');
      assert.equal(result.reviews_sent[0]!.handoff_id, 'hnd_dry');
      const updated = loadState(testDir);
      assert.equal(updated.open_handoffs[0]?.review, undefined);
    });

    it('opens a review Loop alongside the inbox message by default (pln#395 residual #1)', async () => {
      const handoff = makeHandoff({ id: 'hnd_loop', status: 'open', plan_id: 'pln_loop', narrative: 'Shipped the thing' });
      const plan = makePlan({ id: 'pln_loop', text: 'Ship the thing', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = dispatchReview({
        dispatcherAgent: 'coordinator',
      }, testDir);

      assert.equal(result.reviews_sent.length, 1);
      assert.ok(result.reviews_sent[0]!.loop_id, 'loop_id must be surfaced');
      assert.match(result.reviews_sent[0]!.loop_id!, /^lop_/);

      // Verify the loop is actually persisted with the right shape:
      // author slot = handoff.from, reviewer slot = dispatched reviewer,
      // current_phase = findings after the automatic advance, handoff linked
      // as change_summary artifact.
      const loopsModule = await import('../../src/core/loops/index.js');
      const loop = loopsModule.getLoop(result.reviews_sent[0]!.loop_id!, testDir);
      assert.ok(loop, 'loop must exist on disk');
      assert.equal(loop!.kind, 'review');
      assert.equal(loop!.current_phase, 'findings');
      assert.deepEqual(loop!.linked?.plan_ids, ['pln_loop']);
      const reviewerSlot = loop!.slots.find((s) => s.role === 'reviewer');
      assert.ok(reviewerSlot);
      assert.equal(reviewerSlot!.status, 'assigned');
      const changeSummary = loop!.artifacts.find((a) => a.phase === 'change_summary');
      assert.ok(changeSummary, 'handoff linked as change_summary');
      assert.equal(changeSummary!.ref?.kind, 'handoff');
      assert.equal(changeSummary!.ref?.id, 'hnd_loop');
    });

    it('openLoop=false falls back to legacy inbox-only dispatch (pln#395 residual #1 opt-out)', () => {
      const handoff = makeHandoff({ id: 'hnd_noloop', status: 'open', plan_id: 'pln_noloop' });
      const plan = makePlan({ id: 'pln_noloop', text: 'Task', status: 'done' });
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [handoff], plan_items: [plan],
      }, testDir);

      const result = dispatchReview({
        dispatcherAgent: 'coordinator',
        openLoop: false,
      }, testDir);

      assert.equal(result.reviews_sent.length, 1);
      assert.equal(result.reviews_sent[0]!.loop_id, undefined, 'no loop when openLoop=false');
    });
  });

  describe('generateReviewBrief', () => {
    it('includes plan text', () => {
      const handoff = makeHandoff({ id: 'hnd_b1', status: 'open', plan_id: 'pln_a' });
      const plan = makePlan({ id: 'pln_a', text: 'Implement the payment flow' });

      const brief = generateReviewBrief(handoff, plan);
      assert.ok(brief.includes('Implement the payment flow'));
      assert.ok(brief.includes('pln_a'));
    });

    it('includes narrative', () => {
      const handoff = makeHandoff({ id: 'hnd_b2', status: 'open', narrative: 'I refactored the auth module and added tests.' });

      const brief = generateReviewBrief(handoff);
      assert.ok(brief.includes('I refactored the auth module and added tests.'));
      assert.ok(brief.includes('What was done'));
    });

    it('includes review criteria', () => {
      const handoff = makeHandoff({ id: 'hnd_b3', status: 'open' });

      const brief = generateReviewBrief(handoff);
      assert.ok(brief.includes('Review criteria'));
      assert.ok(brief.includes('Scope'));
      assert.ok(brief.includes('Bugs/Regressions'));
      assert.ok(brief.includes('Completeness'));
      assert.ok(brief.includes('APPROVE or REQUEST_CHANGES'));
    });

    it('includes pre_conditions and linked_plans from contract', () => {
      const handoff = makeHandoff({
        id: 'hnd_b4',
        status: 'open',
        contract: {
          pre_conditions: ['Auth module must be initialized', 'DB migrations applied'],
          linked_plans: ['pln_x', 'pln_y'],
          files_touched: ['src/auth.ts'],
          post_conditions: ['Login works'],
          tests_to_verify: ['auth.test.ts'],
        },
      });

      const brief = generateReviewBrief(handoff);
      assert.ok(brief.includes('Pre-conditions'));
      assert.ok(brief.includes('Auth module must be initialized'));
      assert.ok(brief.includes('DB migrations applied'));
      assert.ok(brief.includes('Linked plans'));
      assert.ok(brief.includes('pln_x'));
      assert.ok(brief.includes('pln_y'));
      assert.ok(brief.includes('Files touched'));
      assert.ok(brief.includes('Post-conditions to verify'));
      assert.ok(brief.includes('Tests to verify'));
    });

    it('includes plan steps', () => {
      const plan = makePlan({
        id: 'pln_steps',
        text: 'Multi-step plan',
        steps: [
          { id: 'stp_1', text: 'Step one', status: 'done', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
          { id: 'stp_2', text: 'Step two', status: 'todo', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
        ],
      });
      const handoff = makeHandoff({ id: 'hnd_b5', status: 'open', plan_id: 'pln_steps' });

      const brief = generateReviewBrief(handoff, plan);
      assert.ok(brief.includes('Plan steps'));
      assert.ok(brief.includes('[x] Step one'));
      assert.ok(brief.includes('[ ] Step two'));
    });
  });

  describe('analyzeSequence — claim liveness on active lanes (pln#388 stp_aa095668)', () => {
    let testDir: string;
    beforeEach(() => {
      testDir = createTestStore();
      setupAgents(testDir);
    });
    afterEach(() => {
      cleanupTestStore(testDir);
    });

    it('surfaces liveness="never-adopted" on an active lane whose coordinator claim was never adopted', () => {
      const plan = makePlan({ id: 'pln_nl1', text: 'lane plan', status: 'in_progress' });
      const state = loadState(testDir);
      state.plan_items = [plan];
      persistState(state, testDir);

      // 30h-old claim with no session_id → never-adopted
      const staleClaim: Claim = {
        schema_version: 2,
        id: 'clm_never_lane',
        agent: 'claude-code',
        scope: 'src/foo.ts',
        description: 'Never adopted',
        created_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
        status: 'active',
        plan_id: 'pln_nl1',
      };
      saveClaim(staleClaim, testDir);

      saveSequence(makeSequence([
        { rank: 1, planId: 'pln_nl1', hard_after: [], soft_after: [] },
      ]), testDir);

      const analysis = analyzeSequence(testDir)!;
      assert.equal(analysis.active.length, 1);
      assert.equal(analysis.active[0]!.liveness, 'never-adopted');
    });

    it('marks a young lane claim as liveness="young" (not released by dispatch sweeps)', () => {
      const plan = makePlan({ id: 'pln_yl1', text: 'young lane', status: 'in_progress' });
      const state = loadState(testDir);
      state.plan_items = [plan];
      persistState(state, testDir);

      const freshClaim: Claim = {
        schema_version: 2,
        id: 'clm_young_lane',
        agent: 'claude-code',
        scope: 'src/bar.ts',
        description: 'Just created',
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago
        status: 'active',
        plan_id: 'pln_yl1',
      };
      saveClaim(freshClaim, testDir);

      saveSequence(makeSequence([
        { rank: 1, planId: 'pln_yl1', hard_after: [], soft_after: [] },
      ]), testDir);

      const analysis = analyzeSequence(testDir)!;
      assert.equal(analysis.active[0]!.liveness, 'young');
    });
  });
});
