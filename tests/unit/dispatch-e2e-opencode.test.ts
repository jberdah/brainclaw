/**
 * E2E dispatch tests — OpenCode agent.
 *
 * Validates: inline_arg delivery, permission maps, MCP write-path,
 * full brief mode, temp_file fallback for long prompts.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-e2e-opencode-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/plans', 'coordination/sequences', 'coordination/claims',
    'coordination/handoffs', 'coordination/inbox', 'coordination/sessions',
    'coordination/runtime/ack',
    'memory/constraints', 'memory/decisions', 'memory/traps', 'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_e2e_opencode\n');
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
    schema_version: 2, id: 'seq_opencode_e2e', name: 'opencode-e2e',
    status: 'active', items,
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    author: 'test', tags: [],
  };
}

function setupAgent(dir: string): void {
  saveAgentIdentity({
    version: 1, agent_id: 'agt_opencode', agent_name: 'opencode',
    kind: 'agent', trust_level: 'trusted', capabilities: [],
    created_at: '2026-04-01T00:00:00Z',
  }, dir);
}

// ── buildInvokeCommand — OpenCode specifics ───────────────────────────────

describe('dispatch-e2e-opencode/buildInvokeCommand', () => {
  it('uses inline_arg delivery', () => {
    const cmd = buildInvokeCommand('opencode', 'implement feature');
    assert.ok(cmd, 'opencode is invokable');
    assert.equal(cmd.executable, 'opencode');
    assert.equal(cmd.promptDelivery, 'inline_arg');
  });

  it('prompt is embedded inline in double quotes', () => {
    const cmd = buildInvokeCommand('opencode', 'fix the bug');
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('fix the bug'), 'prompt in bashCommand');
  });

  it('review mode uses same template structure', () => {
    const cmd = buildInvokeCommand('opencode', 'review code', { mode: 'reviewer' });
    assert.ok(cmd);
    assert.equal(cmd.executable, 'opencode');
    assert.equal(cmd.promptDelivery, 'inline_arg');
  });

  it('long prompt exceeding max_inline_length falls back to temp_file', () => {
    const longPrompt = 'x'.repeat(9000); // max_inline_length=8000
    const cmd = buildInvokeCommand('opencode', longPrompt);
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'temp_file',
      'prompt exceeding 8000 chars falls back to temp_file');
    assert.ok(cmd.tempFilePath);
  });

  it('temp_file uses short hash in filename (ENAMETOOLONG mitigation)', () => {
    const longPrompt = 'a'.repeat(9000);
    const cmd = buildInvokeCommand('opencode', longPrompt);
    assert.ok(cmd);
    assert.ok(cmd.tempFilePath);
    // Path should use bclaw_prompt_{hash}.md, not the full prompt
    assert.ok(cmd.tempFilePath.includes('bclaw_prompt_'), 'temp file uses hash prefix');
    assert.ok(cmd.tempFilePath.length < 300, 'temp file path is reasonable length');
  });

  it('POSIX temp_file bashCommand includes printf write step', () => {
    const longPrompt = 'x'.repeat(9000);
    const cmd = buildInvokeCommand('opencode', longPrompt, { platform: 'linux' });
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'temp_file');
    assert.ok(cmd.bashCommand.includes('printf'), 'POSIX writes prompt via printf');
    assert.ok(cmd.bashCommand.includes('&&'), 'chained with && for write-then-execute');
  });

  it('Windows temp_file bashCommand omits write step (caller writes file)', () => {
    const longPrompt = 'x'.repeat(9000);
    const cmd = buildInvokeCommand('opencode', longPrompt, { platform: 'win32' });
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'temp_file');
    assert.ok(!cmd.bashCommand.includes('printf'), 'Windows omits printf');
  });

  it('shell is always false', () => {
    const cmd = buildInvokeCommand('opencode', 'test');
    assert.ok(cmd);
    assert.equal(cmd.shell, false);
  });
});

// ── Profile validation ────────────────────────────────────────────────────

describe('dispatch-e2e-opencode/profile', () => {
  it('profile has expected capabilities', () => {
    const profile = getCapabilityProfile('opencode');
    assert.ok(profile);
    assert.equal(profile.workflowModel, 'interactive');
    assert.equal(profile.max_concurrent_tasks, 2);
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.hasAutoApprove, false);
    assert.deepEqual(profile.role_capabilities, ['execute', 'review']);
  });

  it('brief mode is full', () => {
    assert.equal(resolveBriefMode('opencode'), 'full');
  });

  it('invoke_binary is opencode', () => {
    const profile = getCapabilityProfile('opencode');
    assert.equal(profile!.invoke_binary, 'opencode');
  });

  it('instructionFile is AGENTS.md (shared)', () => {
    const profile = getCapabilityProfile('opencode');
    assert.equal(profile!.instructionFile, 'AGENTS.md');
    assert.equal(profile!.sharedInstructionFile, true);
  });

  it('prompt_delivery supports inline_arg and temp_file', () => {
    const profile = getCapabilityProfile('opencode');
    assert.deepEqual(profile!.prompt_delivery.methods, ['inline_arg', 'temp_file']);
    assert.equal(profile!.prompt_delivery.preferred, 'inline_arg');
    assert.equal(profile!.prompt_delivery.max_inline_length, 8000);
  });
});

// ── Dispatch cycle ────────────────────────────────────────────────────────

describe('dispatch-e2e-opencode/dispatch-cycle', () => {
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
      plan_items: [makePlan({ id: 'pln_oc1', text: 'Implement feature', assignee: 'opencode' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_oc1', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['opencode'] }, testDir))!;
    assert.ok(result);
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'opencode');
    assert.ok(result.result.messages_sent[0]!.claim_id);
    assert.ok(result.result.messages_sent[0]!.assignment_id);

    const inbox = readInbox({ agent: 'opencode', markAsRead: false }, testDir);
    const assignMsg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(assignMsg);
    assert.ok(assignMsg!.text.includes('Implement feature'));
    assert.ok(assignMsg!.text.includes('## Protocol'), 'full mode includes protocol');
  });

  it('lifecycle: offered → accepted → started → completed', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_oclife', text: 'OpenCode lifecycle', assignee: 'opencode' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_oclife', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['opencode'] }, testDir))!;
    const aId = result.result.messages_sent[0]!.assignment_id!;

    transitionAssignment(aId, 'accepted', { actor: 'opencode', session_id: 'ses_oc' }, testDir);
    transitionAssignment(aId, 'started', { actor: 'opencode', session_id: 'ses_oc' }, testDir);
    const terminal = transitionAssignment(aId, 'completed', { actor: 'opencode', session_id: 'ses_oc' }, testDir);

    assert.equal(terminal.assignment.status, 'completed');
    assert.ok(loadAssignment(aId, testDir)!.completed_at);
  });
});

// ── MCP write-path ────────────────────────────────────────────────────────

describe('dispatch-e2e-opencode/mcp-write-path', () => {
  it('opencode profile has MCP + runtime.mcp_direct', () => {
    const profile = getCapabilityProfile('opencode');
    assert.ok(profile);
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.runtime.mcp_direct, true);
  });

  it('generateDispatchBrief includes protocol with MCP tools', () => {
    const brief = generateDispatchBrief({
      task: 'Implement feature',
      agent: 'opencode',
      claimId: 'clm_oc',
      scope: 'src/feature/',
    });
    assert.ok(brief.includes('## Protocol'));
    assert.ok(brief.includes('bclaw_session_start') || brief.includes('bclaw_assignment_update'));
    assert.ok(brief.includes('clm_oc'));
  });
});
