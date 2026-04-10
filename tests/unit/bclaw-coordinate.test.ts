import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateRequestSchema } from '../../src/core/facade-schema.js';
import { getSpawnableAgents } from '../../src/core/agent-capability.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { listClaims } from '../../src/core/claims.js';
import { readInbox } from '../../src/core/messaging.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('bclaw_coordinate — schema', () => {
  it('parses valid assign params', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'Implement feature X',
      scope: 'src/feature-x',
      targetAgents: ['claude-code', 'codex'],
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'assign');
    assert.deepEqual(result.data.targetAgents, ['claude-code', 'codex']);
  });

  it('parses valid consult params without targetAgents', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'consult',
      task: 'What is the best approach for auth?',
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'consult');
    assert.equal(result.data.targetAgents, undefined);
  });

  it('parses valid review params with scope', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'review',
      task: 'Review PR #42',
      scope: 'src/auth',
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'review');
    assert.equal(result.data.scope, 'src/auth');
  });

  it('parses valid reroute params', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'reroute',
      task: 'Reassign auth work',
      scope: 'src/auth',
      targetAgents: ['opencode'],
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'reroute');
  });

  it('parses valid summarize params with threadId', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'summarize',
      task: 'Summarize review discussion',
      threadId: 'thread-abc-123',
    });
    assert.ok(result.success);
    assert.equal(result.data.threadId, 'thread-abc-123');
  });

  it('rejects unknown intent', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'unknown_intent',
      task: 'do something',
    });
    assert.ok(!result.success);
    assert.ok(result.error.message.includes('invalid_enum_value') || result.error.issues.length > 0);
  });

  it('rejects missing task field', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
    });
    assert.ok(!result.success);
  });

  it('rejects missing intent field', () => {
    const result = CoordinateRequestSchema.safeParse({
      task: 'do something',
    });
    assert.ok(!result.success);
  });

  it('accepts constraints as arbitrary record', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'Deploy backend',
      constraints: { deadline: '2026-04-10', reviewRequired: true },
    });
    assert.ok(result.success);
    assert.deepEqual(result.data.constraints, { deadline: '2026-04-10', reviewRequired: true });
  });
});

describe('bclaw_coordinate — assign without targetAgents uses getSpawnableAgents', () => {
  it('getSpawnableAgents returns CLI-spawnable agents', () => {
    const spawnable = getSpawnableAgents();
    assert.ok(Array.isArray(spawnable));
    assert.ok(spawnable.length > 0, 'at least one spawnable agent must exist');
    for (const entry of spawnable) {
      assert.ok(typeof entry.name === 'string', 'each entry has a name');
      assert.ok(typeof entry.template.command === 'string', 'each entry has a command template');
      assert.ok(typeof entry.template.binary === 'string', 'each entry has a binary');
    }
  });

  it('getSpawnableAgents includes known CLI agents', () => {
    const spawnable = getSpawnableAgents();
    const names = spawnable.map((a) => a.name);
    // claude-code, codex, opencode are CLI-spawnable in profiles
    assert.ok(names.includes('claude-code'), 'claude-code should be spawnable');
    assert.ok(names.includes('codex'), 'codex should be spawnable');
  });

  it('CoordinateRequestSchema without targetAgents signals fallback to getSpawnableAgents', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'Build the widget',
    });
    assert.ok(result.success);
    // targetAgents undefined → handler falls back to getSpawnableAgents()
    assert.equal(result.data.targetAgents, undefined);
    const spawnable = getSpawnableAgents();
    assert.ok(spawnable.length > 0, 'fallback list is non-empty');
  });
});

// ── Side-effect regression tests ─────────────────────────────

interface CoordinateResult extends FacadeResponse {
  result: Record<string, unknown>;
}

async function coordinate(
  workspace: TestWorkspace,
  args: Record<string, unknown>,
): Promise<CoordinateResult> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_coordinate',
    args,
    cwd: workspace.dir,
  });
  assert.equal(outcome.response.isError, false, `Tool error: ${JSON.stringify(outcome.response)}`);
  return outcome.response.structuredContent as unknown as CoordinateResult;
}

