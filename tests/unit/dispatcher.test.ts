import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeSequence, generateBrief, dispatch, findReviewableHandoffs, generateReviewBrief, dispatchReview } from '../../src/core/dispatcher.js';
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

    it('marks busy agents as unavailable', () => {
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
      assert.ok(!result.available_agents.includes('claude-code'));
      assert.ok(result.available_agents.includes('codex'));
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
    it('sends assignment messages to available agents', () => {
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

      const result = dispatch({
        dispatcherAgent: 'coordinator',
      }, testDir)!;

      assert.ok(result);
      assert.equal(result.result.messages_sent.length, 2);
      // Each agent gets one assignment
      const agents = result.result.messages_sent.map(m => m.agent);
      assert.ok(agents.includes('claude-code'));
      assert.ok(agents.includes('codex'));
    });

    it('respects plan assignee preference', () => {
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

      const result = dispatch({
        dispatcherAgent: 'coordinator',
      }, testDir)!;

      assert.equal(result.result.messages_sent[0]!.agent, 'codex');
    });

    it('dry run does not send messages', () => {
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

      const result = dispatch({
        dispatcherAgent: 'coordinator',
        dryRun: true,
      }, testDir)!;

      assert.equal(result.result.messages_sent.length, 1);
      assert.equal(result.result.messages_sent[0]!.message_id, '(dry-run)');

      // Verify no actual message files created
      const inboxDir = path.join(testDir, '.brainclaw', 'coordination', 'inbox');
      const agentDirs = fs.readdirSync(inboxDir).filter(f =>
        fs.statSync(path.join(inboxDir, f)).isDirectory()
      );
      assert.equal(agentDirs.length, 0);
    });

    it('skips when no agents available', () => {
      const plans = [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'todo' }),
        makePlan({ id: 'pln_b', text: 'Task B', status: 'in_progress' }),
        makePlan({ id: 'pln_c', text: 'Task C', status: 'in_progress' }),
      ];
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: plans,
      }, testDir);

      // Both agents are busy
      saveClaim({ schema_version: 2, id: 'clm_1', agent: 'claude-code', scope: 'src/a.ts', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_b', status: 'active' }, testDir);
      saveClaim({ schema_version: 2, id: 'clm_2', agent: 'codex', scope: 'src/b.ts', description: 'w', created_at: '2026-04-01T00:00:00Z', plan_id: 'pln_c', status: 'active' }, testDir);

      saveSequence(makeSequence([
        { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
        { planId: 'pln_b', rank: 2, hard_after: [], soft_after: [] },
        { planId: 'pln_c', rank: 3, hard_after: [], soft_after: [] },
      ]), testDir);

      const result = dispatch({ dispatcherAgent: 'coordinator' }, testDir)!;
      assert.equal(result.result.messages_sent.length, 0);
      assert.equal(result.result.skipped.length, 1);
      assert.ok(result.result.skipped[0]!.reason.includes('No available agent'));
    });

    it('filters by lane', () => {
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

      const result = dispatch({
        dispatcherAgent: 'coordinator',
        lanes: ['testing'],
      }, testDir)!;

      assert.equal(result.result.messages_sent.length, 1);
      assert.equal(result.result.messages_sent[0]!.lane, 'testing');
    });

    it('returns null when no active sequence', () => {
      const result = dispatch({ dispatcherAgent: 'coordinator' }, testDir);
      assert.equal(result, null);
    });

    it('is idempotent — does not duplicate assignments on second run', () => {
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
      const result1 = dispatch({ dispatcherAgent: 'coordinator' }, testDir)!;
      assert.equal(result1.result.messages_sent.length, 1);

      // Second dispatch — plan now has active claim, so it moves to "active" (not "ready")
      // This is the coordinator-owned claim idempotency: claimed plans are never re-dispatched
      const analysis2 = analyzeSequence(testDir)!;
      assert.equal(analysis2.ready.length, 0, 'plan with active claim is not ready');
      assert.equal(analysis2.active.length, 1, 'plan is active (has claim)');

      const result2 = dispatch({ dispatcherAgent: 'coordinator' }, testDir)!;
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
      // Reviewer should not be the author
      assert.notEqual(result.reviews_sent[0]!.reviewer, 'claude-code');
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
});
