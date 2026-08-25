import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { listAssignments } from '../../src/core/assignments.js';
import { createCoordinatorClaim, listClaims } from '../../src/core/claims.js';
import { fingerprintPublicKeyPem } from '../../src/core/agent-registry.js';
import { advance, getLoop, listLoops, openLoop } from '../../src/core/loops/index.js';
import { resolveTurnGenerationChain } from '../../src/core/loops/attempt-generations.js';
import {
  activateAttemptAuthorityV2,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
} from '../../src/core/loops/attempt-rollout.js';
import { prepareTurnExecution } from '../../src/core/loops/turn-execution.js';
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

  it('reroutes a loop-owned assignment through a new immutable generation and executor claim', async () => {
    execFileSync('git', ['init'], { cwd: workspace.dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'brainclaw-test@example.invalid'], { cwd: workspace.dir });
    execFileSync('git', ['config', 'user.name', 'Brainclaw Test'], { cwd: workspace.dir });
    fs.writeFileSync(`${workspace.dir}/seed.txt`, 'seed\n');
    execFileSync('git', ['add', 'seed.txt'], { cwd: workspace.dir });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: workspace.dir, stdio: 'ignore' });
    const home = ensureLocalAuthorityHome(workspace.dir);
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    prepareAttemptAuthorityRollout(workspace.dir, {
      membership_epoch: 1,
      authority_home: home,
      participants: [{
        writer_id: workspace.currentAgent.agent_id,
        public_key_pem: publicKeyPem,
        key_fingerprint: fingerprintPublicKeyPem(publicKeyPem),
        status: 'active',
      }],
      prepared_by: workspace.currentAgent.agent_id,
    });
    publishAttemptRolloutAck(workspace.dir, {
      membership_epoch: 1,
      writer_id: workspace.currentAgent.agent_id,
      writer_version: 2,
      private_key_pem: privateKeyPem,
    });
    activateAttemptAuthorityV2(workspace.dir, 1, workspace.currentAgent.agent_id);

    const loop = openLoop({
      kind: 'review', title: 'loop-owned reroute', created_by: workspace.currentAgent.agent_id,
      mode: 'symmetric', phases: [{ name: 'findings' }],
      stop_condition: { kind: 'reviewer_green' },
      slots: [{ role: 'reviewer', agent: 'codex' }],
    }, workspace.dir);
    const scope = `review-loop:${loop.id}`;
    const predecessorClaim = createCoordinatorClaim({
      agent: 'codex', scope, description: 'initial reviewer',
      dispatcherAgent: workspace.currentAgent.agent_name, cwd: workspace.dir,
    });
    assert.ok(predecessorClaim.worktreePath);
    const first = prepareTurnExecution({
      kind: 'review', loop_id: loop.id, slot_id: loop.slots[0]!.slot_id, phase: 'findings',
      agent: 'codex', claim_id: predecessorClaim.claimId,
      dispatcher_agent: workspace.currentAgent.agent_name,
      dispatcher_agent_id: workspace.currentAgent.agent_id,
      scope, description: 'initial reviewer', task: 'review', cwd: workspace.dir,
      worktree_path: predecessorClaim.worktreePath,
    });
    assert.equal(first.kind, 'won');
    if (first.kind !== 'won') return;
    const initialAssignment = first.assignment_id;

    const outcome = await call(workspace, 'bclaw_coordinate', {
      intent: 'reroute', task: 'reroute the live review lane', scope,
      targetAgents: ['opencode'], autoExecute: false, allow_dirty: true,
    });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response.content));
    const body = outcome.response.structuredContent as {
      result: { assignment_id: string; run_id: string; attempt_epoch: number; new_claim_id: string };
    };
    assert.equal(body.result.attempt_epoch, 1);
    assert.notEqual(body.result.assignment_id, initialAssignment);
    assert.notEqual(body.result.new_claim_id, predecessorClaim.claimId);
    assert.equal(listClaims(workspace.dir).find((claim) => claim.id === predecessorClaim.claimId)?.status, 'released');
    assert.equal(listClaims(workspace.dir).find((claim) => claim.id === body.result.new_claim_id)?.agent, 'opencode');
    assert.equal(listAssignments(workspace.dir).find((assignment) => assignment.id === initialAssignment)?.status, 'rerouted');
    const chain = resolveTurnGenerationChain(workspace.dir, first.turn_id);
    assert.equal(chain?.latest_generation.assignment_id, body.result.assignment_id);
    assert.equal(chain?.latest_generation.executor?.claim_id, body.result.new_claim_id);
    assert.equal(chain?.latest_generation.executor?.agent, 'opencode');
    assert.equal(getLoop(loop.id, workspace.dir)?.slots[0]?.assignment_id, body.result.assignment_id);
  });
});