describe('bclaw_coordinate — side effects', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({
      prefix: 'bclaw-coordinate-fx-',
      currentAgent: 'claude-code',
    });
    workspace.registerAgent('codex');
    workspace.registerAgent('github-copilot');
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    if (previousTestMode === undefined) {
      delete process.env.BRAINCLAW_TEST_MODE;
      return;
    }
    process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  // ── assign ──────────────────────────────────────────────

  describe('intent=assign', () => {
    it('creates a claim and writes an inbox message per target agent', async () => {
      const response = await coordinate(workspace, {
        intent: 'assign',
        task: 'Refactor delivery module',
        scope: 'src/core/delivery.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      assert.equal(response.status, 'ok');
      assert.equal(response.intent, 'assign');

      // Claim created
      const claims = listClaims(workspace.dir).filter(c => c.status === 'active');
      assert.equal(claims.length, 1);
      assert.equal(claims[0].agent, 'codex');
      assert.equal(claims[0].scope, 'src/core/delivery.ts');

      // Inbox message written
      const inbox = readInbox({ agent: 'codex' }, workspace.dir);
      assert.ok(inbox.messages.length >= 1, 'Expected at least 1 inbox message');
      const assignMsg = inbox.messages.find(m => m.type === 'assign');
      assert.ok(assignMsg, 'Expected an assign message');
      assert.equal(assignMsg.from, 'claude-code');
      assert.equal(assignMsg.to, 'codex');
      assert.ok(assignMsg.text.includes('Refactor delivery module'));
    });

    it('returns delivery_plan with channel=inbox and command hints', async () => {
      const response = await coordinate(workspace, {
        intent: 'assign',
        task: 'Fix the bug',
        scope: 'src/core/bug.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      const result = response.result;
      assert.ok(Array.isArray(result.delivery_plan), 'Expected delivery_plan array');
      const plan = (result.delivery_plan as Array<Record<string, unknown>>)[0];
      assert.equal(plan.channel, 'inbox');
      assert.equal(plan.agent, 'codex');
      assert.ok(typeof plan.message_id === 'string', 'Expected message_id');

      assert.ok(Array.isArray(result.commands), 'Expected commands array');
    });

    it('warns on duplicate assignment for same scope', async () => {
      await coordinate(workspace, {
        intent: 'assign',
        task: 'First assignment',
        scope: 'src/core/dup.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      const response = await coordinate(workspace, {
        intent: 'assign',
        task: 'Second assignment',
        scope: 'src/core/dup.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      assert.ok(response.warnings.length > 0, 'Expected duplicate-assignment warning');
      const warningText = response.warnings.join(' ');
      assert.ok(
        warningText.includes('already_assigned') || warningText.includes('already_claimed'),
        `Expected warning about duplicate, got: ${warningText}`,
      );
    });
  });

  // ── consult ─────────────────────────────────────────────

  describe('intent=consult', () => {
    it('writes inbox messages without creating claims', async () => {
      const response = await coordinate(workspace, {
        intent: 'consult',
        task: 'What do you think about this architecture?',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      assert.equal(response.status, 'ok');
      assert.equal(response.intent, 'consult');

      const claims = listClaims(workspace.dir).filter(c => c.status === 'active');
      assert.equal(claims.length, 0, 'Consult should not create claims');

      const inbox = readInbox({ agent: 'codex' }, workspace.dir);
      assert.ok(inbox.messages.length >= 1, 'Expected inbox message for consult');
      const rfcMsg = inbox.messages.find(m => m.type === 'rfc');
      assert.ok(rfcMsg, 'Expected an rfc message type');
      assert.equal(rfcMsg.from, 'claude-code');
    });

    it('returns a thread_id for the consultation', async () => {
      const response = await coordinate(workspace, {
        intent: 'consult',
        task: 'Review this design',
        targetAgents: ['codex', 'github-copilot'],
        agent: 'claude-code',
      });

      const result = response.result;
      assert.ok(typeof result.thread_id === 'string', 'Expected thread_id');
      assert.ok(Array.isArray(result.contacted), 'Expected contacted array');
      assert.deepEqual(result.contacted, ['codex', 'github-copilot']);
    });
  });

  // ── reroute ─────────────────────────────────────────────

  describe('intent=reroute', () => {
    it('releases old claim, creates new one, and writes inbox message', async () => {
      await coordinate(workspace, {
        intent: 'assign',
        task: 'Original task',
        scope: 'src/core/reroute-target.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      const claimsBefore = listClaims(workspace.dir).filter(c => c.status === 'active');
      assert.equal(claimsBefore.length, 1);
      assert.equal(claimsBefore[0].agent, 'codex');

      const response = await coordinate(workspace, {
        intent: 'reroute',
        task: 'Rerouted task',
        scope: 'src/core/reroute-target.ts',
        targetAgents: ['github-copilot'],
        agent: 'claude-code',
      });

      assert.equal(response.status, 'ok');
      assert.equal(response.intent, 'reroute');

      const result = response.result;
      assert.equal(result.old_agent, 'codex');
      assert.equal(result.new_agent, 'github-copilot');
      assert.ok(typeof result.released_claim === 'string');
      assert.ok(typeof result.new_claim_id === 'string');

      const allClaims = listClaims(workspace.dir);
      const activeClaims = allClaims.filter(c => c.status === 'active');
      assert.equal(activeClaims.length, 1);
      assert.equal(activeClaims[0].agent, 'github-copilot');

      const releasedClaims = allClaims.filter(c => c.status === 'released');
      assert.ok(releasedClaims.length >= 1);

      const inbox = readInbox({ agent: 'github-copilot' }, workspace.dir);
      assert.ok(inbox.messages.length >= 1, 'Expected inbox message for rerouted agent');
    });
  });

  // ── response metadata ───────────────────────────────────

  describe('response metadata', () => {
    it('messages_sent has correct structure', async () => {
      const response = await coordinate(workspace, {
        intent: 'assign',
        task: 'Check metadata',
        scope: 'src/meta.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      const result = response.result;
      assert.ok(Array.isArray(result.messages_sent), 'Expected messages_sent array');
      const sent = (result.messages_sent as Array<Record<string, unknown>>)[0];
      assert.ok(typeof sent.message_id === 'string');
      assert.equal(sent.channel, 'inbox');
      assert.equal(sent.agent, 'codex');
    });

    it('side_effects track all created entities', async () => {
      const response = await coordinate(workspace, {
        intent: 'assign',
        task: 'Track side effects',
        scope: 'src/effects.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      const claimEffects = response.side_effects.filter(e => e.entity === 'claim');
      const messageEffects = response.side_effects.filter(e => e.entity === 'message');
      assert.ok(claimEffects.length >= 1, 'Expected claim side effect');
      assert.ok(messageEffects.length >= 1, 'Expected message side effect');
    });
  });
});
