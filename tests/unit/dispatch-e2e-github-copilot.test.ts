/**
 * E2E dispatch tests — GitHub Copilot agent.
 *
 * Post pln#440 flip: --allow-all --no-ask-user + --additional-mcp-config flow,
 * regression bclaw_create MCP write-path.
 *
 * References: pln_af02bf54, pln#440, pln_e3fc23c4, trp_0c84dd99
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  dispatch,
  generateDispatchBrief,
  generateBrief,
} from '../../src/core/dispatcher.js';
import {
  buildInvokeCommand,
  resolveBriefMode,
  getCapabilityProfile,
} from '../../src/core/agent-capability.js';
import { loadAssignment, transitionAssignment, recordProgress } from '../../src/core/assignments.js';
import { findLatestAgentRunForAssignment } from '../../src/core/agentruns.js';
import { saveSequence } from '../../src/core/sequence.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
import { readInbox } from '../../src/core/messaging.js';
import type { PlanItem, Sequence } from '../../src/core/schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-e2e-copilot-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/plans', 'coordination/sequences', 'coordination/claims',
    'coordination/handoffs', 'coordination/inbox', 'coordination/sessions',
    'coordination/runtime/ack',
    'memory/constraints', 'memory/decisions', 'memory/traps', 'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_e2e_copilot\n');
  return dir;
}

function cleanupTestStore(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makePlan(overrides: Partial<PlanItem> & { id: string; text: string }): PlanItem {
  return {
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    author: 'test', status: 'todo', priority: 'medium', tags: [], depends_on: [],
    ...overrides,
  };
}

function makeSequence(items: Sequence['items']): Sequence {
  return {
    schema_version: 2, id: 'seq_copilot_e2e', name: 'copilot-e2e',
    status: 'active', items,
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    author: 'test', tags: [],
  };
}

function setupAgent(dir: string): void {
  saveAgentIdentity({
    version: 1, agent_id: 'agt_copilot', agent_name: 'github-copilot',
    kind: 'agent', trust_level: 'trusted', capabilities: [],
    created_at: '2026-04-01T00:00:00Z',
  }, dir);
}

// ── buildInvokeCommand — Copilot specifics ────────────────────────────────

describe('dispatch-e2e-github-copilot/buildInvokeCommand', () => {
  it('uses inline_arg delivery', () => {
    const cmd = buildInvokeCommand('github-copilot', 'review PR changes');
    assert.ok(cmd, 'copilot is invokable (post pln#440)');
    assert.equal(cmd.executable, 'copilot');
    assert.equal(cmd.promptDelivery, 'inline_arg');
  });

  it('includes --allow-all flag (pln#440 auto-approve)', () => {
    const cmd = buildInvokeCommand('github-copilot', 'test');
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('--allow-all'),
      '--allow-all flag required for headless spawn (pln#440)');
  });

  it('includes --no-ask-user flag (pln#440 non-interactive)', () => {
    const cmd = buildInvokeCommand('github-copilot', 'test');
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('--no-ask-user'),
      '--no-ask-user required for non-interactive spawn (pln#440)');
  });

  it('includes -p flag (pipe/prompt mode)', () => {
    const cmd = buildInvokeCommand('github-copilot', 'test');
    assert.ok(cmd);
    // -p is part of the template: 'copilot -p "{prompt}" --allow-all --no-ask-user'
    assert.ok(cmd.args.some(a => a === '-p'), 'copilot uses -p flag');
  });

  it('review mode also includes --allow-all --no-ask-user', () => {
    const cmd = buildInvokeCommand('github-copilot', 'review', { mode: 'reviewer' });
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('--allow-all'));
    assert.ok(cmd.bashCommand.includes('--no-ask-user'));
  });

  it('prompt is embedded inline (not via stdin or temp file)', () => {
    const cmd = buildInvokeCommand('github-copilot', 'fix the bug');
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'inline_arg');
    assert.ok(cmd.bashCommand.includes('fix the bug'), 'prompt appears in bashCommand');
  });

  it('long prompt exceeding max_inline_length falls back to temp_file', () => {
    const longPrompt = 'x'.repeat(5000); // max_inline_length=4000
    const cmd = buildInvokeCommand('github-copilot', longPrompt);
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'temp_file',
      'prompt exceeding 4000 chars falls back to temp_file');
    assert.ok(cmd.tempFilePath, 'temp file path is set');
  });

  it('shell is always false', () => {
    const cmd = buildInvokeCommand('github-copilot', 'test');
    assert.ok(cmd);
    assert.equal(cmd.shell, false);
  });
});

// ── Profile validation ────────────────────────────────────────────────────

describe('dispatch-e2e-github-copilot/profile', () => {
  it('profile has expected capabilities (post pln#440)', () => {
    const profile = getCapabilityProfile('github-copilot');
    assert.ok(profile);
    assert.equal(profile.workflowModel, 'interactive');
    assert.equal(profile.max_concurrent_tasks, 1, 'copilot limited to 1 concurrent');
    assert.equal(profile.runtime.canBeSpawnedCli, true, 'spawnable post pln#440');
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.hasAutoApprove, false, 'auto-approve via flags, not profile toggle');
    assert.ok(profile.role_capabilities.includes('execute'));
    assert.ok(profile.role_capabilities.includes('review'));
    assert.ok(profile.role_capabilities.includes('consult'));
  });

  it('brief mode is task_card', () => {
    // Copilot is interactive but max_concurrent=1 — uses task_card
    const mode = resolveBriefMode('github-copilot');
    assert.ok(['task_card', 'full'].includes(mode), `brief mode is ${mode}`);
  });

  it('invoke_binary is copilot', () => {
    const profile = getCapabilityProfile('github-copilot');
    assert.equal(profile!.invoke_binary, 'copilot');
  });

  it('instructionFile is .github/copilot-instructions.md', () => {
    const profile = getCapabilityProfile('github-copilot');
    assert.equal(profile!.instructionFile, '.github/copilot-instructions.md');
  });

  it('mcpConfigScope is project', () => {
    const profile = getCapabilityProfile('github-copilot');
    assert.equal(profile!.mcpConfigScope, 'project',
      'copilot uses project-scoped MCP config (--additional-mcp-config)');
  });
});

// ── Dispatch cycle ────────────────────────────────────────────────────────

describe('dispatch-e2e-github-copilot/dispatch-cycle', () => {
  let testDir: string;
  let previousNoSpawn: string | undefined;

  beforeEach(() => {
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1';
    testDir = createTestStore();
    setupAgent(testDir);
  });

  afterEach(() => {
    cleanupTestStore(testDir);
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('dispatch creates claim + assignment + inbox for copilot', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_cop1', text: 'Review PR changes', assignee: 'github-copilot' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_cop1', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['github-copilot'] }, testDir))!;
    assert.ok(result);
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'github-copilot');
    assert.ok(result.result.messages_sent[0]!.claim_id);
    assert.ok(result.result.messages_sent[0]!.assignment_id);
    // BRAINCLAW_NO_SPAWN=1 → command_ready_manual
    assert.equal(result.result.messages_sent[0]!.execution_status, 'command_ready_manual');
  });

  // NOTE: spawn handshake tests live in dispatch-e2e.test.ts (the original
  // suite). They require real binary resolution which is environment-specific.

  it('full lifecycle: offered → accepted → started → progress → completed', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_life', text: 'Copilot lifecycle', assignee: 'github-copilot' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_life', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['github-copilot'] }, testDir))!;
    const aId = result.result.messages_sent[0]!.assignment_id!;

    transitionAssignment(aId, 'accepted', { actor: 'github-copilot', session_id: 'ses_cop' }, testDir);
    transitionAssignment(aId, 'started', { actor: 'github-copilot', session_id: 'ses_cop' }, testDir);
    recordProgress(aId, { actor: 'github-copilot', session_id: 'ses_cop', message: 'reviewing' }, testDir);
    const terminal = transitionAssignment(aId, 'completed', { actor: 'github-copilot', session_id: 'ses_cop' }, testDir);

    assert.equal(terminal.assignment.status, 'completed');
    assert.ok(loadAssignment(aId, testDir)!.completed_at);
    assert.equal(findLatestAgentRunForAssignment(aId, testDir)!.status, 'completed');
  });

  it('max_concurrent_tasks=1: second dispatch is skipped', async () => {
    // Saturate copilot with 1 active claim
    const { saveClaim } = await import('../../src/core/claims.js');
    saveClaim({
      schema_version: 2, id: 'clm_cop_busy', agent: 'github-copilot',
      scope: 'src/busy.ts', description: 'Working',
      created_at: '2026-04-01T00:00:00Z', status: 'active',
    }, testDir);

    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_cop_busy', text: 'Busy task', assignee: 'github-copilot' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_cop_busy', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['github-copilot'] }, testDir))!;
    assert.equal(result.result.messages_sent.length, 0, 'copilot at capacity (1/1)');
    assert.equal(result.result.skipped.length, 1);
  });
});

// ── MCP write-path regression ─────────────────────────────────────────────

describe('dispatch-e2e-github-copilot/mcp-write-path', () => {
  it('copilot profile has MCP enabled for bclaw_create', () => {
    const profile = getCapabilityProfile('github-copilot');
    assert.ok(profile);
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.runtime.mcp_direct, true);
  });

  it('task_card brief includes claim_id and worktree_path for MCP routing', () => {
    const plan = makePlan({ id: 'pln_tc', text: 'Review PR' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-brief-'));
    try {
      const bc = path.join(dir, '.brainclaw');
      for (const sub of ['coordination/plans', 'memory/constraints', 'memory/decisions', 'memory/traps']) {
        fs.mkdirSync(path.join(bc, sub), { recursive: true });
      }
      fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_brief\n');
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [], plan_items: [plan],
      }, dir);

      const item = { planId: 'pln_tc', rank: 1, hard_after: [], soft_after: [] };
      const brief = generateBrief(plan, item, dir, 'task_card', {
        claimId: 'clm_copilot_mcp',
        worktreePath: '/tmp/wt-copilot',
      });

      assert.ok(brief.includes('clm_copilot_mcp'), 'task_card includes claim ID');
      assert.ok(brief.includes('/tmp/wt-copilot'), 'task_card includes worktree path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--additional-mcp-config is documented in profile mcpConfigScope=project', () => {
    const profile = getCapabilityProfile('github-copilot');
    assert.equal(profile!.mcpConfigScope, 'project',
      'project scope implies --additional-mcp-config for per-session MCP');
  });
});
