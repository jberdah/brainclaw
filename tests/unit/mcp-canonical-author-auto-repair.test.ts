import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { executeMcpToolCall, __resetConnectionPrincipalForTests } from '../../src/commands/mcp.js';
import { findAgentIdentityByName } from '../../src/core/agent-registry.js';
import { loadAllSessions } from '../../src/core/identity.js';
import { loadState } from '../../src/core/state.js';

// pln#608 — doctrine: mechanical + non-ambiguous + cheap + scoped precondition
// → the engine satisfies it AND announces it — never silence. The canonical
// mutation verbs (bclaw_create/update/remove/transition) previously threw
// "Start a session first" when the caller had a derivable identity but no
// session; now they fall through to auto-register + auto-session and surface
// an ⚠️ auto-repair warning.
describe('bclaw canonical mutation — auto-repair fall-through (pln#608)', () => {
  let workspace: TestWorkspace;
  let restoreCwd: () => void;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-auto-repair-' });
    restoreCwd = workspace.useCwd();
    // Tests here control identity explicitly.
    delete process.env.BRAINCLAW_AGENT;
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    delete process.env.BRAINCLAW_OBSERVER;
    __resetConnectionPrincipalForTests();
  });

  afterEach(() => {
    __resetConnectionPrincipalForTests();
    delete process.env.BRAINCLAW_OBSERVER;
    restoreCwd();
    workspace.cleanup();
  });

  it('bclaw_create with env-declared agent + no session auto-registers agent AND auto-creates session', async () => {
    process.env.BRAINCLAW_AGENT_NAME = 'my-worker-agent';

    // Precondition: agent is not yet registered, no session exists.
    assert.equal(findAgentIdentityByName('my-worker-agent', workspace.dir), undefined);
    assert.equal(loadAllSessions(workspace.dir).length, 0);

    const outcome = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'first write auto-repair' } },
      cwd: workspace.dir,
    });

    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));

    // Auto-repair announced in structuredContent
    const structured = outcome.response.structuredContent as Record<string, unknown> | undefined;
    const autoRepair = structured?.auto_repair as { agent_auto_registered?: boolean; session_auto_created?: string } | undefined;
    assert.ok(autoRepair, 'auto_repair should be present in structuredContent');
    assert.equal(autoRepair.agent_auto_registered, true, 'agent was auto-registered');
    assert.match(autoRepair.session_auto_created ?? '', /^sess_/, 'a session was auto-created');

    // Announced in response text (never silent — doctrine).
    const combinedText = (outcome.response.content ?? []).map((c) => c.text).join('\n');
    assert.match(combinedText, /auto-repair/i);
    assert.match(combinedText, /my-worker-agent/);

    // Side effects: agent is now registered, session exists on disk, and it is tagged auto_created.
    const registered = findAgentIdentityByName('my-worker-agent', workspace.dir);
    assert.ok(registered, 'agent registered');
    const sessions = loadAllSessions(workspace.dir);
    assert.equal(sessions.length, 1, 'one session persisted');
    assert.equal(sessions[0]!.auto_created, true, 'session tagged auto_created for aggressive harvest (pln#602)');

    // Decision was attributed to the resolved agent (not lost / not 'unknown').
    const decisions = loadState(workspace.dir).recent_decisions;
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.author, 'my-worker-agent');

    const second = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'second write reuses session' } },
      cwd: workspace.dir,
    });
    assert.equal(second.response.isError, false, JSON.stringify(second.response));
    assert.equal(loadAllSessions(workspace.dir).length, 1, 'second write reuses the auto-created session');
    const secondStructured = second.response.structuredContent as Record<string, unknown> | undefined;
    assert.equal(secondStructured?.auto_repair, undefined, 'no duplicate auto-repair announcement once session exists');
  });

  it('bclaw_update fall-through announces auto-repair and does not fail', async () => {
    const created = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'to be updated', author: 'setup' } },
      cwd: workspace.dir,
    });
    assert.equal(created.response.isError, false);
    const decisionId = (created.response.structuredContent as { id?: string } | undefined)?.id;
    assert.ok(decisionId, 'create returned an id');
    assert.equal(loadAllSessions(workspace.dir).length, 0, 'setup write did not create a session');

    process.env.BRAINCLAW_AGENT_NAME = 'my-worker-agent';
    __resetConnectionPrincipalForTests();

    const outcome = await executeMcpToolCall({
      name: 'bclaw_update',
      args: { entity: 'decision', id: decisionId, patch: { text: 'updated text' } },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    const structured = outcome.response.structuredContent as Record<string, unknown> | undefined;
    const autoRepair = structured?.auto_repair as { agent_auto_registered?: boolean; session_auto_created?: string } | undefined;
    assert.ok(autoRepair, 'update announced auto-repair');
    assert.match(autoRepair.session_auto_created ?? '', /^sess_/);
    const combinedText = (outcome.response.content ?? []).map((c) => c.text).join('\n');
    assert.match(combinedText, /auto-repair/i);
  });

  it('bclaw_transition on plan without session auto-repairs and announces', async () => {
    const created = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'plan', data: { text: 'plan to transition', author: 'setup' } },
      cwd: workspace.dir,
    });
    assert.equal(created.response.isError, false, JSON.stringify(created.response));
    const planId = (created.response.structuredContent as { id?: string } | undefined)?.id;
    assert.ok(planId, 'create returned a plan id');
    assert.equal(loadAllSessions(workspace.dir).length, 0, 'setup write did not create a session');

    process.env.BRAINCLAW_AGENT_NAME = 'my-worker-agent';
    const outcome = await executeMcpToolCall({
      name: 'bclaw_transition',
      args: { entity: 'plan', id: planId, to: 'in_progress' },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    // Transition succeeds without a "Start a session first" error.
    const combinedText = (outcome.response.content ?? []).map((c) => c.text).join('\n');
    assert.match(combinedText, /in_progress/);
    assert.match(combinedText, /auto-repair/i);
    const structured = outcome.response.structuredContent as Record<string, unknown> | undefined;
    assert.ok(structured?.auto_repair, 'transition announced auto-repair in structuredContent');
  });

  it('bclaw_remove without session auto-repairs and announces', async () => {
    const created = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'to be removed', author: 'setup' } },
      cwd: workspace.dir,
    });
    assert.equal(created.response.isError, false, JSON.stringify(created.response));
    const decisionId = (created.response.structuredContent as { id?: string } | undefined)?.id;
    assert.ok(decisionId, 'create returned a decision id');
    assert.equal(loadAllSessions(workspace.dir).length, 0, 'setup write did not create a session');

    process.env.BRAINCLAW_AGENT_NAME = 'remove-worker-agent';
    const outcome = await executeMcpToolCall({
      name: 'bclaw_remove',
      args: { entity: 'decision', id: decisionId },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    const combinedText = (outcome.response.content ?? []).map((c) => c.text).join('\n');
    assert.match(combinedText, /auto-repair/i);
    const structured = outcome.response.structuredContent as Record<string, unknown> | undefined;
    assert.ok(structured?.auto_repair, 'remove announced auto-repair in structuredContent');
  });

  it('KEEP: fully ambiguous identity (no signal, ≥2 registered agents) stays a hard refusal', async () => {
    // Two extra registered agents so the single-agent fallback does not fire.
    workspace.registerAgent('claude-code');
    workspace.registerAgent('codex');
    // No env signal, no explicit args.
    delete process.env.BRAINCLAW_AGENT;
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;

    const outcome = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'should refuse' } },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, true, JSON.stringify(outcome.response));
    const text = outcome.response.content?.[0]?.text ?? '';
    assert.match(text, /cannot resolve mutation author/);
    // No record leaked.
    assert.equal(loadState(workspace.dir).recent_decisions.length, 0);
  });

  it('KEEP: unknown explicit agent id stays a hard refusal', async () => {
    const outcome = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', agentId: 'agt_missing', data: { text: 'should refuse' } },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, true, JSON.stringify(outcome.response));
    const text = outcome.response.content?.[0]?.text ?? '';
    assert.match(text, /cannot resolve mutation author/);
    assert.match(text, /agt_missing/);
    assert.equal(loadState(workspace.dir).recent_decisions.length, 0);
    assert.equal(loadAllSessions(workspace.dir).length, 0);
  });

  it('observer mode refuses canonical auto-repair and creates no identity or session side effects', async () => {
    process.env.BRAINCLAW_OBSERVER = '1';
    process.env.BRAINCLAW_AGENT_NAME = 'observer-leaked-agent';

    const outcome = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'observer must not mutate' } },
      cwd: workspace.dir,
    });

    assert.equal(outcome.response.isError, true, JSON.stringify(outcome.response));
    const text = outcome.response.content?.[0]?.text ?? '';
    assert.match(text, /cannot resolve mutation author/);
    assert.equal(findAgentIdentityByName('observer-leaked-agent', workspace.dir), undefined);
    assert.equal(loadAllSessions(workspace.dir).length, 0);
    assert.equal(loadState(workspace.dir).recent_decisions.length, 0);
  });
});
