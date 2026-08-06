import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { executeMcpToolCall, handleMcpReadToolCall } from '../../src/commands/mcp.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { createAgentRun, loadAgentRun, transitionAgentRun } from '../../src/core/agentruns.js';
import { createActionRequired, listActionRequired, loadActionRequired } from '../../src/core/actions.js';
import { loadAssignment } from '../../src/core/assignments.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createTestWorkspace({ currentAgent: 'dispatcher' });
});

afterEach(() => {
  workspace.cleanup();
});

/**
 * pln#562 step 3 — the MCP connection principal is pinned from server-side
 * env, and caller args can no longer impersonate another agent. Simulate a
 * separate connection per agent by switching the env identity.
 */
function actAs(identity: { agent_name: string; agent_id: string }): void {
  process.env.BRAINCLAW_AGENT_NAME = identity.agent_name;
  process.env.BRAINCLAW_AGENT = identity.agent_name;
  process.env.BRAINCLAW_AGENT_ID = identity.agent_id;
}

describe('Agent SDK ActionRequired', () => {
  it('creates an action from blocked worker state and resolves back to running/started', async () => {
    const worker = workspace.registerAgent('worker');
    const supervisor = workspace.registerAgent('lead');

    const assignment = createAssignment({
      claim_id: 'clm_action_1',
      plan_id: 'pln_action_1',
      sequence_id: 'seq_action_1',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'dispatcher',
      scope: 'src/runtime/action',
      description: 'Action required flow',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'dispatcher' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: worker.agent_name, session_id: 'sess_worker_1' }, workspace.dir);
    transitionAssignment(assignment.id, 'started', { actor: worker.agent_name, session_id: 'sess_worker_1' }, workspace.dir);

    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      plan_id: assignment.plan_id,
      sequence_id: assignment.sequence_id,
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      session_id: 'sess_worker_1',
      transport: 'manual_command',
      scope: assignment.scope,
      description: 'Action-required run',
    }, workspace.dir);
    transitionAgentRun(run.id, 'waiting_input', { actor: 'dispatcher' }, workspace.dir);
    transitionAgentRun(run.id, 'running', { actor: worker.agent_name, session_id: 'sess_worker_1' }, workspace.dir);

    actAs(worker);
    const blocked = await executeMcpToolCall({
      name: 'bclaw_assignment_update',
      args: {
        assignment_id: assignment.id,
        status: 'blocked',
        blocker: 'Need approval before deploying',
        action_required: {
          kind: 'approval',
          title: 'Approve deploy',
          prompt: 'Deploy auth changes to staging?',
          options: ['approve', 'reject'],
        },
        agent: worker.agent_name,
        agentId: worker.agent_id,
      },
      cwd: workspace.dir,
      connectionSessionId: 'sess_worker_1',
    });
    assert.notEqual(blocked.response.isError, true);
    const actionId = (blocked.response.structuredContent as { action_id?: string }).action_id;
    assert.ok(actionId);
    assert.equal(loadAssignment(assignment.id, workspace.dir)?.status, 'blocked');
    assert.equal(loadAgentRun(run.id, workspace.dir)?.status, 'blocked');

    const listed = handleMcpReadToolCall('bclaw_list_actions', {
      assignmentId: assignment.id,
      status: 'pending',
    }, { cwd: workspace.dir });
    const listedStructured = listed.structuredContent as { total: number; actions: Array<{ id: string; kind: string }> };
    assert.equal(listedStructured.total, 1);
    assert.equal(listedStructured.actions[0].id, actionId);
    assert.equal(listedStructured.actions[0].kind, 'approval');

    actAs(supervisor);
    const resolved = await executeMcpToolCall({
      name: 'bclaw_assignment_action',
      args: {
        action_id: actionId,
        outcome: 'resolved',
        text: 'Approved by lead',
        agent: supervisor.agent_name,
        agentId: supervisor.agent_id,
      },
      cwd: workspace.dir,
      connectionSessionId: 'sess_lead_1',
    });
    assert.notEqual(resolved.response.isError, true);
    assert.equal(loadActionRequired(actionId!, workspace.dir)?.status, 'resolved');
    assert.equal(loadAssignment(assignment.id, workspace.dir)?.status, 'started');
    assert.equal(loadAgentRun(run.id, workspace.dir)?.status, 'running');
  });

  it('supports rejected actions by cancelling the run and failing the assignment', async () => {
    const worker = workspace.registerAgent('worker');
    const supervisor = workspace.registerAgent('lead');

    const assignment = createAssignment({
      claim_id: 'clm_action_2',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'dispatcher',
      scope: 'src/runtime/action-reject',
      description: 'Rejected action flow',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'dispatcher' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: worker.agent_name, session_id: 'sess_worker_2' }, workspace.dir);
    transitionAssignment(assignment.id, 'started', { actor: worker.agent_name, session_id: 'sess_worker_2' }, workspace.dir);

    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      session_id: 'sess_worker_2',
      transport: 'manual_command',
      scope: assignment.scope,
      description: 'Rejected action run',
    }, workspace.dir);
    transitionAgentRun(run.id, 'running', { actor: worker.agent_name, session_id: 'sess_worker_2' }, workspace.dir);

    actAs(worker);
    const blocked = await executeMcpToolCall({
      name: 'bclaw_assignment_update',
      args: {
        assignment_id: assignment.id,
        status: 'blocked',
        blocker: 'Need explicit go/no-go',
        action_required: {
          kind: 'clarification',
          title: 'Clarify rollout',
          prompt: 'Should I continue with the risky migration path?',
        },
        agent: worker.agent_name,
        agentId: worker.agent_id,
      },
      cwd: workspace.dir,
      connectionSessionId: 'sess_worker_2',
    });
    const actionId = (blocked.response.structuredContent as { action_id?: string }).action_id;
    assert.ok(actionId);
    assert.equal(listActionRequired(workspace.dir, { status: 'pending' }).length, 1);

    actAs(supervisor);
    const rejected = await executeMcpToolCall({
      name: 'bclaw_assignment_action',
      args: {
        action_id: actionId,
        outcome: 'rejected',
        text: 'Do not proceed',
        agent: supervisor.agent_name,
        agentId: supervisor.agent_id,
      },
      cwd: workspace.dir,
      connectionSessionId: 'sess_lead_2',
    });
    assert.notEqual(rejected.response.isError, true);
    assert.equal(loadActionRequired(actionId!, workspace.dir)?.status, 'rejected');
    assert.equal(loadAssignment(assignment.id, workspace.dir)?.status, 'failed');
    assert.equal(loadAgentRun(run.id, workspace.dir)?.status, 'cancelled');
  });

  it('prevents a worker from resolving its own action', async () => {
    const worker = workspace.registerAgent('self-resolver');

    const assignment = createAssignment({
      claim_id: 'clm_self_resolve',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'dispatcher',
      scope: 'src/runtime/self-resolve',
      description: 'Self-resolve guard test',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'dispatcher' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: worker.agent_name, session_id: 'sess_self' }, workspace.dir);
    transitionAssignment(assignment.id, 'started', { actor: worker.agent_name, session_id: 'sess_self' }, workspace.dir);

    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      session_id: 'sess_self',
      transport: 'manual_command',
      scope: assignment.scope,
      description: 'Self-resolve run',
    }, workspace.dir);
    transitionAgentRun(run.id, 'running', { actor: worker.agent_name, session_id: 'sess_self' }, workspace.dir);

    actAs(worker);
    const blocked = await executeMcpToolCall({
      name: 'bclaw_assignment_update',
      args: {
        assignment_id: assignment.id,
        status: 'blocked',
        action_required: {
          kind: 'approval',
          title: 'Need approval',
          prompt: 'Approve this?',
        },
        agent: worker.agent_name,
        agentId: worker.agent_id,
      },
      cwd: workspace.dir,
      connectionSessionId: 'sess_self',
    });
    const actionId = (blocked.response.structuredContent as { action_id?: string }).action_id;
    assert.ok(actionId);

    // Worker tries to resolve its own action — should be rejected
    const selfResolve = await executeMcpToolCall({
      name: 'bclaw_assignment_action',
      args: {
        action_id: actionId,
        outcome: 'resolved',
        text: 'I approve myself',
        agent: worker.agent_name,
        agentId: worker.agent_id,
      },
      cwd: workspace.dir,
      connectionSessionId: 'sess_self',
    });
    assert.equal(selfResolve.response.isError, true);
    assert.ok(
      JSON.stringify(selfResolve.response.content).includes('cannot resolve its own action'),
      'Error message should indicate self-resolution is not allowed',
    );
    // Action should still be pending
    assert.equal(loadActionRequired(actionId!, workspace.dir)?.status, 'pending');
  });

  it('expires stale pending actions on list (sweep-on-read)', () => {
    const worker = workspace.registerAgent('worker-expire');

    const assignment = createAssignment({
      claim_id: 'clm_expire',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'dispatcher',
      scope: 'src/runtime/expire',
      description: 'Expiry test',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'dispatcher' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: worker.agent_name, session_id: 'sess_expire' }, workspace.dir);
    transitionAssignment(assignment.id, 'started', { actor: worker.agent_name, session_id: 'sess_expire' }, workspace.dir);
    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      session_id: 'sess_expire',
      transport: 'manual_command',
      scope: assignment.scope,
      description: 'Expired action run',
    }, workspace.dir);
    transitionAgentRun(run.id, 'running', { actor: worker.agent_name, session_id: 'sess_expire' }, workspace.dir);
    transitionAgentRun(run.id, 'blocked', { actor: worker.agent_name, session_id: 'sess_expire' }, workspace.dir);
    transitionAssignment(assignment.id, 'blocked', { actor: worker.agent_name, session_id: 'sess_expire' }, workspace.dir);

    // Create an action with a very short TTL (already expired)
    const action = createActionRequired({
      assignment_id: assignment.id,
      run_id: run.id,
      claim_id: assignment.claim_id,
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      session_id: 'sess_expire',
      kind: 'approval',
      title: 'Old approval',
      prompt: 'This should expire',
      ttl_ms: 1, // 1ms TTL — already expired
    }, workspace.dir);

    // Wait a tick to ensure expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    // List should trigger sweep-on-read and expire the action
    const pending = listActionRequired(workspace.dir, { status: 'pending' });
    assert.equal(pending.length, 0, 'No pending actions should remain');

    const expired = listActionRequired(workspace.dir, { status: 'expired' });
    assert.equal(expired.length, 1, 'Action should be expired');
    assert.equal(expired[0].id, action.id);
    assert.equal(loadAssignment(assignment.id, workspace.dir)?.status, 'failed');
    assert.equal(loadAgentRun(run.id, workspace.dir)?.status, 'timed_out');
  });
});

