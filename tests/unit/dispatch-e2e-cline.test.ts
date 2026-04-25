/**
 * E2E dispatch tests — Cline agent.
 *
 * Validates: -y flag (auto-approve), inline_arg delivery, permission maps,
 * MCP write-path, full brief mode with protocol section.
 *
 * References: pln_af02bf54, pln_e3fc23c4
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  dispatch,
  generateDispatchBrief,
} from '../../src/core/dispatcher.js';
import {
  buildInvokeCommand,
  resolveBriefMode,
  getCapabilityProfile,
} from '../../src/core/agent-capability.js';
import { loadAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { saveSequence } from '../../src/core/sequence.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
import { readInbox } from '../../src/core/messaging.js';
import type { PlanItem, Sequence } from '../../src/core/schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-e2e-cline-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/plans', 'coordination/sequences', 'coordination/claims',
    'coordination/handoffs', 'coordination/inbox', 'coordination/sessions',
    'coordination/runtime/ack',
    'memory/constraints', 'memory/decisions', 'memory/traps', 'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_e2e_cline\n');
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
    schema_version: 2, id: 'seq_cline_e2e', name: 'cline-e2e',
    status: 'active', items,
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    author: 'test', tags: [],
  };
}

function setupAgent(dir: string): void {
  saveAgentIdentity({
    version: 1, agent_id: 'agt_cline', agent_name: 'cline',
    kind: 'agent', trust_level: 'trusted', capabilities: [],
    created_at: '2026-04-01T00:00:00Z',
  }, dir);
}

// ── buildInvokeCommand — Cline specifics ──────────────────────────────────

describe('dispatch-e2e-cline/buildInvokeCommand', () => {
  it('uses inline_arg delivery', () => {
    const cmd = buildInvokeCommand('cline', 'fix styling issue');
    assert.ok(cmd, 'cline is invokable');
    assert.equal(cmd.executable, 'cline');
    assert.equal(cmd.promptDelivery, 'inline_arg');
  });

  it('includes -y flag (auto-approve)', () => {
    const cmd = buildInvokeCommand('cline', 'test');
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('-y'), '-y flag for auto-approve');
  });

  it('prompt is embedded inline in double quotes', () => {
    const cmd = buildInvokeCommand('cline', 'fix the bug');
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('fix the bug'), 'prompt in bashCommand');
  });

  it('review mode also uses -y flag', () => {
    const cmd = buildInvokeCommand('cline', 'review code', { mode: 'reviewer' });
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('-y'));
  });

  it('long prompt exceeding max_inline_length falls back to temp_file', () => {
    const longPrompt = 'x'.repeat(9000); // max_inline_length=8000
    const cmd = buildInvokeCommand('cline', longPrompt);
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'temp_file',
      'prompt exceeding 8000 chars falls back to temp_file');
    assert.ok(cmd.tempFilePath);
  });

  it('shell is always false', () => {
    const cmd = buildInvokeCommand('cline', 'test');
    assert.ok(cmd);
    assert.equal(cmd.shell, false);
  });
});

// ── Profile validation ────────────────────────────────────────────────────

describe('dispatch-e2e-cline/profile', () => {
  it('profile has expected capabilities', () => {
    const profile = getCapabilityProfile('cline');
    assert.ok(profile);
    assert.equal(profile.workflowModel, 'interactive');
    assert.equal(profile.max_concurrent_tasks, 3);
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.hasAutoApprove, true, 'cline supports auto-approve');
    assert.deepEqual(profile.role_capabilities, ['execute', 'review']);
  });

  it('brief mode is full (includes protocol section)', () => {
    assert.equal(resolveBriefMode('cline'), 'full');
  });

  it('invoke_binary is cline', () => {
    const profile = getCapabilityProfile('cline');
    assert.equal(profile!.invoke_binary, 'cline');
  });

  it('instructionFile is .clinerules/brainclaw.md', () => {
    const profile = getCapabilityProfile('cline');
    assert.equal(profile!.instructionFile, '.clinerules/brainclaw.md');
  });

  it('mcpConfigScope is project', () => {
    const profile = getCapabilityProfile('cline');
    assert.equal(profile!.mcpConfigScope, 'project');
  });

  it('prompt_delivery max_inline_length is 8000', () => {
    const profile = getCapabilityProfile('cline');
    assert.equal(profile!.prompt_delivery.max_inline_length, 8000);
  });
});

// ── Dispatch cycle ────────────────────────────────────────────────────────

describe('dispatch-e2e-cline/dispatch-cycle', () => {
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

  it('dispatch creates claim + assignment + full brief with protocol', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_cline1', text: 'Fix styling issue', assignee: 'cline' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_cline1', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['cline'] }, testDir))!;
    assert.ok(result);
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'cline');
    assert.ok(result.result.messages_sent[0]!.claim_id);
    assert.ok(result.result.messages_sent[0]!.assignment_id);

    const inbox = readInbox({ agent: 'cline', markAsRead: false }, testDir);
    const assignMsg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(assignMsg);
    assert.ok(assignMsg!.text.includes('Fix styling issue'));
    assert.ok(assignMsg!.text.includes('## Protocol'), 'full mode includes protocol');
  });

  it('lifecycle: offered → accepted → started → completed', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_clife', text: 'Cline lifecycle', assignee: 'cline' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_clife', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['cline'] }, testDir))!;
    const aId = result.result.messages_sent[0]!.assignment_id!;

    transitionAssignment(aId, 'accepted', { actor: 'cline', session_id: 'ses_cline' }, testDir);
    transitionAssignment(aId, 'started', { actor: 'cline', session_id: 'ses_cline' }, testDir);
    const terminal = transitionAssignment(aId, 'completed', { actor: 'cline', session_id: 'ses_cline' }, testDir);

    assert.equal(terminal.assignment.status, 'completed');
    assert.ok(loadAssignment(aId, testDir)!.completed_at);
  });
});

// ── MCP write-path ────────────────────────────────────────────────────────

describe('dispatch-e2e-cline/mcp-write-path', () => {
  it('cline profile has MCP + runtime.mcp_direct', () => {
    const profile = getCapabilityProfile('cline');
    assert.ok(profile);
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.runtime.mcp_direct, true);
  });

  it('generateDispatchBrief includes protocol with MCP tools', () => {
    const brief = generateDispatchBrief({
      task: 'Fix styling',
      agent: 'cline',
      claimId: 'clm_cline',
      scope: 'src/styles/',
    });
    assert.ok(brief.includes('## Protocol'));
    assert.ok(brief.includes('bclaw_session_start') || brief.includes('bclaw_assignment_update'));
    assert.ok(brief.includes('clm_cline'));
  });
});
