/**
 * Regression tests for the dispatch system.
 *
 * Covers analyzeSequence categorisation, buildInvokeCommand output,
 * and generateBrief content — with emphasis on edge cases and
 * cross-cutting concerns not already in dispatcher.test.ts.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  analyzeSequence,
  dispatch,
  generateBrief,
  buildProtocolSection,
  generateDispatchBrief,
} from '../../src/core/dispatcher.js';
import { buildInvokeCommand } from '../../src/core/agent-capability.js';
import { saveSequence } from '../../src/core/sequence.js';
import { listClaims, saveClaim } from '../../src/core/claims.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
import { readInbox } from '../../src/core/messaging.js';
import type { PlanItem, Sequence, Claim } from '../../src/core/schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-dispatch-regr-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/plans',
    'coordination/sequences',
    'coordination/claims',
    'coordination/handoffs',
    'coordination/inbox',
    'coordination/sessions',
    'memory/constraints',
    'memory/decisions',
    'memory/traps',
    'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_regr\n');
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

function makeSequence(items: Sequence['items']): Sequence {
  return {
    schema_version: 2,
    id: 'seq_regr001',
    name: 'regression-sequence',
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

// ── analyzeSequence ────────────────────────────────────────────────────────

describe('dispatch-regression/analyzeSequence', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestStore();
    setupAgents(testDir);
  });

  afterEach(() => {
    cleanupTestStore(testDir);
  });

  it('items with no deps and todo status are ready', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_r1', text: 'Ready task', status: 'todo' }),
      ],
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_r1', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    assert.ok(result, 'analyzeSequence should return a result');
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0]!.plan.id, 'pln_r1');
    assert.equal(result.blocked.length, 0);
    assert.equal(result.done.length, 0);
    assert.equal(result.active.length, 0);
  });

  it('items with unmet hard_after are blocked', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_dep', text: 'Dependency', status: 'todo' }),
        makePlan({ id: 'pln_child', text: 'Dependent child', status: 'todo' }),
      ],
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_dep', rank: 1, hard_after: [], soft_after: [] },
      { planId: 'pln_child', rank: 2, hard_after: ['pln_dep'], soft_after: [] },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0]!.item.planId, 'pln_child');
    assert.ok(result.blocked[0]!.blocked_by.includes('pln_dep'));
    assert.ok(result.blocked[0]!.reason.includes('hard dependencies'));
    // The dependency itself is ready (no deps, not done)
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0]!.plan.id, 'pln_dep');
  });

  it('items linked to in_progress plans with active claims are active', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_wip', text: 'Work in progress', status: 'in_progress' }),
      ],
    }, testDir);

    const claim: Claim = {
      schema_version: 2,
      id: 'clm_wip',
      agent: 'claude-code',
      scope: 'src/core/wip.ts',
      description: 'Working on it',
      created_at: '2026-04-01T00:00:00Z',
      plan_id: 'pln_wip',
      status: 'active',
    };
    saveClaim(claim, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_wip', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0]!.plan.id, 'pln_wip');
    assert.equal(result.active[0]!.agent, 'claude-code');
    assert.equal(result.ready.length, 0);
  });

  it('items linked to done plans are categorised as done', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_done', text: 'Already done', status: 'done' }),
        makePlan({ id: 'pln_next', text: 'Now unblocked', status: 'todo' }),
      ],
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_done', rank: 1, hard_after: [], soft_after: [] },
      { planId: 'pln_next', rank: 2, hard_after: ['pln_done'], soft_after: [] },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    assert.equal(result.done.length, 1);
    assert.equal(result.done[0]!.planId, 'pln_done');
    // With pln_done in terminal state, pln_next hard_after is satisfied → ready
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0]!.plan.id, 'pln_next');
    assert.equal(result.blocked.length, 0);
  });

  it('items linked to dropped plans are categorised as done', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_dropped', text: 'Was dropped', status: 'dropped' }),
        makePlan({ id: 'pln_unblocked', text: 'Unblocked by drop', status: 'todo' }),
      ],
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_dropped', rank: 1, hard_after: [], soft_after: [] },
      { planId: 'pln_unblocked', rank: 2, hard_after: ['pln_dropped'], soft_after: [] },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    // Dropped is terminal — counts as done in the sequence
    assert.equal(result.done.length, 1);
    assert.equal(result.done[0]!.planId, 'pln_dropped');
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0]!.plan.id, 'pln_unblocked');
  });

  it('3-item sequence: one done, one active, one blocked', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_a', text: 'Task A', status: 'done' }),
        makePlan({ id: 'pln_b', text: 'Task B', status: 'in_progress' }),
        makePlan({ id: 'pln_c', text: 'Task C', status: 'todo' }),
      ],
    }, testDir);

    // pln_c needs pln_b to be done first
    saveClaim({
      schema_version: 2,
      id: 'clm_b',
      agent: 'codex',
      scope: 'src/b.ts',
      description: 'Working on B',
      created_at: '2026-04-01T00:00:00Z',
      plan_id: 'pln_b',
      status: 'active',
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_a', rank: 1, hard_after: [], soft_after: [] },
      { planId: 'pln_b', rank: 2, hard_after: ['pln_a'], soft_after: [], lane: 'lane-b' },
      { planId: 'pln_c', rank: 3, hard_after: ['pln_b'], soft_after: [], lane: 'lane-c' },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    assert.equal(result.done.length, 1, 'one done item');
    assert.equal(result.active.length, 1, 'one active item');
    assert.equal(result.blocked.length, 1, 'one blocked item');
    assert.equal(result.ready.length, 0, 'nothing ready');

    assert.equal(result.done[0]!.planId, 'pln_a');
    assert.equal(result.active[0]!.plan.id, 'pln_b');
    assert.equal(result.active[0]!.lane, 'lane-b');
    assert.equal(result.blocked[0]!.item.planId, 'pln_c');
  });

  it('soft_after deps do not block, only note in reason', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_soft_dep', text: 'Soft dep not done', status: 'todo' }),
        makePlan({ id: 'pln_soft_child', text: 'Soft-deps item', status: 'todo' }),
      ],
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_soft_dep', rank: 1, hard_after: [], soft_after: [] },
      { planId: 'pln_soft_child', rank: 2, hard_after: [], soft_after: ['pln_soft_dep'] },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    // Both should be ready — soft deps are advisory only
    assert.equal(result.ready.length, 2, 'both items are ready despite soft dep');
    assert.equal(result.blocked.length, 0, 'soft deps must not block');
    const child = result.ready.find(r => r.plan.id === 'pln_soft_child');
    assert.ok(child, 'child is in ready list');
    assert.ok(child!.reason.includes('soft deps not yet done'), 'reason notes the unmet soft dep');
  });

  it('returns sequence metadata on the result', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_meta', text: 'Meta task', status: 'todo' }),
      ],
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_meta', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = analyzeSequence(testDir)!;
    assert.ok(result.sequence, 'sequence metadata is present');
    assert.equal(result.sequence.name, 'regression-sequence');
    assert.equal(result.sequence.status, 'active');
  });
});

describe('dispatch-regression/dispatch', () => {
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

  it('reuses an existing active claim for the same agent and scope', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_dispatch_reuse', text: 'Dispatch with reused claim', assignee: 'codex', status: 'todo' }),
      ],
    }, testDir);

    saveSequence(makeSequence([
      { planId: 'pln_dispatch_reuse', rank: 1, hard_after: [], soft_after: [], scope_hint: 'src/core/reused-claim.ts' },
    ]), testDir);

    saveClaim({
      schema_version: 2,
      id: 'clm_existing_dispatch',
      agent: 'codex',
      scope: 'src/core/reused-claim.ts',
      description: 'Existing dispatcher claim',
      created_at: '2026-04-01T00:00:00Z',
      status: 'active',
    }, testDir);

    const dispatchResult = await dispatch({
      dispatcherAgent: 'claude-code',
      agents: ['codex'],
    }, testDir);

    assert.ok(dispatchResult, 'dispatch should return a result');
    assert.equal(dispatchResult.result.delivery_plan.length, 1, 'dispatch should return one delivery_plan entry');
    assert.equal(dispatchResult.result.delivery_plan[0]?.claim_id, 'clm_existing_dispatch');
    const activeClaims = listClaims(testDir).filter(c => c.status === 'active');
    assert.equal(activeClaims.length, 1, 'dispatch should not create a duplicate active claim');
    assert.equal(activeClaims[0]?.id, 'clm_existing_dispatch');

    const inbox = readInbox({ agent: 'codex', markAsRead: false }, testDir);
    const assignMsg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(assignMsg, 'dispatch should still send an assignment message');
    assert.equal(assignMsg?.payload?.claim_id, 'clm_existing_dispatch');
  });
});

// ── buildInvokeCommand ─────────────────────────────────────────────────────

describe('dispatch-regression/buildInvokeCommand', () => {
  // buildInvokeCommand now lives in agent-capability.ts and returns InvokeCommand | undefined
  // (no longer throws, returns undefined for unknown/IDE-only agents)

  it('claude-code worker: produces claude -p with --allowedTools', () => {
    const result = buildInvokeCommand('claude-code', 'Do the task', { mode: 'worker' });
    assert.ok(result, 'should return InvokeCommand');
    assert.ok(result.bashCommand.includes('claude'), 'command includes claude');
    assert.ok(result.bashCommand.includes('-p'), 'uses -p flag');
    assert.ok(result.bashCommand.includes('--allowedTools'), 'includes --allowedTools');
    assert.ok(result.bashCommand.includes('Edit,Write,Bash,Read,Glob,Grep'), 'worker tools included');
    assert.equal(result.promptDelivery, 'stdin_pipe', 'claude-code uses stdin_pipe delivery');
    assert.equal(result.executable, 'claude');
  });

  it('claude-code reviewer: uses read-only tools', () => {
    const result = buildInvokeCommand('claude-code', 'Review this code', { mode: 'reviewer' });
    assert.ok(result, 'should return InvokeCommand');
    assert.ok(result.bashCommand.includes('Read,Glob,Grep') || result.bashCommand.includes('Read'), 'reviewer tools are read-only');
  });

  it('claude-code consult: uses read-only tools (same as reviewer)', () => {
    const result = buildInvokeCommand('claude-code', 'Advise on approach', { mode: 'consult' });
    assert.ok(result, 'should return InvokeCommand');
    assert.ok(result.bashCommand.includes('Read') || result.bashCommand.includes('Grep'), 'consult uses read-only tools');
  });

  it('codex worker: produces codex exec with approval_policy override, workspace-write sandbox, and inline_arg delivery', () => {
    const result = buildInvokeCommand('codex', 'Implement the feature', { mode: 'worker' });
    assert.ok(result, 'should return InvokeCommand');
    assert.ok(result.bashCommand.includes('codex'), 'command includes codex');
    assert.ok(result.bashCommand.includes('approval_policy'), 'overrides approval policy');
    assert.ok(result.bashCommand.includes('--sandbox'), 'uses --sandbox flag');
    assert.ok(result.bashCommand.includes('workspace-write'), 'uses workspace-write sandbox');
    assert.equal(result.promptDelivery, 'inline_arg', 'codex uses inline_arg delivery');
    assert.equal(result.executable, 'codex');
  });

  it('unknown agent returns undefined', () => {
    const result = buildInvokeCommand('unknown-agent-xyz', 'brief');
    assert.equal(result, undefined, 'unknown agent returns undefined');
  });

  it('ide-only agent (cursor) returns undefined — no invoke template', () => {
    const result = buildInvokeCommand('cursor', 'brief');
    assert.equal(result, undefined, 'cursor (IDE-only) returns undefined');
  });

  it('command does not contain unreplaced {cwd} placeholder', () => {
    const result = buildInvokeCommand('claude-code', 'Task', { mode: 'worker' });
    assert.ok(result, 'should return InvokeCommand');
    assert.ok(!result.bashCommand.includes('{cwd}'), 'no unreplaced {cwd} placeholder');
  });

  it('long briefs for inline-first agents fall back to temp_file delivery', () => {
    const longBrief = 'x'.repeat(9000);
    const result = buildInvokeCommand('opencode', longBrief, { mode: 'worker' });
    assert.ok(result, 'should return InvokeCommand');
    assert.equal(result.promptDelivery, 'temp_file', 'long brief triggers temp_file delivery');
    assert.ok(result.bashCommand.includes('bclaw_prompt_'), 'command references a temp file path');
  });

  it('claude-code uses piped stdin on POSIX when platform override is linux', () => {
    const result = buildInvokeCommand('claude-code', 'Do the task', {
      mode: 'worker',
      platform: 'linux',
    });
    assert.ok(result, 'should return InvokeCommand');
    assert.equal(result.promptDelivery, 'stdin_pipe');
    assert.ok(result.bashCommand.includes("printf '%s'"), 'POSIX command pipes prompt through printf');
    assert.ok(result.bashCommand.includes('| claude'), 'POSIX command pipes into claude');
  });

  it('claude-code omits stdin piping in manual Windows command generation', () => {
    const result = buildInvokeCommand('claude-code', 'Do the task', {
      mode: 'worker',
      platform: 'win32',
    });
    assert.ok(result, 'should return InvokeCommand');
    assert.equal(result.promptDelivery, 'stdin_pipe');
    assert.ok(!result.bashCommand.includes("printf '%s'"), 'Windows command does not embed POSIX printf piping');
    assert.ok(result.bashCommand.startsWith('claude '), 'Windows command is still directly invokable');
  });

  it('temp_file delivery differs between POSIX and Windows command rendering', () => {
    const longBrief = 'x'.repeat(9000);
    const posix = buildInvokeCommand('opencode', longBrief, { mode: 'worker', platform: 'linux' });
    const win = buildInvokeCommand('opencode', longBrief, { mode: 'worker', platform: 'win32' });

    assert.ok(posix && win, 'both platform variants resolve');
    assert.equal(posix.promptDelivery, 'temp_file');
    assert.equal(win.promptDelivery, 'temp_file');
    assert.ok(posix.bashCommand.includes("printf '%s'"), 'POSIX temp_file command writes the file before invoke');
    assert.ok(!win.bashCommand.includes("printf '%s'"), 'Windows temp_file command assumes caller wrote the file');
    assert.ok(win.bashCommand.includes('bclaw_prompt_'), 'Windows command still references the temp file');
  });
});

// ── generateBrief ──────────────────────────────────────────────────────────

describe('dispatch-regression/generateBrief', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestStore();
  });

  afterEach(() => {
    cleanupTestStore(testDir);
  });

  it('contains the plan text in the output', () => {
    const plan = makePlan({ id: 'pln_gb1', text: 'Build the login page' });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = { planId: 'pln_gb1', rank: 1, hard_after: [], soft_after: [] };
    const brief = generateBrief(plan, item, testDir);

    assert.ok(brief.includes('Build the login page'), 'brief includes plan text');
  });

  it('contains protocol section with bclaw tools', () => {
    const plan = makePlan({ id: 'pln_gb2', text: 'Some task' });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = { planId: 'pln_gb2', rank: 1, hard_after: [], soft_after: [] };
    const brief = generateBrief(plan, item, testDir);

    assert.ok(brief.includes('bclaw_claim'), 'brief includes bclaw_claim');
    assert.ok(brief.includes('bclaw_session_start'), 'brief includes session start');
    assert.ok(brief.includes('bclaw_session_end'), 'brief includes session end');
  });

  it('brief is non-empty and has reasonable length', () => {
    const plan = makePlan({ id: 'pln_gb3', text: 'Do something' });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = { planId: 'pln_gb3', rank: 1, hard_after: [], soft_after: [] };
    const brief = generateBrief(plan, item, testDir);

    assert.ok(brief.length > 100, 'brief is not trivially short');
    assert.ok(brief.length < 50_000, 'brief is not excessively long');
  });

  it('includes plan tags when present', () => {
    const plan = makePlan({
      id: 'pln_gb4',
      text: 'Tagged task',
      tags: ['sprint-7', 'auth'],
    });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = { planId: 'pln_gb4', rank: 1, hard_after: [], soft_after: [] };
    const brief = generateBrief(plan, item, testDir);

    assert.ok(brief.includes('sprint-7'), 'brief includes tag sprint-7');
    assert.ok(brief.includes('auth'), 'brief includes tag auth');
  });

  it('includes steps checklist when plan has steps', () => {
    const plan = makePlan({
      id: 'pln_gb5',
      text: 'Multi-step task',
      steps: [
        { id: 'stp_1', text: 'Step one', status: 'done', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
        { id: 'stp_2', text: 'Step two', status: 'todo', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
      ],
    });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = { planId: 'pln_gb5', rank: 1, hard_after: [], soft_after: [] };
    const brief = generateBrief(plan, item, testDir);

    assert.ok(brief.includes('[x] Step one'), 'done step is checked');
    assert.ok(brief.includes('[ ] Step two'), 'todo step is unchecked');
  });

  it('includes lane and rationale from sequence item', () => {
    const plan = makePlan({ id: 'pln_gb6', text: 'Lane-aware task' });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = {
      planId: 'pln_gb6',
      rank: 1,
      hard_after: [],
      soft_after: [],
      lane: 'implementation',
      rationale: 'This must be done before testing can start',
    };
    const brief = generateBrief(plan, item, testDir);

    assert.ok(brief.includes('Lane: implementation'), 'brief includes lane');
    assert.ok(brief.includes('This must be done before testing can start'), 'brief includes rationale');
  });

  it('includes scope_hint from sequence item when present', () => {
    const plan = makePlan({ id: 'pln_gb7', text: 'Scoped task' });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = {
      planId: 'pln_gb7',
      rank: 1,
      hard_after: [],
      soft_after: [],
      scope_hint: 'src/core/auth.ts and related tests',
    };
    const brief = generateBrief(plan, item, testDir);

    assert.ok(brief.includes('src/core/auth.ts and related tests'), 'brief includes scope hint');
  });
});

// ── buildProtocolSection / generateDispatchBrief ───────────────────────────

describe('dispatch-regression/buildProtocolSection', () => {
  it('includes bclaw_release_claim with planStatus=done in full-mode brief (claimId path)', () => {
    const section = buildProtocolSection({ claimId: 'clm_test123' });
    assert.ok(section.includes('bclaw_release_claim'), 'protocol includes release claim tool');
    assert.ok(section.includes('planStatus: "done"'), 'release step specifies planStatus done');
    assert.ok(
      section.includes('hard_after') || section.includes('sequence gating'),
      'release step mentions hard_after gating',
    );
  });

  it('includes bclaw_release_claim in full-mode brief (assignmentId + claimId path)', () => {
    const section = buildProtocolSection({
      assignmentId: 'asgn_abc',
      claimId: 'clm_xyz',
      worktreePath: '/some/worktree',
    });
    assert.ok(section.includes('bclaw_release_claim'), 'protocol includes release claim');
    assert.ok(section.includes('clm_xyz'), 'release step references the provided claim id');
    assert.ok(section.includes('planStatus: "done"'), 'release step specifies planStatus done');
  });

  it('includes bclaw_release_claim in default path (no claimId, no assignmentId)', () => {
    const section = buildProtocolSection();
    assert.ok(section.includes('bclaw_release_claim'), 'default protocol includes release claim');
    assert.ok(section.includes('planStatus: "done"'), 'release step specifies planStatus done');
  });
});

describe('dispatch-regression/generateDispatchBrief', () => {
  it('includes Constraints section when agent is codex', () => {
    const brief = generateDispatchBrief({
      task: 'Implement the feature',
      agent: 'codex',
      claimId: 'clm_codex1',
    });
    assert.ok(brief.includes('## Constraints'), 'codex brief includes Constraints section');
    assert.ok(
      brief.includes('do not explore the broader codebase'),
      'codex constraints warn against broad exploration',
    );
    assert.ok(
      brief.includes('Sandbox blocks MCP writes'),
      'codex constraints mention sandbox MCP write limitation',
    );
  });

  it('does not include Constraints section for non-codex agents', () => {
    const brief = generateDispatchBrief({
      task: 'Implement the feature',
      agent: 'claude-code',
      claimId: 'clm_claude1',
    });
    assert.ok(!brief.includes('## Constraints'), 'claude-code brief omits Constraints section');
    assert.ok(
      !brief.includes('Sandbox blocks MCP writes'),
      'claude-code brief omits codex sandbox warning',
    );
  });
});

// ── brief-hardening: release claim step + codex constraints ───────────────

describe('dispatch-regression/brief-hardening', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestStore();
  });

  afterEach(() => {
    cleanupTestStore(testDir);
  });

  // GAP 1a: release claim step in full-mode briefs

  it('buildProtocolSection includes bclaw_release_claim with planStatus done (assignmentId path)', () => {
    const section = buildProtocolSection({
      claimId: 'clm_abc123',
      assignmentId: 'asgn_xyz',
    });
    assert.ok(section.includes('bclaw_release_claim'), 'release claim step is present');
    assert.ok(section.includes('planStatus: "done"'), 'planStatus done is specified');
    assert.ok(section.includes('hard_after'), 'mentions hard_after gating');
  });

  it('buildProtocolSection includes bclaw_release_claim with planStatus done (claimId-only path)', () => {
    const section = buildProtocolSection({
      claimId: 'clm_def456',
    });
    assert.ok(section.includes('bclaw_release_claim'), 'release claim step is present');
    assert.ok(section.includes('planStatus: "done"'), 'planStatus done is specified');
    assert.ok(section.includes('clm_def456'), 'claim ID is embedded in the release step');
  });

  it('full-mode generateBrief includes bclaw_release_claim step', () => {
    const plan = makePlan({ id: 'pln_hrd1', text: 'Hardened brief task' });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = { planId: 'pln_hrd1', rank: 1, hard_after: [], soft_after: [] };
    const brief = generateBrief(plan, item, testDir, 'full', { claimId: 'clm_hrd1' });

    assert.ok(brief.includes('bclaw_release_claim'), 'full-mode brief includes release claim step');
    assert.ok(brief.includes('planStatus: "done"'), 'release step specifies planStatus done');
  });

  // GAP 7: codex constraints section

  it('generateDispatchBrief includes ## Constraints section when agent=codex', () => {
    const brief = generateDispatchBrief({
      task: 'Implement feature X',
      agent: 'codex',
      claimId: 'clm_codex1',
      scope: 'src/core/feature-x.ts',
    });
    assert.ok(brief.includes('## Constraints'), 'codex brief has Constraints section');
    assert.ok(
      brief.includes('Focus on specified files only'),
      'codex brief warns against broad exploration',
    );
    assert.ok(
      brief.includes('Sandbox blocks MCP writes'),
      'codex brief mentions sandbox MCP limitation',
    );
  });

  it('generateDispatchBrief does NOT include ## Constraints section for non-codex agents', () => {
    const brief = generateDispatchBrief({
      task: 'Implement feature Y',
      agent: 'claude-code',
      claimId: 'clm_claude1',
      assignmentId: 'asgn_claude1',
      scope: 'src/core/feature-y.ts',
    });
    assert.ok(
      !brief.includes('Sandbox blocks MCP writes'),
      'non-codex brief does not include codex sandbox constraint',
    );
  });
});