/**
 * pln#649 — `loadActionRequired` honours its declared `| undefined` instead of throwing.
 *
 * `JsonStore.load` throws on a missing id, so this function could never return undefined
 * and every `if (!action)` branch downstream was unreachable — including the
 * `ActionRequired not found` throw in `resolveActionRequired`, which produced the wrong
 * wording for the wrong reason. `assignments.ts` documents this JsonStore contract and
 * guards it; this module did not (Fable audit).
 *
 * WHAT THE AUDIT OVERSTATED, verified before fixing: it reported the self-approval guard in
 * mcp-write-claims.ts as "skipped by the throw". It is not. That guard is
 * `if (pendingAction && pendingAction.agent === caller)`, and the throw only fires when the
 * action does NOT exist — where there is nothing to self-approve and `resolveActionRequired`
 * refuses anyway. The dead code was the truthiness test, never the ownership test. So this
 * is a contract fix, not a security fix, and the pin below claims only that.
 */
describe('loadActionRequired contract (pln#649)', () => {
  it('returns undefined for a missing id rather than throwing', () => {
    let result: unknown = 'not-called';
    assert.doesNotThrow(() => { result = loadActionRequired('act_does_not_exist', workspace.dir); });
    assert.equal(result, undefined, 'a missing action is a normal answer, not an exception');
  });

  it('still throws on an UNPARSEABLE record — absence and corruption are different facts', () => {
    const dir = path.join(workspace.dir, '.brainclaw', 'coordination', 'actions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'act_corrupt.json'), '{ not json', 'utf-8');
    // A bare try/catch would have downgraded this to "not found" — the silent downgrade
    // this codebase has already been burned by. `exists` + load keeps them distinct.
    assert.throws(() => loadActionRequired('act_corrupt', workspace.dir));
  });

  it('still returns a real action by id', () => {
    const created = createActionRequired({
      kind: 'approval', title: 'gate', prompt: 'ok?', agent: 'dispatcher', assignment_id: 'asgn_contract_pin',
    }, workspace.dir);
    assert.equal(loadActionRequired(created.id, workspace.dir)?.id, created.id);
  });
});
