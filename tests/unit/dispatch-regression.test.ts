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
  buildInvokeCommand,
  generateBrief,
} from '../../src/core/dispatcher.js';
import { saveSequence } from '../../src/core/sequence.js';
import { saveClaim } from '../../src/core/claims.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
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

// ── buildInvokeCommand ─────────────────────────────────────────────────────

describe('dispatch-regression/buildInvokeCommand', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestStore();
  });

  afterEach(() => {
    cleanupTestStore(testDir);
  });

  it('claude-code worker: produces claude -p "..." --allowedTools ...', () => {
    const brief = 'Do the task';
    const result = buildInvokeCommand('claude-code', brief, {
      cwd: testDir,
      mode: 'worker',
      shell: 'bash',
    });
    assert.ok(result.command.startsWith('claude'), 'command starts with claude');
    assert.ok(result.command.includes('-p'), 'uses -p flag');
    assert.ok(result.command.includes('--allowedTools'), 'includes --allowedTools');
    assert.ok(result.command.includes('Edit,Write,Bash,Read,Glob,Grep'), 'worker tools included');
    assert.ok(result.command.includes('Do the task'), 'brief is embedded in command');
    assert.equal(result.shell, 'bash');
  });

  it('claude-code reviewer: uses read-only tools', () => {
    const brief = 'Review this code';
    const result = buildInvokeCommand('claude-code', brief, {
      cwd: testDir,
      mode: 'reviewer',
      shell: 'bash',
    });
    assert.ok(result.command.includes('Read,Glob,Grep'), 'reviewer tools are read-only');
    assert.ok(!result.command.includes('Edit'), 'no Edit tool for reviewer');
    assert.ok(!result.command.includes('Write'), 'no Write tool for reviewer');
  });

  it('claude-code consult: uses read-only tools (same as reviewer)', () => {
    const brief = 'Advise on approach';
    const result = buildInvokeCommand('claude-code', brief, {
      cwd: testDir,
      mode: 'consult',
      shell: 'bash',
    });
    assert.ok(result.command.includes('Read,Glob,Grep'), 'consult tools are read-only');
  });

  it('codex worker: produces codex exec --full-auto "..."', () => {
    const brief = 'Implement the feature';
    const result = buildInvokeCommand('codex', brief, {
      cwd: testDir,
      mode: 'worker',
      shell: 'bash',
    });
    assert.ok(result.command.startsWith('codex'), 'command starts with codex');
    assert.ok(result.command.includes('exec'), 'uses exec subcommand');
    assert.ok(result.command.includes('--full-auto'), 'uses --full-auto flag');
    assert.ok(result.command.includes('Implement the feature'), 'brief embedded');
  });

  it('unknown agent throws an error', () => {
    assert.throws(
      () => buildInvokeCommand('unknown-agent-xyz', 'brief', {
        cwd: testDir,
        mode: 'worker',
        shell: 'bash',
      }),
      /No invoke template found for agent/,
      'should throw for unknown agent',
    );
  });

  it('ide-only agent (cursor) throws an error — no invoke template', () => {
    // cursor has no invoke_template — it is IDE-only
    assert.throws(
      () => buildInvokeCommand('cursor', 'brief', {
        cwd: testDir,
        mode: 'worker',
        shell: 'bash',
      }),
      /No invoke template found for agent/,
      'cursor (IDE-only) should throw',
    );
  });

  it('includes {cwd} substitution in command when template uses it', () => {
    // The cwd is substituted in place of {cwd} in the template if present.
    // Not all templates use {cwd}, but the function must not break when it is absent.
    const result = buildInvokeCommand('claude-code', 'Task', {
      cwd: testDir,
      mode: 'worker',
      shell: 'bash',
    });
    // cwd should not appear literally as {cwd} in the output
    assert.ok(!result.command.includes('{cwd}'), 'no unreplaced {cwd} placeholder');
  });

  it('long briefs cause command to reference a temp file path rather than inline content', () => {
    // Create a brief longer than MAX_INLINE_BRIEF_LENGTH (4000 chars)
    const longBrief = 'x'.repeat(4100);
    const result = buildInvokeCommand('claude-code', longBrief, {
      cwd: testDir,
      mode: 'worker',
      shell: 'bash',
    });
    // For bash, long briefs use $(cat '/path/to/brief') instead of inline content
    assert.ok(
      result.command.includes('$(cat ') || result.command.includes('(Get-Content'),
      'long brief uses file reference',
    );
    assert.ok(!result.command.includes('x'.repeat(100)), 'long brief is not inlined verbatim');
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
