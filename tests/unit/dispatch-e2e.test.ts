/**
 * E2E dispatch tests per agent type.
 *
 * Validates the full dispatch cycle: dispatch → claim → inbox → brief → invoke command
 * for each supported agent type (Codex, Claude CLI, Copilot CLI).
 * Also covers: 4-factor scoring, check-before-spawn guard, generateDispatchBrief.
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
  generateDispatchBrief,
  buildProtocolSection,
  scoreAgents,
  checkActiveInstance,
} from '../../src/core/dispatcher.js';
import { buildInvokeCommand, resolveBriefMode } from '../../src/core/agent-capability.js';
import { canSpawnAgent } from '../../src/core/execution.js';
import { saveSequence } from '../../src/core/sequence.js';
import { listClaims, saveClaim, loadClaim, adoptClaimSession } from '../../src/core/claims.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
import { readInbox, sendMessage } from '../../src/core/messaging.js';
import { saveCurrentSession } from '../../src/core/identity.js';
import type { PlanItem, Sequence, Claim } from '../../src/core/schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-dispatch-e2e-'));
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
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_e2e\n');
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
    id: 'seq_e2e001',
    name: 'e2e-sequence',
    status: 'active',
    items,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    author: 'test',
    tags: [],
  };
}

function setupAllAgents(dir: string): void {
  for (const [name, id] of [
    ['claude-code', 'agt_claude'],
    ['codex', 'agt_codex'],
    ['github-copilot', 'agt_copilot'],
    ['cline', 'agt_cline'],
  ] as const) {
    saveAgentIdentity({
      version: 1,
      agent_id: id,
      agent_name: name,
      kind: 'agent',
      trust_level: 'trusted',
      capabilities: [],
      created_at: '2026-04-01T00:00:00Z',
    }, dir);
  }
}

// ── Per-Agent-Type Dispatch Cycle ─────────────────────────────────────────

describe('dispatch-e2e/per-agent-cycle', () => {
  let testDir: string;
  let previousNoSpawn: string | undefined;

  beforeEach(() => {
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1'; // Prevent actual spawning in tests
    testDir = createTestStore();
    setupAllAgents(testDir);
  });

  afterEach(() => {
    cleanupTestStore(testDir);
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('claude-code: full cycle — dispatch creates claim, sends inbox, generates temp_file invoke', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_claude', text: 'Implement auth module', assignee: 'claude-code' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_claude', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['claude-code'] }, testDir)!;
    assert.ok(result, 'dispatch returns result');
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'claude-code');
    assert.ok(result.result.messages_sent[0]!.claim_id, 'claim created');

    // Verify inbox message
    const inbox = readInbox({ agent: 'claude-code', markAsRead: false }, testDir);
    const assignMsg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(assignMsg, 'inbox has assign message');
    assert.ok(assignMsg!.text.includes('Implement auth module'), 'brief contains plan text');
    assert.ok(assignMsg!.text.includes('## Protocol'), 'brief has protocol section (full mode)');

    // Verify invoke command
    const invokeCmd = buildInvokeCommand('claude-code', 'test brief');
    assert.ok(invokeCmd, 'claude-code is invokable');
    assert.equal(invokeCmd.executable, 'claude');
    assert.equal(invokeCmd.promptDelivery, 'temp_file', 'claude-code uses temp_file delivery');

    // Verify brief mode
    assert.equal(resolveBriefMode('claude-code'), 'full');
  });

  it('codex: full cycle — dispatch creates claim, sends inbox, generates stdin_pipe invoke', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_codex', text: 'Write unit tests', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_codex', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'] }, testDir)!;
    assert.ok(result, 'dispatch returns result');
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'codex');

    // Verify inbox message is compact (no protocol section for Codex)
    const inbox = readInbox({ agent: 'codex', markAsRead: false }, testDir);
    const assignMsg = inbox.messages.find(m => m.type === 'assign');
    assert.ok(assignMsg, 'inbox has assign message');
    assert.ok(assignMsg!.text.includes('Write unit tests'), 'brief contains plan text');
    assert.ok(!assignMsg!.text.includes('## Protocol'), 'compact mode omits protocol section');

    // Verify invoke command
    const invokeCmd = buildInvokeCommand('codex', 'test brief');
    assert.ok(invokeCmd, 'codex is invokable');
    assert.equal(invokeCmd.executable, 'codex');
    assert.equal(invokeCmd.promptDelivery, 'stdin_pipe', 'codex uses stdin_pipe delivery');

    // Verify brief mode
    assert.equal(resolveBriefMode('codex'), 'compact');
  });

  it('github-copilot: inbox-only — dispatch creates claim and message but no spawn', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_copilot', text: 'Review PR changes', assignee: 'github-copilot' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_copilot', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['github-copilot'] }, testDir)!;
    assert.ok(result, 'dispatch returns result');
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'github-copilot');
    // Copilot is NOT spawnable — execution_status should be inbox_only
    assert.equal(result.result.messages_sent[0]!.execution_status, 'inbox_only');

    // Verify canSpawnAgent returns false for copilot
    const spawnCheck = canSpawnAgent('github-copilot');
    assert.equal(spawnCheck.canSpawn, false, 'copilot is not spawnable');

    // Verify buildInvokeCommand returns undefined (not spawnable_cli)
    const invokeCmd = buildInvokeCommand('github-copilot', 'test brief');
    assert.equal(invokeCmd, undefined, 'copilot has no invoke command (spawnable_cli=false)');
  });

  it('cline: full cycle — inline_arg delivery', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_cline', text: 'Fix styling issue', assignee: 'cline' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_cline', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['cline'] }, testDir)!;
    assert.ok(result, 'dispatch returns result');
    assert.equal(result.result.messages_sent.length, 1);
    assert.equal(result.result.messages_sent[0]!.agent, 'cline');

    // Verify invoke command
    const invokeCmd = buildInvokeCommand('cline', 'short brief');
    assert.ok(invokeCmd, 'cline is invokable');
    assert.equal(invokeCmd.executable, 'cline');
    assert.equal(invokeCmd.promptDelivery, 'inline_arg', 'cline uses inline_arg delivery');

    // Verify brief mode
    assert.equal(resolveBriefMode('cline'), 'full');
  });
});

// ── 4-Factor Scoring ──────────────────────────────────────────────────────

describe('dispatch-e2e/scoreAgents', () => {
  it('prefers plan assignee over other agents', () => {
    const plan = makePlan({ id: 'pln_score1', text: 'Test task', assignee: 'codex' });
    const scores = scoreAgents(['claude-code', 'codex', 'cline'], plan, []);

    assert.equal(scores[0]!.agent, 'codex', 'assignee should rank first');
    assert.ok(scores[0]!.factors.preference === 1.0, 'assignee gets preference=1.0');
    assert.ok(scores[1]!.factors.preference === 0.0, 'non-assignee gets preference=0.0');
  });

  it('ranks spawnable agents higher than non-spawnable', () => {
    const plan = makePlan({ id: 'pln_score2', text: 'Test task' });
    const scores = scoreAgents(['claude-code', 'github-copilot'], plan, []);

    // claude-code: spawnable_cli=true, execute capability → capability=1.0
    // github-copilot: spawnable_cli=false, no execute → capability=0.1
    const claudeScore = scores.find(s => s.agent === 'claude-code')!;
    const copilotScore = scores.find(s => s.agent === 'github-copilot')!;
    assert.ok(claudeScore.factors.capability > copilotScore.factors.capability,
      'spawnable agent has higher capability score');
  });

  it('load-balances: agents with fewer claims score higher', () => {
    const plan = makePlan({ id: 'pln_score3', text: 'Test task' });
    const claims: Claim[] = [
      { schema_version: 2, id: 'clm_1', agent: 'claude-code', scope: 'a', description: 'x', created_at: '2026-04-01T00:00:00Z', status: 'active' },
      { schema_version: 2, id: 'clm_2', agent: 'claude-code', scope: 'b', description: 'x', created_at: '2026-04-01T00:00:00Z', status: 'active' },
    ];
    const scores = scoreAgents(['claude-code', 'codex'], plan, claims);

    // codex has 0 claims, claude-code has 2
    const codexScore = scores.find(s => s.agent === 'codex')!;
    const claudeScore = scores.find(s => s.agent === 'claude-code')!;
    assert.ok(codexScore.factors.load_balance > claudeScore.factors.load_balance,
      'agent with fewer claims has higher load_balance');
    assert.ok(codexScore.factors.availability > claudeScore.factors.availability,
      'agent with no claims has higher availability');
  });

  it('returns empty array for empty pool', () => {
    const plan = makePlan({ id: 'pln_score4', text: 'Test' });
    const scores = scoreAgents([], plan, []);
    assert.equal(scores.length, 0);
  });

  it('scoring integrates with dispatch — best agent gets selected', () => {
    // Use a test store to verify that dispatch actually uses scoring
    const dir = createTestStore();
    try {
      const previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
      process.env.BRAINCLAW_NO_SPAWN = '1';

      // Register agents
      for (const [name, id] of [['claude-code', 'agt_c'], ['codex', 'agt_x']] as const) {
        saveAgentIdentity({ version: 1, agent_id: id, agent_name: name, kind: 'agent', trust_level: 'trusted', capabilities: [], created_at: '2026-04-01T00:00:00Z' }, dir);
      }

      // Plan with codex as assignee
      persistState({
        version: 1, write_version: 1,
        active_constraints: [], recent_decisions: [], known_traps: [],
        open_handoffs: [],
        plan_items: [makePlan({ id: 'pln_integ', text: 'Integration test', assignee: 'codex' })],
      }, dir);
      saveSequence(makeSequence([
        { planId: 'pln_integ', rank: 1, hard_after: [], soft_after: [] },
      ]), dir);

      const result = dispatch({ dispatcherAgent: 'coordinator' }, dir)!;
      assert.equal(result.result.messages_sent[0]!.agent, 'codex', 'scoring selects assignee');

      if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
      else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
    } finally {
      cleanupTestStore(dir);
    }
  });
});

// ── Check Before Spawn Guard ──────────────────────────────────────────────

describe('dispatch-e2e/checkActiveInstance', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestStore();
    setupAllAgents(testDir);
  });

  afterEach(() => {
    cleanupTestStore(testDir);
  });

  it('detects active session and reports capacity', () => {
    // Create a recent session for claude-code
    saveCurrentSession({
      host_id: 'test-host',
      session_id: 'ses_active',
      started_at: new Date().toISOString(),
      agent: 'claude-code',
      agent_id: 'agt_claude',
      last_seen_at: new Date().toISOString(), // just now
    }, testDir);

    const check = checkActiveInstance('claude-code', testDir);
    assert.equal(check.activeCount, 1, 'detects 1 active session');
    assert.ok(check.activeSessions.includes('ses_active'), 'reports session ID');
    assert.equal(check.maxAllowed, 3, 'claude-code max=3');
    assert.equal(check.canSpawnMore, true, '1/3 = still has capacity');
  });

  it('ignores stale sessions (older than config TTL, default 4h)', () => {
    const staleTime = new Date(Date.now() - 5 * 3_600_000).toISOString(); // 5 hours ago (> 4h TTL)
    saveCurrentSession({
      host_id: 'test-host',
      session_id: 'ses_stale',
      started_at: staleTime,
      agent: 'claude-code',
      agent_id: 'agt_claude',
      last_seen_at: staleTime,
    }, testDir);

    const check = checkActiveInstance('claude-code', testDir);
    assert.equal(check.active, false, 'session older than 4h TTL should not block');
  });

  it('returns inactive for agent with no sessions', () => {
    const check = checkActiveInstance('codex', testDir);
    assert.equal(check.active, false, 'no session = not active');
  });

  it('only checks sessions for the target agent, not others', () => {
    saveCurrentSession({
      host_id: 'test-host',
      session_id: 'ses_other',
      started_at: new Date().toISOString(),
      agent: 'codex',
      agent_id: 'agt_codex',
      last_seen_at: new Date().toISOString(),
    }, testDir);

    const check = checkActiveInstance('claude-code', testDir);
    assert.equal(check.active, false, 'should not detect codex session for claude-code');
  });
});

// ── generateDispatchBrief ─────────────────────────────────────────────────

describe('dispatch-e2e/generateDispatchBrief', () => {
  it('generates brief with task and protocol for MCP-capable agents', () => {
    const brief = generateDispatchBrief({
      task: 'Implement the login page',
      agent: 'claude-code',
      claimId: 'clm_test',
      scope: 'src/auth/',
      worktreePath: '/tmp/worktree-auth',
    });

    assert.ok(brief.includes('Implement the login page'), 'includes task');
    assert.ok(brief.includes('Scope: src/auth/'), 'includes scope');
    assert.ok(brief.includes('clm_test'), 'includes claim ID');
    assert.ok(brief.includes('/tmp/worktree-auth'), 'includes worktree path');
    assert.ok(brief.includes('## Protocol'), 'includes protocol section');
    assert.ok(brief.includes('bclaw_session_start'), 'includes session tools');
  });

  it('omits protocol section for compact-mode agents (codex)', () => {
    const brief = generateDispatchBrief({
      task: 'Write tests for auth module',
      agent: 'codex',
    });

    assert.ok(brief.includes('Write tests for auth module'), 'includes task');
    assert.ok(!brief.includes('## Protocol'), 'compact mode omits protocol');
    assert.ok(!brief.includes('bclaw_session_start'), 'compact mode omits tools');
  });

  it('includes claim instruction to self-claim when no pre-claim', () => {
    const brief = generateDispatchBrief({
      task: 'Fix the bug',
      agent: 'claude-code',
    });

    assert.ok(brief.includes('bclaw_claim'), 'includes claim instruction when no pre-claim');
  });

  it('omits claim instruction when pre-claimed', () => {
    const brief = generateDispatchBrief({
      task: 'Fix the bug',
      agent: 'claude-code',
      claimId: 'clm_pre',
    });

    assert.ok(!brief.includes('bclaw_claim, bclaw_release_claim'), 'no claim tools when pre-claimed');
  });
});

// ── buildProtocolSection ──────────────────────────────────────────────────

describe('dispatch-e2e/buildProtocolSection', () => {
  it('protocol with claim+worktree includes cd step', () => {
    const protocol = buildProtocolSection({ claimId: 'clm_1', worktreePath: '/wt/branch' });
    assert.ok(protocol.includes('cd into the worktree'), 'has cd step');
    assert.ok(protocol.includes('/wt/branch'), 'has worktree path');
    assert.ok(protocol.includes('pre-claimed'), 'mentions pre-claim');
  });

  it('protocol with claim only (no worktree) omits cd step', () => {
    const protocol = buildProtocolSection({ claimId: 'clm_2' });
    assert.ok(!protocol.includes('cd into the worktree'), 'no cd step without worktree');
    assert.ok(protocol.includes('pre-claimed'), 'mentions pre-claim');
  });

  it('protocol without claim includes bclaw_claim instruction', () => {
    const protocol = buildProtocolSection();
    assert.ok(protocol.includes('bclaw_claim'), 'includes claim instruction');
    assert.ok(!protocol.includes('pre-claimed'), 'no pre-claim mention');
  });
});

// ── Review Findings Coverage ──────────────────────────────────────────────

describe('dispatch-e2e/review-findings', () => {
  let testDir: string;
  let previousNoSpawn: string | undefined;

  beforeEach(() => {
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1';
    testDir = createTestStore();
    setupAllAgents(testDir);
  });

  afterEach(() => {
    cleanupTestStore(testDir);
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('finding-1 (haute): agent at capacity is skipped BEFORE claim/inbox creation', () => {
    // Saturate codex (max_concurrent_tasks=5) with 5 active claims
    for (let i = 1; i <= 5; i++) {
      saveClaim({
        schema_version: 2,
        id: `clm_sat_${i}`,
        agent: 'codex',
        scope: `src/sat${i}.ts`,
        description: `Saturating claim ${i}`,
        created_at: '2026-04-01T00:00:00Z',
        status: 'active',
      }, testDir);
    }

    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_busy', text: 'Task for busy agent', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_busy', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'] }, testDir)!;
    assert.ok(result, 'dispatch returns result');
    // Agent should be skipped — no claim, no inbox message created
    assert.equal(result.result.messages_sent.length, 0, 'no messages sent to busy agent');
    assert.equal(result.result.skipped.length, 1, 'agent skipped');
    assert.ok(result.result.skipped[0]!.reason.includes('rejected by guards') || result.result.skipped[0]!.reason.includes('No available agent'), 'reason mentions guard rejection or no available agent');

    // Verify no NEW claims were created (should still be exactly 5 from setup)
    const claims = listClaims(testDir).filter(c => c.status === 'active' && c.agent === 'codex');
    assert.equal(claims.length, 5, 'no new claim created — still at 5 from saturation');

    // Verify no inbox message was sent
    const inbox = readInbox({ agent: 'codex', markAsRead: false }, testDir);
    assert.equal(inbox.messages.length, 0, 'no inbox message for busy agent');
  });

  it('finding-1b (haute): dispatch falls back to 2nd best agent when 1st at capacity', () => {
    // Saturate codex (max_concurrent_tasks=5) with 5 active claims
    for (let i = 1; i <= 5; i++) {
      saveClaim({
        schema_version: 2,
        id: `clm_codex_sat${i}`,
        agent: 'codex',
        scope: `src/codex_sat${i}.ts`,
        description: `Saturating claim ${i}`,
        created_at: '2026-04-01T00:00:00Z',
        status: 'active',
      }, testDir);
    }

    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_fallback', text: 'Task needing fallback', assignee: 'codex' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_fallback', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    // Provide both codex and cline in the pool — codex is preferred (assignee) but active
    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['codex', 'cline'] }, testDir)!;
    assert.ok(result, 'dispatch returns result');
    assert.equal(result.result.messages_sent.length, 1, 'one message sent');
    assert.equal(result.result.messages_sent[0]!.agent, 'cline', 'fell back to cline');
    assert.equal(result.result.skipped.length, 0, 'plan was not skipped');
    assert.ok(result.result.warnings.some(w => w.includes('codex') && w.includes('capacity')), 'warning about codex at capacity');
  });

  it('finding-2 (moyenne): checkActiveInstance uses config TTL, not hardcoded 5min', () => {
    // Create a session that's 10 minutes old — would be "stale" with 5min hardcode
    // but still counted as active with default 4h TTL
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    saveCurrentSession({
      host_id: 'test-host',
      session_id: 'ses_10min',
      started_at: tenMinAgo,
      agent: 'claude-code',
      agent_id: 'agt_claude',
      last_seen_at: tenMinAgo,
    }, testDir);

    // With the config-based TTL (default 4h), 10 min old is still counted in activeCount
    const check = checkActiveInstance('claude-code', testDir);
    assert.equal(check.activeCount, 1, '10-min-old session is counted as active with 4h TTL');
    assert.ok(check.activeSessions.includes('ses_10min'), 'session ID is in activeSessions');
    // claude-code has max_concurrent_tasks=3, so 1 session still has capacity
    assert.equal(check.canSpawnMore, true, 'still has capacity (1/3)');
  });

  it('finding-3 (moyenne): task_card brief includes claim_id and worktree_path', () => {
    const plan = makePlan({ id: 'pln_tc', text: 'Review PR changes' });
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [], plan_items: [plan],
    }, testDir);

    const item = { planId: 'pln_tc', rank: 1, hard_after: [], soft_after: [] };
    const brief = generateBrief(plan, item, testDir, 'task_card', {
      claimId: 'clm_copilot_pre',
      worktreePath: '/tmp/wt-copilot',
    });

    assert.ok(brief.includes('clm_copilot_pre'), 'task_card includes claim ID');
    assert.ok(brief.includes('/tmp/wt-copilot'), 'task_card includes worktree path');
    assert.ok(brief.includes('pre-claimed'), 'task_card mentions pre-claim');
  });
});

// ── P4.2 Multi-Instance E2E Tests ─────────────────────────────────────────

describe('dispatch-e2e/multi-instance', () => {
  let testDir: string;
  let previousNoSpawn: string | undefined;

  beforeEach(() => {
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1';
    testDir = createTestStore();
    setupAllAgents(testDir);
  });

  afterEach(() => {
    cleanupTestStore(testDir);
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('dispatches 2 plans to same agent type with distinct claims', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [
        makePlan({ id: 'pln_m1', text: 'Multi-instance task 1', assignee: 'codex' }),
        makePlan({ id: 'pln_m2', text: 'Multi-instance task 2', assignee: 'codex' }),
      ],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_m1', rank: 1, hard_after: [], soft_after: [], scope_hint: 'src/a/' },
      { planId: 'pln_m2', rank: 2, hard_after: [], soft_after: [], scope_hint: 'src/b/' },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['codex'], maxAssignments: 2 }, testDir)!;
    assert.ok(result, 'dispatch returns result');
    assert.equal(result.result.messages_sent.length, 2, 'both plans dispatched to codex');
    assert.equal(result.result.messages_sent[0]!.agent, 'codex');
    assert.equal(result.result.messages_sent[1]!.agent, 'codex');
    // Each should have a distinct claim_id
    const claimIds = result.result.messages_sent.map(m => m.claim_id);
    assert.notEqual(claimIds[0], claimIds[1], 'distinct claim IDs');
  });

  it('readInbox with claimId filters to only matching messages', () => {
    // Send two messages to codex with different claim_ids
    sendMessage({
      from: 'coordinator', to: 'codex', type: 'assign', text: 'Task A',
      ref: 'pln_a', claim_id: 'clm_aaa', tags: [],
    }, testDir);
    sendMessage({
      from: 'coordinator', to: 'codex', type: 'assign', text: 'Task B',
      ref: 'pln_b', claim_id: 'clm_bbb', tags: [],
    }, testDir);

    // Without claimId filter: sees both
    const all = readInbox({ agent: 'codex', markAsRead: false }, testDir);
    assert.equal(all.messages.length, 2, 'all messages visible without filter');

    // With claimId filter: sees only matching
    const filtered = readInbox({ agent: 'codex', claimId: 'clm_aaa', markAsRead: false }, testDir);
    assert.equal(filtered.messages.length, 1, 'only clm_aaa message visible');
    assert.equal(filtered.messages[0]!.claim_id, 'clm_aaa');
  });

  it('scope lock is global — blocks any agent, not just same agent', () => {
    // Create a claim for codex on src/shared.ts
    saveClaim({
      schema_version: 2, id: 'clm_scope_lock', agent: 'codex',
      scope: 'src/shared.ts', description: 'Working', created_at: '2026-04-01T00:00:00Z', status: 'active',
    }, testDir);

    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_scope', text: 'Work on shared.ts', assignee: 'claude-code' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_scope', rank: 1, hard_after: [], soft_after: [], scope_hint: 'src/shared.ts' },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator', agents: ['claude-code'] }, testDir)!;
    // The claim should be reused (scope is already locked by codex)
    assert.equal(result.result.messages_sent[0]!.claim_id, 'clm_scope_lock', 'reuses existing scope claim');
  });

  it('adoptClaimSession links session to claim', () => {
    saveClaim({
      schema_version: 2, id: 'clm_adopt', agent: 'codex',
      scope: 'src/adopt.ts', description: 'For adoption', created_at: '2026-04-01T00:00:00Z', status: 'active',
    }, testDir);

    const result = adoptClaimSession('clm_adopt', 'ses_worker_1', testDir);
    assert.equal(result.adopted, true, 'adoption succeeds');

    // Verify claim now has session_id
    const claim = loadClaim('clm_adopt', testDir);
    assert.equal(claim.session_id, 'ses_worker_1');
    assert.ok(claim.adopted_at, 'adopted_at is set');
  });

  it('adoptClaimSession refuses if already adopted by different session', () => {
    saveClaim({
      schema_version: 2, id: 'clm_taken', agent: 'codex',
      scope: 'src/taken.ts', description: 'Already adopted', created_at: '2026-04-01T00:00:00Z',
      status: 'active', session_id: 'ses_first',
    }, testDir);

    const result = adoptClaimSession('clm_taken', 'ses_second', testDir);
    assert.equal(result.adopted, false, 'second adoption refused');
    assert.ok(result.reason.includes('already adopted'), 'reason explains why');
  });

  it('backward compat: dispatch without multi-instance still works', () => {
    persistState({
      version: 1, write_version: 1,
      active_constraints: [], recent_decisions: [], known_traps: [],
      open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_compat', text: 'Simple task' })],
    }, testDir);
    saveSequence(makeSequence([
      { planId: 'pln_compat', rank: 1, hard_after: [], soft_after: [] },
    ]), testDir);

    const result = dispatch({ dispatcherAgent: 'coordinator' }, testDir)!;
    assert.ok(result, 'dispatch works');
    assert.equal(result.result.messages_sent.length, 1, 'one message sent');
    assert.ok(result.result.messages_sent[0]!.claim_id, 'has claim_id');
  });
});
