/**
 * Tests for brief mode system: resolveBriefMode + generateBrief with briefMode param.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveBriefMode } from '../../src/core/agent-capability.js';
import { generateBrief } from '../../src/core/dispatcher.js';
import type { PlanItem } from '../../src/core/schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-brief-modes-'));
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
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_brief\n');
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

const SIMPLE_ITEM = {
  planId: 'pln_brief',
  rank: 1,
  hard_after: [] as string[],
  soft_after: [] as string[],
  lane: 'test-lane',
  scope_hint: 'src/core/',
  rationale: 'Testing brief mode',
};

// ── resolveBriefMode ──────────────────────────────────────────────────────

describe('brief-modes/resolveBriefMode', () => {
  it('claude-code → full', () => {
    assert.equal(resolveBriefMode('claude-code'), 'full');
  });

  it('codex → full (task-based but has MCP — pln#496 Phase 1.b)', () => {
    // Pre-pln#496: codex was forced to 'compact' because workflowModel ===
    // 'task-based'. That stripped the Protocol section, so codex briefs
    // never instructed the worker to call bclaw_assignment_update(status:
    // 'completed'). The new rule keeps 'compact' for task-based agents
    // WITHOUT MCP (nanoclaw / nemoclaw / zeroclaw); codex (task-based +
    // hasMcp:true) gets 'full'.
    assert.equal(resolveBriefMode('codex'), 'full');
  });

  it('mistral-vibe → full (task-based but has MCP — pln#496 Phase 1.b)', () => {
    assert.equal(resolveBriefMode('mistral-vibe'), 'full');
  });

  it('nanoclaw → compact (task-based AND no MCP)', () => {
    // Regression guard: agents that genuinely lack MCP must still get
    // 'compact' so they don't receive Protocol instructions they can't
    // execute.
    assert.equal(resolveBriefMode('nanoclaw'), 'compact');
  });

  it('cursor → task_card (IDE-only)', () => {
    assert.equal(resolveBriefMode('cursor'), 'task_card');
  });

  it('windsurf → task_card (IDE-only)', () => {
    assert.equal(resolveBriefMode('windsurf'), 'task_card');
  });

  it('cline → full (spawnable)', () => {
    assert.equal(resolveBriefMode('cline'), 'full');
  });

  it('opencode → full', () => {
    assert.equal(resolveBriefMode('opencode'), 'full');
  });

  it('roo → full (now spawnable via CLI)', () => {
    assert.equal(resolveBriefMode('roo'), 'full');
  });

  it('antigravity → full', () => {
    assert.equal(resolveBriefMode('antigravity'), 'full');
  });

  it('unknown agent → full (safe default)', () => {
    assert.equal(resolveBriefMode('unknown-xyz'), 'full');
  });
});

// ── generateBrief with briefMode ──────────────────────────────────────────

describe('brief-modes/generateBrief', () => {
  let testDir: string;
  const plan = makePlan({
    id: 'pln_brief',
    text: 'Implement feature X',
    tags: ['feature', 'dispatch'],
    steps: [
      { id: 'stp_1', text: 'Read the spec', status: 'done' as const, assignee: 'claude', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
      { id: 'stp_2', text: 'Write the code', status: 'todo' as const, created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z' },
    ],
  });

  beforeEach(() => {
    testDir = createTestStore();
    // Write plan file directly
    const planPath = path.join(testDir, '.brainclaw', 'coordination', 'plans', `${plan.id}.json`);
    fs.writeFileSync(planPath, JSON.stringify({ schema_version: 2, ...plan }), 'utf-8');
  });

  afterEach(() => {
    cleanupTestStore(testDir);
  });

  describe('full mode', () => {
    it('includes Protocol section', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'full');
      assert.ok(brief.includes('## Protocol'), 'should include Protocol');
    });

    it('includes Available tools section', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'full');
      assert.ok(brief.includes('## Available tools'), 'should include Available tools');
    });

    it('includes bclaw tool names', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'full');
      assert.ok(brief.includes('bclaw_session_start'), 'should mention bclaw_session_start');
      assert.ok(brief.includes('bclaw_claim'), 'should mention bclaw_claim');
    });

    it('includes plan metadata', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'full');
      assert.ok(brief.includes('Implement feature X'), 'should include plan text');
      assert.ok(brief.includes('pln_brief'), 'should include plan ID');
      assert.ok(brief.includes('Lane: test-lane'), 'should include lane');
    });
  });

  describe('compact mode', () => {
    it('does NOT include Protocol section', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'compact');
      assert.ok(!brief.includes('## Protocol'), 'should NOT include Protocol');
    });

    it('does NOT include Available tools section', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'compact');
      assert.ok(!brief.includes('## Available tools'), 'should NOT include Available tools');
    });

    it('does NOT mention MCP tools', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'compact');
      assert.ok(!brief.includes('bclaw_session_start'), 'should NOT mention bclaw_session_start');
    });

    it('still includes plan text and steps', () => {
      const brief = generateBrief(plan, SIMPLE_ITEM, testDir, 'compact');
      assert.ok(brief.includes('Implement feature X'), 'should include plan text');
      assert.ok(brief.includes('Write the code'), 'should include step text');
    });

    it('is shorter than full mode', () => {
      const full = generateBrief(plan, SIMPLE_ITEM, testDir, 'full');
      const compact = generateBrief(plan, SIMPLE_ITEM, testDir, 'compact');
      assert.ok(compact.length < full.length, `compact (${compact.length}) should be shorter than full (${full.length})`);
    });
  });

  describe('task_card mode', () => {
    it('is significantly shorter than full mode', () => {
      const full = generateBrief(plan, SIMPLE_ITEM, testDir, 'full');
      const card = generateBrief(plan, SIMPLE_ITEM, testDir, 'task_card');
      assert.ok(card.length < full.length * 0.6, `task_card (${card.length}) should be <60% of full (${full.length})`);
    });

    it('does NOT include Protocol or Available tools', () => {
      const card = generateBrief(plan, SIMPLE_ITEM, testDir, 'task_card');
      assert.ok(!card.includes('## Protocol'), 'no Protocol');
      assert.ok(!card.includes('## Available tools'), 'no Available tools');
    });

    it('includes plan text', () => {
      const card = generateBrief(plan, SIMPLE_ITEM, testDir, 'task_card');
      assert.ok(card.includes('Implement feature X'), 'should include plan text');
    });

    it('includes steps as checklist', () => {
      const card = generateBrief(plan, SIMPLE_ITEM, testDir, 'task_card');
      assert.ok(card.includes('[x] Read the spec'), 'should include done step');
      assert.ok(card.includes('[ ] Write the code'), 'should include todo step');
    });

    it('includes scope hint', () => {
      const card = generateBrief(plan, SIMPLE_ITEM, testDir, 'task_card');
      assert.ok(card.includes('src/core/'), 'should include scope hint');
    });
  });

  describe('default (no briefMode)', () => {
    it('behaves like full mode', () => {
      const defaultBrief = generateBrief(plan, SIMPLE_ITEM, testDir);
      const fullBrief = generateBrief(plan, SIMPLE_ITEM, testDir, 'full');
      assert.equal(defaultBrief, fullBrief, 'default should equal full');
    });
  });
});
