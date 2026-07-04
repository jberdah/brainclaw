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
    __resetConnectionPrincipalForTests();
  });

  afterEach(() => {
    __resetConnectionPrincipalForTests();
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
  });

  it('bclaw_update fall-through announces auto-repair and does not fail', async () => {
    process.env.BRAINCLAW_AGENT_NAME = 'my-worker-agent';

    const created = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'to be updated' } },
      cwd: workspace.dir,
    });
    assert.equal(created.response.isError, false);
    const decisionId = (created.response.structuredContent as { id?: string } | undefined)?.id;
    assert.ok(decisionId, 'create returned an id');

    // Clear sessions to simulate a fresh call with only agent identity (no session).
    const dir = workspace.dir;
    // Force a fresh call by resetting the principal cache so the update recomputes.
    __resetConnectionPrincipalForTests();

    const outcome = await executeMcpToolCall({
      name: 'bclaw_update',
      args: { entity: 'decision', id: decisionId, patch: { text: 'updated text' } },
      cwd: dir,
    });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    // Agent already registered by first call, session persisted → no auto_repair needed on the second call.
    const structured = outcome.response.structuredContent as Record<string, unknown> | undefined;
    assert.equal(structured?.auto_repair, undefined, 'no re-announce once agent+session exist');
  });

  it('bclaw_transition on plan without session auto-repairs and announces', async () => {
    process.env.BRAINCLAW_AGENT_NAME = 'my-worker-agent';

    // Create a plan first (via same fall-through path).
    const created = await executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'plan', data: { text: 'plan to transition' } },
      cwd: workspace.dir,
    });
    assert.equal(created.response.isError, false, JSON.stringify(created.response));
    const planId = (created.response.structuredContent as { id?: string } | undefined)?.id;
    assert.ok(planId, 'create returned a plan id');

    const outcome = await executeMcpToolCall({
      name: 'bclaw_transition',
      args: { entity: 'plan', id: planId, to: 'in_progress' },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    // Transition succeeds without a "Start a session first" error.
    const combinedText = (outcome.response.content ?? []).map((c) => c.text).join('\n');
    assert.match(combinedText, /in_progress/);
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
});
