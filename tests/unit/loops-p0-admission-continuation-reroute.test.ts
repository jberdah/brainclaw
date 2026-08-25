import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { listAssignments } from '../../src/core/assignments.js';
import { listClaims } from '../../src/core/claims.js';
import { advance, getLoop, listLoops, openLoop } from '../../src/core/loops/index.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

async function call(workspace: TestWorkspace, name: string, args: Record<string, unknown>) {
  return executeMcpToolCall({
    name,
    args: {
      agent: workspace.currentAgent.agent_name,
      agentId: workspace.currentAgent.agent_id,
      ...args,
    },
    cwd: workspace.dir,
  });
}

describe('pln#692 P0 — admission, continuation diagnostics, reroute preflight', () => {
  let workspace: TestWorkspace;
  let previousNoSpawn: string | undefined;

  beforeEach(() => {
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-pln692-p0-', currentAgent: 'claude-code' });
  });

  afterEach(() => {
    workspace.cleanup();
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('refuses an infeasible 1/3 ideation gate before creating any durable state', async () => {
    const outcome = await call(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      task: 'Pressure-test a proposal with insufficient critic capacity',
      targetAgents: ['codex'],
      autoExecute: true,
    });

    assert.equal(outcome.response.isError, true);
    const body = outcome.response.structuredContent as {
      error: { kind: string; details: { gate: { expected: number; observed: number }; next_actions: unknown[] } };
    };
    assert.equal(body.error.kind, 'ideate_gate_capacity_unavailable');
    assert.deepEqual(body.error.details.gate, {
      phase: 'critique', kind: 'min_artifacts_by_type', expected: 3, observed: 1,
    });
    assert.ok(body.error.details.next_actions.length > 0);
    assert.equal(listLoops({}, workspace.dir).length, 0);
    assert.equal(listClaims(workspace.dir).length, 0);
    assert.equal(listAssignments(workspace.dir).length, 0);
  });

  it('explains a blocked 0/3 continuation and returns executable recovery actions without mutation', async () => {
    const loop = openLoop({
      kind: 'ideation',
      title: 'Blocked continuation diagnostic',
      created_by: workspace.currentAgent.agent_id,
      slots: [
        { role: 'champion', agent: 'claude-code', agent_id: workspace.currentAgent.agent_id },
        { role: 'critic', agent: 'codex' },
        { role: 'critic', agent: 'opencode' },
        { role: 'critic', agent: 'github-copilot' },
      ],
    }, workspace.dir);
    advance({ id: loop.id, actor: workspace.currentAgent.agent_id }, workspace.dir);
    const before = getLoop(loop.id, workspace.dir)!;

    const outcome = await call(workspace, 'bclaw_loop', {
      intent: 'continue', loop_id: loop.id, action_index: 0,
      autonomy_mode: 'autonomous', risk: 'normal',
    });

    assert.equal(outcome.response.isError, false, 'bclaw_loop returns its domain error in the facade envelope');
    const body = outcome.response.structuredContent as {
      status: string;
      error: string;
      result: {
        gate: { observed: string; passed: boolean };
        blockers: string[];
        next_actions: Array<{ tool: string; args: Record<string, unknown> }>;
      };
      next_actions: Array<{ tool: string; args: Record<string, unknown> }>;
    };
    assert.equal(body.status, 'error');
    assert.match(body.error, /continuation_unavailable/);
    assert.equal(body.result.gate.passed, false);
    assert.match(body.result.gate.observed, /count of type "critique" = 0 < n=3/);
    assert.ok(body.result.blockers.some((blocker) => blocker.includes('plan_draft')));
    assert.equal(body.next_actions.length, 3);
    assert.ok(body.next_actions.every((action) => action.tool === 'bclaw_loop' && action.args.intent === 'turn'));
    const after = getLoop(loop.id, workspace.dir)!;
    assert.equal(after.version, before.version, 'diagnostic path must not mutate the loop');
  });

  it('keeps the predecessor claim active when the reroute target fails admission', async () => {
    const assigned = await call(workspace, 'bclaw_coordinate', {
      intent: 'assign', task: 'Original work', scope: 'src/pln692-reroute.ts', targetAgents: ['codex'],
    });
    assert.equal(assigned.response.isError, false);
    const before = listClaims(workspace.dir).find((claim) => claim.status === 'active');
    assert.ok(before);

    const outcome = await call(workspace, 'bclaw_coordinate', {
      intent: 'reroute', task: 'Move work', scope: before.scope, targetAgents: ['definitely-missing-agent'],
    });

    assert.equal(outcome.response.isError, true);
    const body = outcome.response.structuredContent as { error: { kind: string; details: { active_claim: string; released_claim: null } } };
    assert.equal(body.error.kind, 'reroute_target_unavailable');
    assert.equal(body.error.details.active_claim, before.id);
    assert.equal(body.error.details.released_claim, null);
    const after = listClaims(workspace.dir);
    assert.equal(after.filter((claim) => claim.status === 'active').length, 1);
    assert.equal(after.find((claim) => claim.id === before.id)?.status, 'active');
  });

  it('rejects a claim id used as a Git base before releasing the reroute predecessor', async () => {
    const assigned = await call(workspace, 'bclaw_coordinate', {
      intent: 'assign', task: 'Original work', scope: 'src/pln692-ref.ts', targetAgents: ['codex'],
    });
    assert.equal(assigned.response.isError, false);
    const before = listClaims(workspace.dir).find((claim) => claim.status === 'active');
    assert.ok(before);

    const outcome = await call(workspace, 'bclaw_coordinate', {
      intent: 'reroute', task: 'Move work', scope: before.scope, targetAgents: ['opencode'], ref: before.id,
    });

    assert.equal(outcome.response.isError, true);
    const body = outcome.response.structuredContent as { error: { kind: string; details: { ref: string } } };
    assert.equal(body.error.kind, 'invalid_dispatch_ref');
    assert.equal(body.error.details.ref, before.id);
    assert.equal(listClaims(workspace.dir).find((claim) => claim.id === before.id)?.status, 'active');
  });
});
