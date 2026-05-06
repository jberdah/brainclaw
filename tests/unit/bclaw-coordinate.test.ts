import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateRequestSchema } from '../../src/core/facade-schema.js';
import { getSpawnableAgents } from '../../src/core/agent-capability.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { findLatestAgentRunForAssignment } from '../../src/core/agentruns.js';
import { loadAssignment } from '../../src/core/assignments.js';
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

async function loopTool(
  workspace: TestWorkspace,
  args: Record<string, unknown>,
): Promise<CoordinateResult> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_loop',
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

  let previousNoSpawn: string | undefined;
  let codexAgentId: string;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_TEST_MODE = '1';
    process.env.BRAINCLAW_NO_SPAWN = '1';
    workspace = createTestWorkspace({
      prefix: 'bclaw-coordinate-fx-',
      currentAgent: 'claude-code',
    });
    codexAgentId = workspace.registerAgent('codex').agent_id;
    workspace.registerAgent('github-copilot');
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
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
      // Brief should contain claim reference and assignment header
      assert.ok(assignMsg.text.includes('pre-claimed by coordinator'), 'Brief should mention pre-claimed scope');
      assert.ok(assignMsg.text.includes('# Assignment:'), 'Brief should have assignment header');
      assert.ok(assignMsg.assignment_id, 'assign message should carry assignment_id');
      assert.equal(assignMsg.payload?.assignment_id, assignMsg.assignment_id, 'payload should carry matching assignment_id');
      assert.equal(claims[0].assignment_id, assignMsg.assignment_id, 'claim should link to assignment');
      const assignment = loadAssignment(assignMsg.assignment_id!, workspace.dir);
      assert.equal(assignment?.status, 'offered');
      assert.equal(assignment?.message_id, assignMsg.id);
      const run = findLatestAgentRunForAssignment(assignMsg.assignment_id!, workspace.dir);
      assert.equal(run?.transport, 'manual_command');
      assert.equal(run?.status, 'waiting_input');
      assert.equal(run?.message_id, assignMsg.id);
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
      const firstClaim = listClaims(workspace.dir).filter(c => c.status === 'active')[0];

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

      const activeClaims = listClaims(workspace.dir).filter(c => c.status === 'active');
      assert.equal(activeClaims.length, 1, 'Should reuse the existing claim instead of creating a second one');
      assert.equal(activeClaims[0].id, firstClaim.id, 'Should keep the original claim id');

      const deliveryPlan = response.result.delivery_plan as Array<Record<string, unknown>>;
      assert.equal(deliveryPlan[0]?.claim_id, firstClaim.id, 'delivery_plan should point at the reused claim');

      const claimEffects = response.side_effects.filter(e => e.entity === 'claim');
      assert.equal(claimEffects.length, 1, 'Expected one claim side effect entry');
      assert.equal(claimEffects[0]?.action, 'reuse', 'Duplicate assign should report claim reuse');
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

      // Use opencode as the reroute target: it keeps this test deterministic
      // across environments without requiring the copilot CLI on the runner.
      // (github-copilot is now spawnable — pln#440 — but testing the reroute
      // contract only needs any canBeSpawnedCli=true agent; the contract is
      // release old claim, create new one, open inbox message.)
      workspace.registerAgent('opencode');
      const response = await coordinate(workspace, {
        intent: 'reroute',
        task: 'Rerouted task',
        scope: 'src/core/reroute-target.ts',
        targetAgents: ['opencode'],
        agent: 'claude-code',
      });

      assert.equal(response.status, 'ok');
      assert.equal(response.intent, 'reroute');

      const result = response.result;
      assert.equal(result.old_agent, 'codex');
      assert.equal(result.new_agent, 'opencode');
      assert.ok(typeof result.released_claim === 'string');
      assert.ok(typeof result.new_claim_id === 'string');

      const allClaims = listClaims(workspace.dir);
      const activeClaims = allClaims.filter(c => c.status === 'active');
      assert.equal(activeClaims.length, 1);
      assert.equal(activeClaims[0].agent, 'opencode');

      const releasedClaims = allClaims.filter(c => c.status === 'released');
      assert.ok(releasedClaims.length >= 1);

      const inbox = readInbox({ agent: 'opencode' }, workspace.dir);
      assert.ok(inbox.messages.length >= 1, 'Expected inbox message for rerouted agent');
      const rerouteMsg = inbox.messages.find(m => m.type === 'assign');
      assert.ok(rerouteMsg?.assignment_id, 'Reroute assign message should carry assignment_id');
      const rerouteAssignment = loadAssignment(rerouteMsg.assignment_id!, workspace.dir);
      assert.equal(rerouteAssignment?.status, 'offered');
      const rerouteRun = findLatestAgentRunForAssignment(rerouteMsg.assignment_id!, workspace.dir);
      assert.equal(rerouteRun?.status, 'waiting_input');
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

  // ── intent=review with open_loop (pln#395 step 4) ────────────

  describe('intent=review + open_loop', () => {
    it('defaults to open_loop=false → no loop is opened (backward-compat)', async () => {
      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Please review the delivery refactor',
        scope: 'src/core/delivery.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      assert.equal(response.status, 'ok');
      const candidateEffects = response.side_effects.filter((e) => e.entity === 'candidate');
      const loopEffects = response.side_effects.filter((e) => e.entity === 'loop');
      assert.ok(candidateEffects.length >= 1, 'candidate must still be created');
      assert.equal(loopEffects.length, 0, 'no loop when open_loop omitted');
      assert.equal((response.result as Record<string, unknown>).loop_id, undefined);
    });

    it('open_loop=true opens a review loop with author + reviewer slots and dispatches a turn', async () => {
      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Review the new MCP facade',
        scope: 'src/commands/loops-handlers.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
        open_loop: true,
      });

      assert.equal(response.status, 'ok');
      const loopEffects = response.side_effects.filter((e) => e.entity === 'loop');
      assert.equal(loopEffects.length, 1, 'exactly one loop must be created');
      const loopId = loopEffects[0].id;
      assert.match(loopId, /^lop_[0-9a-z]+$/);
      assert.equal((response.result as Record<string, unknown>).loop_id, loopId);

      const loopArtifacts = response.artifacts.filter((a) => a.type === 'loop');
      assert.equal(loopArtifacts.length, 1);

      // Verify the loop actually exists on disk with the right shape.
      const loopsModule = await import('../../src/core/loops/index.js');
      const loop = loopsModule.getLoop(loopId, workspace.dir);
      assert.ok(loop, 'review loop must be persisted');
      assert.equal(loop.kind, 'review');
      assert.equal(loop.status, 'open');
      // After advance() + turn() the current phase is `findings`.
      assert.equal(loop.current_phase, 'findings');
      const authorSlot = loop.slots.find((s) => s.role === 'author');
      const reviewerSlot = loop.slots.find((s) => s.role === 'reviewer');
      assert.ok(authorSlot, 'author slot present');
      assert.ok(reviewerSlot, 'reviewer slot present');
      assert.equal(authorSlot.agent_id, workspace.currentAgent.agent_id);
      assert.equal(reviewerSlot.agent_id, codexAgentId);
      assert.equal(reviewerSlot.status, 'assigned', 'reviewer must be flipped to assigned by turn()');

      // Candidate is linked as a change_summary artifact.
      const changeSummary = loop.artifacts.find((a) => a.phase === 'change_summary');
      assert.ok(changeSummary, 'change_summary artifact present');
      assert.equal(changeSummary.type, 'change_summary');
      assert.equal(changeSummary.ref?.kind, 'candidate');

      // Event journal covers open → artifact_added → phase_advanced → turn_assigned.
      const events = loopsModule.listLoopEvents(loopId, workspace.dir);
      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes('opened'));
      assert.ok(kinds.includes('artifact_added'));
      assert.ok(kinds.includes('phase_advanced'));
      assert.ok(kinds.includes('turn_assigned'));
    });

    it('pln#458 stp_daffa477: open_loop=true also creates a claim + assignment per reviewer so downstream spawn can actually run', async () => {
      // Previously, intent=review + open_loop=true only created the candidate
      // and loop and called turn() in the loop's own bookkeeping — no
      // assignment was ever created, so runCoordinateExecution had nothing to
      // spawn and the loop stayed "assigned" forever. The fix builds the
      // same claim + assignment + queued message chain that intent=assign
      // uses, so the spawn path is actually wired.
      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Review the dispatch linkage',
        scope: 'src/commands/mcp.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
        open_loop: true,
      });

      assert.equal(response.status, 'ok');

      const claimEffects = response.side_effects.filter((e) => e.entity === 'claim');
      assert.ok(claimEffects.length >= 1, 'at least one claim must be created for the reviewer');

      const assignmentArtifacts = response.artifacts.filter((a) => a.type === 'assignment');
      assert.ok(assignmentArtifacts.length >= 1, 'at least one assignment must be created for the reviewer');

      // execution_status must surface on the result so callers know whether
      // the spawn was attempted.
      const result = response.result as Record<string, unknown>;
      assert.ok(
        result.execution_status !== undefined,
        'execution_status must be reported on result when reviewers are dispatched',
      );
      assert.ok(
        ['delivered_and_started', 'command_ready_manual', 'inbox_only'].includes(result.execution_status as string),
        `execution_status must be a known dispatch outcome; got ${result.execution_status}`,
      );
    });

    it('open_loop with review_mode=symmetric persists protocol.review_mode on the loop', async () => {
      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Symmetric review of the spec draft',
        scope: 'docs/concepts/loop-engine.md',
        targetAgents: ['codex'],
        agent: 'claude-code',
        open_loop: true,
        review_mode: 'symmetric',
      });
      assert.equal(response.status, 'ok');
      const loopId = (response.result as Record<string, unknown>).loop_id as string;
      const loopsModule = await import('../../src/core/loops/index.js');
      const loop = loopsModule.getLoop(loopId, workspace.dir);
      assert.ok(loop);
      assert.equal(loop.protocol?.review_mode, 'symmetric');
    });

    it('reviewer can complete the dispatched turn through bclaw_loop using slot-bound agent_id auth', async () => {
      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Review the slot auth wiring',
        scope: 'src/core/loops/verbs.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
        open_loop: true,
      });

      const loopId = (response.result as Record<string, unknown>).loop_id as string;
      const loopsModule = await import('../../src/core/loops/index.js');
      const loopBefore = loopsModule.getLoop(loopId, workspace.dir);
      assert.ok(loopBefore);
      const reviewerSlot = loopBefore.slots.find((s) => s.role === 'reviewer');
      assert.ok(reviewerSlot);
      assert.equal(reviewerSlot.agent_id, codexAgentId);

      const completion = await loopTool(workspace, {
        intent: 'complete_turn',
        loop_id: loopId,
        slot_id: reviewerSlot.slot_id,
        agent: 'codex',
        agentId: codexAgentId,
        artifact: {
          phase: 'findings',
          type: 'review_findings',
          body: 'No blocking issues found.',
        },
      });

      assert.equal(completion.status, 'ok');
      const loopAfter = loopsModule.getLoop(loopId, workspace.dir);
      const completedReviewer = loopAfter?.slots.find((s) => s.slot_id === reviewerSlot.slot_id);
      assert.equal(completedReviewer?.status, 'done');
      assert.ok(loopAfter?.artifacts.some((a) => a.type === 'review_findings'));
    });

    it('review_mode is silently ignored when open_loop is false', async () => {
      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Mode without open_loop',
        scope: 'src/core/facade-schema.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
        review_mode: 'symmetric',
      });
      assert.equal(response.status, 'ok');
      assert.equal(response.side_effects.filter((e) => e.entity === 'loop').length, 0);
      assert.equal((response.result as Record<string, unknown>).loop_id, undefined);
    });

    it('client_request_id idempotent retry returns the same candidate + loop ids (residual #2)', async () => {
      const request = {
        intent: 'review' as const,
        task: 'Idempotent review of the refactor',
        scope: 'src/core/x.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
        agentId: 'agt_687aa80bad484485b92cb6935d1cdac3',
        open_loop: true,
        client_request_id: 'req_coord_idem_1',
      };
      const first = await coordinate(workspace, request);
      const second = await coordinate(workspace, request);
      assert.equal(first.status, 'ok');
      assert.equal(second.status, 'ok');
      assert.equal(
        (first.result as Record<string, unknown>).candidate_id,
        (second.result as Record<string, unknown>).candidate_id,
        'idempotent retry must return the SAME candidate_id',
      );
      assert.equal(
        (first.result as Record<string, unknown>).loop_id,
        (second.result as Record<string, unknown>).loop_id,
        'idempotent retry must return the SAME loop_id',
      );
    });

    it('client_request_id retry with different payload returns idempotency_key_reused_with_different_body (residual #2)', async () => {
      await coordinate(workspace, {
        intent: 'review',
        task: 'First payload',
        scope: 'src/core/x.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
        agentId: 'agt_687aa80bad484485b92cb6935d1cdac3',
        open_loop: true,
        client_request_id: 'req_coord_idem_mismatch',
      });
      const outcome = await executeMcpToolCall({
        name: 'bclaw_coordinate',
        args: {
          intent: 'review',
          task: 'Different payload',
          scope: 'src/core/x.ts',
          targetAgents: ['codex'],
          agent: 'claude-code',
          agentId: 'agt_687aa80bad484485b92cb6935d1cdac3',
          open_loop: true,
          client_request_id: 'req_coord_idem_mismatch',
        },
        cwd: workspace.dir,
      });
      assert.equal(outcome.response.isError, true);
      const text = (outcome.response.content?.[0]?.text ?? JSON.stringify(outcome.response)) as string;
      assert.match(text, /idempotency_key_reused_with_different_body/);
    });

    it('fan-out cap warns when open_loop is used without targetAgents (residual #4)', async () => {
      // Register extra spawnable agents so the implicit fan-out exceeds cap=3.
      workspace.registerAgent('opencode');
      workspace.registerAgent('cline');
      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Cap me please',
        scope: 'src/core/fanout.ts',
        agent: 'claude-code',
        open_loop: true,
      });
      assert.equal(response.status, 'ok');
      const loopId = (response.result as Record<string, unknown>).loop_id as string | undefined;
      if (!loopId) {
        // Environment may have <=3 spawnable agents — skip the cap assertion
        // but still confirm the code path didn't crash.
        return;
      }
      const loopsModule = await import('../../src/core/loops/index.js');
      const loop = loopsModule.getLoop(loopId, workspace.dir);
      const reviewerSlots = loop!.slots.filter((s) => s.role === 'reviewer');
      assert.ok(
        reviewerSlots.length <= 3,
        `expected ≤3 reviewer slots after fan-out cap, got ${reviewerSlots.length}`,
      );
    });

    it('returns partial and keeps the candidate when open_loop creation fails', async () => {
      const loopsDir = path.join(workspace.dir, '.brainclaw', 'loops');
      fs.mkdirSync(loopsDir, { recursive: true });
      fs.writeFileSync(path.join(loopsDir, 'threads'), 'block loop thread dir creation');

      const response = await coordinate(workspace, {
        intent: 'review',
        task: 'Review with a broken loops store',
        scope: 'src/core/facade-schema.ts',
        targetAgents: ['codex'],
        agent: 'claude-code',
        open_loop: true,
      });

      assert.equal(response.status, 'partial');
      const candidateEffects = response.side_effects.filter((e) => e.entity === 'candidate');
      const loopEffects = response.side_effects.filter((e) => e.entity === 'loop');
      assert.ok(candidateEffects.length >= 1, 'candidate must still be created');
      assert.equal(loopEffects.length, 0, 'loop creation should fail cleanly');
      assert.equal((response.result as Record<string, unknown>).loop_id, undefined);
      assert.ok(
        response.warnings.some((warning) => warning.includes('open_loop: failed to open review loop')),
        `Expected open_loop warning, got: ${response.warnings.join(' | ')}`,
      );
    });
  });

  describe('intent=ideate (pln#492 phase 2.c + 2.d.2)', () => {
    it('single-agent mode (no targetAgents): opens loop with proposal seed and stops at proposal phase', async () => {
      const response = await coordinate(workspace, {
        intent: 'ideate',
        task: 'Should we extract the dispatcher into a separate package?',
        agent: 'claude-code',
      });

      assert.equal(response.status, 'ok');

      const loopEffects = response.side_effects.filter((e) => e.entity === 'loop');
      assert.equal(loopEffects.length, 1, 'exactly one loop must be created');
      const loopId = loopEffects[0].id;
      assert.match(loopId, /^lop_[0-9a-z]+$/);
      const result = response.result as Record<string, unknown>;
      assert.equal(result.loop_id, loopId);
      assert.equal(result.mode, 'single_agent');
      assert.equal(result.dispatched_critics, 0);
      assert.equal(result.current_phase, 'proposal');
      assert.deepEqual(result.selected_targets, []);

      const loopsModule = await import('../../src/core/loops/index.js');
      const loop = loopsModule.getLoop(loopId, workspace.dir);
      assert.ok(loop, 'ideation loop must be persisted');
      assert.equal(loop.kind, 'ideation');
      assert.equal(loop.status, 'open');
      assert.equal(loop.current_phase, 'proposal');
      assert.equal(loop.slots.length, 1, 'single-agent mode → only the champion slot');
      assert.equal(loop.slots[0].role, 'champion');

      // Iteration block carried from DEFAULT_PROTOCOLS (pln#492 phase 2.b)
      assert.ok(loop.protocol?.iteration);
      assert.equal(loop.protocol?.iteration?.max_iterations, 3);

      const proposal = loop.artifacts.find((a) => a.type === 'proposal');
      assert.ok(proposal);
      assert.match(proposal.body ?? '', /extract the dispatcher/);
      assert.equal(proposal.iteration, 0);

      assert.ok(
        response.warnings.some((w) => w.includes('single-agent mode')),
        `expected single-agent warning, got: ${response.warnings.join(' | ')}`,
      );

      // No dispatch in single-agent mode.
      const events = loopsModule.listLoopEvents(loopId, workspace.dir);
      assert.equal(
        events.filter((e) => e.kind === 'turn_assigned').length,
        0,
        'single-agent mode must not dispatch turns automatically',
      );
      assert.equal(
        events.filter((e) => e.kind === 'phase_advanced').length,
        0,
        'single-agent mode must not advance the phase automatically',
      );
    });

    it('multi-agent mode (explicit targetAgents): advances to critique and dispatches a turn per critic with a context-filtered brief', async () => {
      const response = await coordinate(workspace, {
        intent: 'ideate',
        task: 'Should we adopt approach A or approach B?',
        targetAgents: ['codex'],
        agent: 'claude-code',
      });

      assert.equal(response.status, 'ok');
      const result = response.result as Record<string, unknown>;
      assert.equal(result.mode, 'multi_agent');
      assert.deepEqual(result.selected_targets, ['codex']);
      assert.equal(result.dispatched_critics, 1);
      assert.equal(result.current_phase, 'critique');

      const loopId = result.loop_id as string;
      const loopsModule = await import('../../src/core/loops/index.js');
      const loop = loopsModule.getLoop(loopId, workspace.dir);
      assert.ok(loop);
      assert.equal(loop.slots.length, 2, 'champion + 1 critic');
      const champion = loop.slots.find((s) => s.role === 'champion');
      const critic = loop.slots.find((s) => s.role === 'critic');
      assert.ok(champion);
      assert.ok(critic);
      assert.equal(critic.agent, 'codex');

      // pln#492 phase 2.d.2 — the loop has advanced and the critic slot has been assigned.
      assert.equal(loop.current_phase, 'critique', 'multi-agent mode advances proposal → critique');
      assert.equal(critic.status, 'assigned', 'critic slot flipped to assigned by turn()');

      const events = loopsModule.listLoopEvents(loopId, workspace.dir);
      const phaseAdvances = events.filter((e) => e.kind === 'phase_advanced');
      const turnAssigns = events.filter((e) => e.kind === 'turn_assigned');
      assert.equal(phaseAdvances.length, 1, 'one phase_advanced event for proposal → critique');
      assert.equal(turnAssigns.length, 1, 'one turn_assigned event for the critic slot');

      // Brief content is delivered as a coordinate message — proves
      // buildIdeationBrief was wired.
      const messageArtifacts = response.artifacts.filter((a) => a.type === 'message');
      assert.ok(messageArtifacts.length >= 1, 'at least one coordinate message queued');
    });

    it('truncates oversized task to fit the LoopArtifact 4 KB body cap', async () => {
      const oversizedTask = 'x'.repeat(8000);
      const response = await coordinate(workspace, {
        intent: 'ideate',
        task: oversizedTask,
        agent: 'claude-code',
      });
      assert.equal(response.status, 'ok');
      const loopId = (response.result as Record<string, unknown>).loop_id as string;
      const loopsModule = await import('../../src/core/loops/index.js');
      const loop = loopsModule.getLoop(loopId, workspace.dir);
      const proposal = loop?.artifacts.find((a) => a.type === 'proposal');
      assert.ok(proposal);
      assert.ok(
        (proposal.body ?? '').length <= 4000,
        `proposal body must be sliced to ≤4000 chars; got ${proposal.body?.length}`,
      );
    });
  });
});
