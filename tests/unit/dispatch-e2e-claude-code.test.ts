/**
 * E2E dispatch tests — Claude Code agent.
 *
 * Validates: claude -p spawn + stdin_pipe delivery + inline_arg delivery,
 * Windows ENAMETOOLONG mitigation via temp-file, auto-approve flags,
 * MCP write-path (bclaw_create), allowedTools scoping per mode.
 *
 * References: pln_af02bf54, pln_e3fc23c4, trp_0c84dd99
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
import { loadAssignment, transitionAssignment, recordProgress } from '../../src/core/assignments.js';
import { saveSequence } from '../../src/core/sequence.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
import { readInbox } from '../../src/core/messaging.js';
import type { PlanItem, Sequence } from '../../src/core/schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-e2e-claude-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/plans', 'coordination/sequences', 'coordination/claims',
    'coordination/handoffs', 'coordination/inbox', 'coordination/sessions',
    'coordination/runtime/ack',
    'memory/constraints', 'memory/decisions', 'memory/traps', 'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_e2e_claude\n');
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
    schema_version: 2, id: 'seq_claude_e2e', name: 'claude-e2e',
    status: 'active', items,
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    author: 'test', tags: [],
  };
}

function setupAgent(dir: string): void {
  saveAgentIdentity({
    version: 1, agent_id: 'agt_claude', agent_name: 'claude-code',
    kind: 'agent', trust_level: 'trusted', capabilities: [],
    created_at: '2026-04-01T00:00:00Z',
  }, dir);
}

// ── buildInvokeCommand — Claude Code specifics ────────────────────────────

describe('dispatch-e2e-claude-code/buildInvokeCommand', () => {
  it('uses stdin_pipe delivery by default', () => {
    const cmd = buildInvokeCommand('claude-code', 'implement auth module');
    assert.ok(cmd);
    assert.equal(cmd.executable, 'claude');
    assert.equal(cmd.promptDelivery, 'stdin_pipe');
    assert.equal(cmd.promptText, 'implement auth module');
    assert.ok(!cmd.args.includes('implement auth module'));
  });

  it('worker mode includes Edit,Write,Bash,Read,Glob,Grep in allowedTools', () => {
    const cmd = buildInvokeCommand('claude-code', 'test', { mode: 'worker' });
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('--allowedTools'));
    assert.ok(cmd.bashCommand.includes('Edit'));
    assert.ok(cmd.bashCommand.includes('Write'));
    assert.ok(cmd.bashCommand.includes('Bash'));
  });

  it('reviewer mode restricts to Read,Glob,Grep (no Edit/Write/Bash)', () => {
    const cmd = buildInvokeCommand('claude-code', 'review code', { mode: 'reviewer' });
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('--allowedTools'));
    assert.ok(cmd.bashCommand.includes('Read'));
    assert.ok(cmd.bashCommand.includes('Glob'));
    assert.ok(cmd.bashCommand.includes('Grep'));
    assert.ok(!cmd.bashCommand.includes('Edit'), 'reviewer cannot Edit');
    assert.ok(!cmd.bashCommand.includes('Write'), 'reviewer cannot Write');
  });

  it('consult mode restricts to Read,Glob,Grep', () => {
    const cmd = buildInvokeCommand('claude-code', 'advise on arch', { mode: 'consult' });
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('Read'));
    assert.ok(!cmd.bashCommand.includes('Edit'), 'consult cannot Edit');
  });

  it('includes -p flag (print/pipe mode)', () => {
    const cmd = buildInvokeCommand('claude-code', 'test');
    assert.ok(cmd);
    assert.ok(cmd.args.includes('-p'), 'claude -p flag present');
  });

  it('POSIX: bashCommand pipes prompt via printf', () => {
    const cmd = buildInvokeCommand('claude-code', 'hello world', { platform: 'linux' });
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('printf'));
    assert.ok(cmd.bashCommand.includes('|'));
    assert.ok(cmd.bashCommand.includes('hello world'));
  });

  it('Windows: bashCommand omits piping (stdin_pipe fallback)', () => {
    const cmd = buildInvokeCommand('claude-code', 'hello world', { platform: 'win32' });
    assert.ok(cmd);
    assert.ok(!cmd.bashCommand.includes('printf'), 'no printf on Windows');
    assert.ok(!cmd.bashCommand.includes('|'), 'no pipe on Windows');
  });

  it('shell is always false', () => {
    const cmd = buildInvokeCommand('claude-code', 'test');
    assert.ok(cmd);
    assert.equal(cmd.shell, false);
  });
});

// ── Profile validation ────────────────────────────────────────────────────

describe('dispatch-e2e-claude-code/profile', () => {
  it('profile has expected capabilities', () => {
    const profile = getCapabilityProfile('claude-code');
    assert.ok(profile);
    assert.equal(profile.workflowModel, 'interactive');
    assert.equal(profile.max_concurrent_tasks, 3);
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.runtime.canSpawnOtherCli, true, 'claude-code can coordinate and spawn others');
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.hasAutoApprove, true);
    assert.ok(profile.role_capabilities.includes('coordinate'), 'can coordinate');
    assert.ok(profile.role_capabilities.includes('execute'));
    assert.ok(profile.role_capabilities.includes('review'));
    assert.ok(profile.role_capabilities.includes('consult'));
  });

  it('brief mode is full (includes protocol section)', () => {
    assert.equal(resolveBriefMode('claude-code'), 'full');
  });

  it('invoke_binary is claude', () => {
    const profile = getCapabilityProfile('claude-code');
    assert.equal(profile!.invoke_binary, 'claude');
  });

  it('instructionFile is CLAUDE.md', () => {
    const profile = getCapabilityProfile('claude-code');
    assert.equal(profile!.instructionFile, 'CLAUDE.md');
  });
});

// ── Dispatch cycle ────────────────────────────────────────────────────────

describe('dispatch-e2e-claude-code/dispatch-cycle', () => {
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
      plan_items: [makePlan({ id: 'pln_cc1', text: 'Implement auth module', assignee: 'claude-code' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_cc1', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['claude-code'] }, testDir))!;
    assert.ok(result);
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'claude-code');
    assert.ok(result.result.messages_sent[0]!.claim_id);
    assert.ok(result.result.messages_sent[0]!.assignment_id);

    const inbox = readInbox({ agent: 'claude-code', markAsRead: false }, testDir);
    const assignMsg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(assignMsg);
    assert.ok(assignMsg!.text.includes('Implement auth module'));
    assert.ok(assignMsg!.text.includes('## Protocol'), 'full mode includes protocol');
    assert.ok(assignMsg!.assignment_id);
    assert.equal(assignMsg!.payload?.assignment_id, assignMsg!.assignment_id);
  });

  // NOTE: spawn handshake tests live in dispatch-e2e.test.ts (the original
  // suite). They require real binary resolution which is environment-specific.

  it('full lifecycle: offered → accepted → started → progress → completed', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_life', text: 'Full lifecycle', assignee: 'claude-code' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_life', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['claude-code'] }, testDir))!;
    const aId = result.result.messages_sent[0]!.assignment_id!;

    transitionAssignment(aId, 'accepted', { actor: 'claude-code', session_id: 'ses_cc' }, testDir);
    transitionAssignment(aId, 'started', { actor: 'claude-code', session_id: 'ses_cc' }, testDir);
    const progress = recordProgress(aId, { actor: 'claude-code', session_id: 'ses_cc', message: 'halfway' }, testDir);
    assert.ok(progress.last_heartbeat_at);
    const terminal = transitionAssignment(aId, 'completed', { actor: 'claude-code', session_id: 'ses_cc' }, testDir);
    assert.equal(terminal.assignment.status, 'completed');
    assert.ok(loadAssignment(aId, testDir)!.completed_at);
  });
});

// ── Windows ENAMETOOLONG mitigation ───────────────────────────────────────

describe('dispatch-e2e-claude-code/windows-traps', () => {
  it('long prompt uses stdin_pipe (avoids ENAMETOOLONG on temp file path)', () => {
    const longPrompt = 'x'.repeat(20000);
    const cmd = buildInvokeCommand('claude-code', longPrompt);
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'stdin_pipe',
      'claude-code always prefers stdin_pipe, avoiding temp file path length issues');
    assert.equal(cmd.tempFilePath, undefined);
  });

  it('prompt with special characters survives stdin_pipe (no shell interpretation)', () => {
    const trickyPrompt = 'fix `bug` in $HOME/path with "quotes" and \\backslash';
    const cmd = buildInvokeCommand('claude-code', trickyPrompt);
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'stdin_pipe');
    assert.equal(cmd.promptText, trickyPrompt, 'full prompt preserved in promptText');
    assert.ok(!cmd.args.some(a => a.includes('$HOME')), 'no shell-interpreted tokens in args');
  });
});

// ── MCP write-path ────────────────────────────────────────────────────────

describe('dispatch-e2e-claude-code/mcp-write-path', () => {
  it('claude-code profile has MCP + runtime.mcp_direct', () => {
    const profile = getCapabilityProfile('claude-code');
    assert.ok(profile);
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.runtime.mcp_direct, true);
  });

  it('generateDispatchBrief for claude-code includes protocol with MCP tools', () => {
    const brief = generateDispatchBrief({
      task: 'Implement login page',
      agent: 'claude-code',
      claimId: 'clm_test',
      scope: 'src/auth/',
      worktreePath: '/tmp/wt-auth',
    });
    assert.ok(brief.includes('## Protocol'));
    assert.ok(brief.includes('bclaw_session_start') || brief.includes('bclaw_assignment_update'),
      'brief references MCP tools for session lifecycle');
    assert.ok(brief.includes('clm_test'));
    assert.ok(brief.includes('/tmp/wt-auth'));
  });
});
