/**
 * E2E dispatch tests — Codex agent.
 *
 * Validates: buildInvokeCommand, smoke spawn mock, MCP write-path,
 * sandbox workspace-write traps (trp_1ca61b5d), Windows quoting.
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
  checkActiveInstance,
} from '../../src/core/dispatcher.js';
import {
  buildInvokeCommand,
  resolveBriefMode,
  getCapabilityProfile,
} from '../../src/core/agent-capability.js';
import { loadAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { saveSequence } from '../../src/core/sequence.js';
import { saveClaim, listClaims } from '../../src/core/claims.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
import { readInbox } from '../../src/core/messaging.js';
import { saveCurrentSession } from '../../src/core/identity.js';
import type { PlanItem, Sequence } from '../../src/core/schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-e2e-codex-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/plans', 'coordination/sequences', 'coordination/claims',
    'coordination/handoffs', 'coordination/inbox', 'coordination/sessions',
    'coordination/runtime/ack',
    'memory/constraints', 'memory/decisions', 'memory/traps', 'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_e2e_codex\n');
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
    schema_version: 2, id: 'seq_codex_e2e', name: 'codex-e2e',
    status: 'active', items,
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    author: 'test', tags: [],
  };
}

function setupAgent(dir: string): void {
  saveAgentIdentity({
    version: 1, agent_id: 'agt_codex', agent_name: 'codex',
    kind: 'agent', trust_level: 'trusted', capabilities: [],
    created_at: '2026-04-01T00:00:00Z',
  }, dir);
}

// ── buildInvokeCommand — Codex specifics ──────────────────────────────────

describe('dispatch-e2e-codex/buildInvokeCommand', () => {
  it('uses stdin_pipe delivery (pln#475 — avoids Windows cmd arg-parsing)', () => {
    const cmd = buildInvokeCommand('codex', 'implement feature X');
    assert.ok(cmd, 'codex is invokable');
    assert.equal(cmd.executable, 'codex');
    assert.equal(cmd.promptDelivery, 'stdin_pipe');
    assert.equal(cmd.promptText, 'implement feature X');
    assert.ok(!cmd.args.includes('implement feature X'), 'prompt not in args for stdin_pipe');
  });

  it('includes sandbox workspace-write flag', () => {
    const cmd = buildInvokeCommand('codex', 'test prompt');
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('--sandbox'), 'sandbox flag present');
    assert.ok(cmd.bashCommand.includes('workspace-write'), 'workspace-write mode');
  });

  it('includes approval_policy=never flag (auto-approve for non-interactive)', () => {
    const cmd = buildInvokeCommand('codex', 'test');
    assert.ok(cmd);
    assert.ok(cmd.bashCommand.includes('approval_policy'), 'approval_policy flag');
    assert.ok(cmd.bashCommand.includes('never'), 'set to never');
  });

  it('review mode also uses workspace-write (not read-only — trp_1ca61b5d)', () => {
    const cmd = buildInvokeCommand('codex', 'review this code', { mode: 'reviewer' });
    assert.ok(cmd, 'codex reviewer is invokable');
    assert.ok(cmd.bashCommand.includes('workspace-write'),
      'review template uses workspace-write, not read-only (trp_1ca61b5d)');
    assert.ok(!cmd.bashCommand.includes('read-only'),
      'read-only sandbox would block pwsh exec on Windows');
  });

  it('POSIX bashCommand uses printf pipe for stdin_pipe delivery', () => {
    const cmd = buildInvokeCommand('codex', 'hello world', { platform: 'linux' });
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'stdin_pipe');
    assert.ok(cmd.bashCommand.includes('printf'), 'POSIX uses printf pipe');
    assert.ok(cmd.bashCommand.includes('|'), 'pipe operator present');
  });

  it('Windows bashCommand omits stdin piping', () => {
    const cmd = buildInvokeCommand('codex', 'hello world', { platform: 'win32' });
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'stdin_pipe');
    assert.ok(!cmd.bashCommand.includes('printf'), 'Windows omits printf pipe');
    assert.ok(!cmd.bashCommand.includes('|'), 'no pipe operator on Windows');
  });

  it('long prompt still uses stdin_pipe (not temp_file fallback)', () => {
    const longPrompt = 'x'.repeat(10000);
    const cmd = buildInvokeCommand('codex', longPrompt);
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'stdin_pipe',
      'codex prefers stdin_pipe regardless of prompt length');
  });

  it('shell is always false (direct exec, no shell wrapper)', () => {
    const cmd = buildInvokeCommand('codex', 'test');
    assert.ok(cmd);
    assert.equal(cmd.shell, false);
  });
});

// ── Profile validation ────────────────────────────────────────────────────

describe('dispatch-e2e-codex/profile', () => {
  it('profile has expected capabilities', () => {
    const profile = getCapabilityProfile('codex');
    assert.ok(profile, 'codex profile exists');
    assert.equal(profile.workflowModel, 'task-based');
    assert.equal(profile.max_concurrent_tasks, 5);
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.hasMcp, true);
    assert.equal(profile.hasAutoApprove, false);
    assert.deepEqual(profile.role_capabilities, ['execute', 'review']);
  });

  it('brief mode is compact (omits protocol section)', () => {
    assert.equal(resolveBriefMode('codex'), 'compact');
  });

  it('invoke_binary is codex', () => {
    const profile = getCapabilityProfile('codex');
    assert.equal(profile!.invoke_binary, 'codex');
  });
});

// ── Dispatch + spawn mock ─────────────────────────────────────────────────

describe('dispatch-e2e-codex/dispatch-cycle', () => {
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

  it('dispatch creates claim + assignment + compact inbox brief', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_codex_1', text: 'Write unit tests for auth', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_codex_1', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'] }, testDir))!;
    assert.ok(result);
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'codex');
    assert.ok(result.result.messages_sent[0]!.claim_id);
    assert.ok(result.result.messages_sent[0]!.assignment_id);

    // Compact brief: no protocol section
    const inbox = readInbox({ agent: 'codex', markAsRead: false }, testDir);
    const assignMsg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(assignMsg);
    assert.ok(assignMsg!.text.includes('Write unit tests for auth'));
    assert.ok(!assignMsg!.text.includes('## Protocol'), 'compact mode omits protocol');
  });

  // NOTE: spawn handshake tests live in dispatch-e2e.test.ts (the original
  // suite). They require real binary resolution which is environment-specific.

  it('capacity guard: 5 active claims → skip without creating new claim or inbox', async () => {
    for (let i = 1; i <= 5; i++) {
      saveClaim({
        schema_version: 2, id: `clm_sat_${i}`, agent: 'codex',
        scope: `src/sat${i}.ts`, description: `Saturating claim ${i}`,
        created_at: '2026-04-01T00:00:00Z', status: 'active',
      }, testDir);
    }

    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_busy', text: 'Task for busy codex', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_busy', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'] }, testDir))!;
    assert.equal(result.result.messages_sent.length, 0);
    assert.equal(result.result.skipped.length, 1);

    const claims = listClaims(testDir).filter(c => c.status === 'active' && c.agent === 'codex');
    assert.equal(claims.length, 5, 'no new claim created');

    const inbox = readInbox({ agent: 'codex', markAsRead: false }, testDir);
    assert.equal(inbox.messages.length, 0);
  });

  it('multi-instance: dispatches 2 plans to codex with distinct claims', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_m1', text: 'Multi-task 1', assignee: 'codex' }),
        makePlan({ id: 'pln_m2', text: 'Multi-task 2', assignee: 'codex' }),
      ],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_m1', rank: 1, hard_after: [], soft_after: [], scope_hint: 'src/a/' },
      { planId: 'pln_m2', rank: 2, hard_after: [], soft_after: [], scope_hint: 'src/b/' },
    ]), testDir);

    const result = (await dispatch({
      dispatcherAgent: 'coordinator', agents: ['codex'], maxAssignments: 2,
    }, testDir))!;
    assert.equal(result.result.messages_sent.length, 2);
    const claimIds = result.result.messages_sent.map(m => m.claim_id);
    assert.notEqual(claimIds[0], claimIds[1], 'distinct claim IDs');
  });

  it('commands[] includes BRAINCLAW_CLAIM_ID env var prefix', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_env', text: 'Env test', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_env', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'] }, testDir))!;
    assert.ok(result.result.commands.length > 0);
    const cmd = result.result.commands[0]!.command;
    assert.ok(cmd.includes('BRAINCLAW_CLAIM_ID='));
    const claimId = result.result.messages_sent[0]!.claim_id;
    assert.ok(cmd.includes(claimId!));
  });

  it('assignment lifecycle: offered → accepted → started → completed', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_life', text: 'Lifecycle task', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_life', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'] }, testDir))!;
    const assignmentId = result.result.messages_sent[0]!.assignment_id!;

    transitionAssignment(assignmentId, 'accepted', { actor: 'codex', session_id: 'ses_codex' }, testDir);
    transitionAssignment(assignmentId, 'started', { actor: 'codex', session_id: 'ses_codex' }, testDir);
    const terminal = transitionAssignment(assignmentId, 'completed', { actor: 'codex', session_id: 'ses_codex' }, testDir);

    assert.equal(terminal.assignment.status, 'completed');
    const reloaded = loadAssignment(assignmentId, testDir);
    assert.ok(reloaded!.completed_at);
  });
});

// ── Windows traps ─────────────────────────────────────────────────────────

describe('dispatch-e2e-codex/windows-traps', () => {
  it('trp#59: prompt with backticks does not appear in inline args (stdin_pipe protects)', () => {
    const trickyPrompt = 'run `npm test` and check #results';
    const cmd = buildInvokeCommand('codex', trickyPrompt);
    assert.ok(cmd);
    assert.equal(cmd.promptDelivery, 'stdin_pipe');
    // The prompt must NOT appear as a positional arg — backticks and # break cmd.exe
    assert.ok(!cmd.args.some(a => a.includes('`')), 'no backticks in args');
    assert.ok(!cmd.args.some(a => a.includes('#')), 'no # in args');
    assert.equal(cmd.promptText, trickyPrompt, 'full prompt available via promptText for piping');
  });

  it('Windows bashCommand is clean (no heredoc, no pipe)', () => {
    const cmd = buildInvokeCommand('codex', 'test prompt', { platform: 'win32' });
    assert.ok(cmd);
    assert.ok(!cmd.bashCommand.includes('<<'), 'no heredoc on Windows');
    assert.ok(!cmd.bashCommand.includes('printf'), 'no printf on Windows');
  });

  it('ENAMETOOLONG mitigation: temp_file path uses short hash, not full prompt', () => {
    const longPrompt = 'a'.repeat(30000);
    const cmd = buildInvokeCommand('codex', longPrompt);
    assert.ok(cmd);
    // stdin_pipe means no tempFilePath for codex, but verify promptText is set
    assert.equal(cmd.promptDelivery, 'stdin_pipe');
    assert.equal(cmd.promptText, longPrompt);
    assert.equal(cmd.tempFilePath, undefined, 'stdin_pipe does not create temp file');
  });
});

// ── MCP write-path ────────────────────────────────────────────────────────

describe('dispatch-e2e-codex/mcp-write-path', () => {
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

  it('codex profile has MCP enabled (bclaw_create write path)', () => {
    const profile = getCapabilityProfile('codex');
    assert.ok(profile);
    assert.equal(profile.hasMcp, true, 'codex has MCP — spawned agent can call bclaw_create');
    assert.equal(profile.runtime.mcp_direct, true, 'MCP direct connection available');
  });

  it('dispatch brief for codex is compact but still contains assignment_id for MCP routing', async () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_mcp', text: 'MCP write test', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_mcp', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = (await dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'] }, testDir))!;
    const inbox = readInbox({ agent: 'codex', markAsRead: false }, testDir);
    const msg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(msg);
    assert.ok(msg!.assignment_id, 'message carries assignment_id for MCP routing');
    assert.equal(msg!.payload?.assignment_id, msg!.assignment_id);
  });

  it('sandbox workspace-write does NOT block MCP calls from spawned codex', () => {
    // The profile uses workspace-write (not read-only) specifically so that
    // the spawned codex can write to .brainclaw/ paths via MCP.
    const profile = getCapabilityProfile('codex');
    assert.ok(profile!.invoke_template.includes('workspace-write'));
    assert.ok(!profile!.invoke_template.includes('read-only'),
      'read-only sandbox blocks MCP filesystem writes — workspace-write is required');
    // Review template must also use workspace-write
    assert.ok(profile!.invoke_review_template!.includes('workspace-write'));
  });
});
