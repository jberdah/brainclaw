import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { integrateLaneResults } from '../../src/commands/harvest.js';
import { getLoop, listLoops } from '../../src/core/loops/store.js';
import { getRuntimeSignalPath } from '../../src/core/runtime-signals.js';
import { loadAssignment } from '../../src/core/assignments.js';
import { loadClaim } from '../../src/core/claims.js';
import { fingerprintPublicKeyPem, saveAgentIdentity } from '../../src/core/agent-registry.js';
import {
  activateAttemptAuthorityV2,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
} from '../../src/core/loops/attempt-rollout.js';
import { resolveTurnGenerationChain } from '../../src/core/loops/attempt-generations.js';
import { removeWorktree } from '../../src/core/worktree.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

type Envelope = {
  status: 'ok' | 'error';
  error?: string;
  result?: Record<string, unknown>;
  next_actions?: Array<{ tool: string; args: Record<string, unknown>; when?: string }>;
};

async function call(workspace: TestWorkspace, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const outcome = await executeMcpToolCall({
    name,
    args: { agent: workspace.currentAgent.agent_name, agentId: workspace.currentAgent.agent_id, ...args },
    cwd: workspace.dir,
  });
  return (outcome.response.structuredContent ?? outcome.response) as unknown as Envelope;
}

function assertOk(envelope: Envelope): asserts envelope is Envelope & { status: 'ok'; result: Record<string, unknown> } {
  assert.equal(envelope.status, 'ok', JSON.stringify(envelope));
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function actAs(identity: { agent_name: string; agent_id: string }): void {
  process.env.BRAINCLAW_AGENT_NAME = identity.agent_name;
  process.env.BRAINCLAW_AGENT = identity.agent_name;
  process.env.BRAINCLAW_AGENT_ID = identity.agent_id;
}

describe('ideation -> implementation -> review public pipeline', () => {
  let workspace: TestWorkspace;
  let previousNoSpawn: string | undefined;
  let laneWorktree: string | undefined;
  let codexAgent: { agent_name: string; agent_id: string };

  beforeEach(() => {
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-loop-pipeline-', currentAgent: 'claude-code' });
    saveAgentIdentity({ ...workspace.currentAgent, trust_level: 'trusted' }, workspace.dir);
    const codex = workspace.registerAgent('codex');
    codexAgent = codex;
    saveAgentIdentity({ ...codex, trust_level: 'trusted' }, workspace.dir);
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# pipeline fixture\n');
    git(workspace.dir, ['init']);
    git(workspace.dir, ['config', 'user.email', 'fixture@brainclaw.dev']);
    git(workspace.dir, ['config', 'user.name', 'Brainclaw Fixture']);
    git(workspace.dir, ['add', 'README.md']);
    if (fs.existsSync(path.join(workspace.dir, '.gitignore'))) git(workspace.dir, ['add', '.gitignore']);
    git(workspace.dir, ['commit', '-m', 'fixture']);
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const authorityHome = ensureLocalAuthorityHome(workspace.dir);
    prepareAttemptAuthorityRollout(workspace.dir, {
      membership_epoch: 1,
      authority_home: authorityHome,
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
  });

  afterEach(() => {
    delete process.env.BRAINCLAW_TEST_FAULT_CONTINUATION_AFTER_OPEN;
    if (laneWorktree && fs.existsSync(laneWorktree)) {
      removeWorktree(workspace.dir, laneWorktree, { force: true });
    }
    workspace.cleanup();
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('carries synthesis policy through real AttemptAuthority, lane verification, handoff, and review', async () => {
    const plan = await call(workspace, 'bclaw_create', {
      entity: 'plan', data: { text: 'Implement the pipeline sentinel', status: 'todo' },
      agent: 'claude-code',
    });
    const planId = (plan as unknown as { id: string }).id;
    assert.match(planId, /^pln_/);

    const sequence = await call(workspace, 'bclaw_create_sequence', {
      name: 'pipeline sequence', items: [{ planId, rank: 1, lane: 'pipeline', scope_hint: 'pipeline-sentinel.txt' }],
      agent: 'claude-code',
    });
    const sequenceId = (sequence as unknown as { sequence_id: string }).sequence_id;
    assert.match(sequenceId, /^seq_/);

    const ideationOpen = await call(workspace, 'bclaw_loop', {
      intent: 'open', kind: 'ideation', title: 'Final pipeline design', allow_orphan: true,
      phases: [{ name: 'synthesis' }],
      linked: { plan_ids: [planId], sequence_ids: [sequenceId] },
      agent: 'claude-code',
    });
    assertOk(ideationOpen);
    const ideationId = (ideationOpen.result?.loop as { id: string }).id;
    const verify = {
      command: [process.execPath, '-e', "process.exit(require('node:fs').existsSync('pipeline-sentinel.txt') ? 0 : 1)"],
      timeout_ms: 30_000,
    };
    const synthesis = await call(workspace, 'bclaw_loop', {
      intent: 'add_artifact', loop_id: ideationId, agent: 'claude-code',
      artifact: {
        phase: 'synthesis', type: 'plan_draft', body: 'Create and verify the pipeline sentinel.',
        addresses_critique: ['art_critique1'], implementation_verify: verify,
      },
    });
    assertOk(synthesis);
    const continuationAction = synthesis.next_actions?.[0];
    assert.equal(continuationAction?.tool, 'bclaw_loop');
    assert.equal(continuationAction?.args.intent, 'continue');
    assert.equal(continuationAction?.args.loop_id, ideationId);

    process.env.BRAINCLAW_TEST_FAULT_CONTINUATION_AFTER_OPEN = '1';
    const interrupted = await call(workspace, continuationAction!.tool, continuationAction!.args);
    delete process.env.BRAINCLAW_TEST_FAULT_CONTINUATION_AFTER_OPEN;
    assert.equal(interrupted.status, 'error');
    assert.match(interrupted.error ?? '', /fault_injection: continuation_after_open/);
    const createdBeforeRetry = listLoops({ kind: 'implementation' }, workspace.dir);
    assert.equal(createdBeforeRetry.length, 1, 'the public open committed before the simulated response loss');

    const continued = await call(workspace, continuationAction!.tool, continuationAction!.args);
    assertOk(continued);
    const implementationId = (continued.result?.loop as { id: string }).id;
    const continuation = continued.result?.continuation as {
      id: string; state: string; decision: string; downstream?: { id: string };
    };
    assert.match(continuation.id, /^ctn_/);
    assert.equal(continuation.decision, 'auto');
    assert.equal(continuation.state, 'applied');
    assert.equal(continuation.downstream?.id, implementationId);
    assert.equal(getLoop(implementationId, workspace.dir)?.linked?.source_loop_id, ideationId);
    assert.equal(getLoop(implementationId, workspace.dir)?.linked?.continuation_key?.length, 64);
    assert.deepEqual(getLoop(implementationId, workspace.dir)?.protocol?.verify, verify);

    const boundLoop = continued.result?.loop as { current_phase: string; slots: Array<{ slot_id: string; lane?: string; assignment_id?: string }> };
    assert.equal(boundLoop.current_phase, 'execute');
    assert.equal(boundLoop.slots[0]?.lane, 'pipeline');
    assert.equal(boundLoop.slots[0]?.assignment_id, undefined, 'bind is engine-only');
    assert.equal(continued.next_actions?.[0]?.args.intent, 'turn');
    assert.equal(continued.next_actions?.[0]?.args.dispatch, true);

    const replayed = await call(workspace, continuationAction!.tool, continuationAction!.args);
    assertOk(replayed);
    assert.equal((replayed.result?.loop as { id: string }).id, implementationId, 'retry reuses the same downstream loop');
    assert.equal((replayed.result?.continuation as { id: string }).id, continuation.id);

    const prematureVerify = await call(workspace, 'bclaw_loop', {
      intent: 'verify', loop_id: implementationId, slot_id: boundLoop.slots[0]!.slot_id, agent: 'claude-code',
    });
    assert.equal(prematureVerify.status, 'error');
    assert.match(prematureVerify.error ?? '', /has no assignment worktree/);

    const dispatched = await call(workspace, 'bclaw_loop', {
      intent: 'turn', loop_id: implementationId, slot_id: boundLoop.slots[0]!.slot_id,
      input: 'Create pipeline-sentinel.txt', dispatch: true, auto_execute: false,
      target_agents: ['codex'], agent: 'claude-code',
    });
    assertOk(dispatched);
    const attempt = dispatched.result?.dispatch as {
      assignment_id: string; turn_id: string; run_id: string; worktree_path: string;
      execution_status: string;
    };
    assert.equal(attempt.execution_status, 'command_ready_manual');
    laneWorktree = attempt.worktree_path;
    assert.ok(fs.existsSync(laneWorktree));
    assert.equal(loadAssignment(attempt.assignment_id, workspace.dir)?.id, attempt.assignment_id);
    assert.equal(getLoop(implementationId, workspace.dir)?.slots[0]?.assignment_id, attempt.assignment_id);
    const generation = resolveTurnGenerationChain(workspace.dir, attempt.turn_id)?.latest_generation;
    assert.ok(generation, 'AttemptAuthority v2 generation must exist');
    const contract = loadAssignment(attempt.assignment_id, workspace.dir)?.execution_contract_ref;
    assert.ok(contract, 'assignment must carry the immutable execution contract');

    const ackPath = getRuntimeSignalPath(workspace.dir, attempt.assignment_id, 'ack', attempt.run_id);
    fs.mkdirSync(path.dirname(ackPath), { recursive: true });
    fs.writeFileSync(ackPath, JSON.stringify({
      status: 'accepted', turn_id: attempt.turn_id, run_id: attempt.run_id, nonce: generation.launch_nonce,
      attempt_epoch: generation.attempt_epoch, workspace_digest: generation.workspace_digest,
      contract_hash: contract.hash,
      capability_snapshot_hash: contract.snapshot_hash,
      cwd: process.platform === 'win32'
        ? fs.realpathSync.native(generation.workspace_path).toLowerCase()
        : fs.realpathSync.native(generation.workspace_path),
    }));
    fs.writeFileSync(path.join(laneWorktree, 'pipeline-sentinel.txt'), 'pipeline green\n');
    fs.writeFileSync(path.join(laneWorktree, 'LANE-RESULT.json'), JSON.stringify({
      assignment_id: attempt.assignment_id, turn_id: attempt.turn_id, run_id: attempt.run_id,
      nonce: generation.launch_nonce, attempt_epoch: generation.attempt_epoch, workspace_digest: generation.workspace_digest,
      execution_contract_hash: contract.hash,
      capability_snapshot_hash: contract.snapshot_hash,
      status: 'completed', summary: 'Created the pipeline sentinel.',
      artifact_type: 'execute_report', body: 'Implementation complete and ready for verification.',
      files_changed: ['pipeline-sentinel.txt'],
    }));

    const integrated = integrateLaneResults({
      assignmentId: attempt.assignment_id, worktreePaths: [laneWorktree], cwd: workspace.dir, agent: 'claude-code',
    });
    assert.deepEqual(integrated.errors, []);
    assert.equal(integrated.integrated[0]?.assignment_completed, true, JSON.stringify(integrated));
    assert.equal(integrated.integrated[0]?.claim_released, true, JSON.stringify(integrated));
    assert.equal(loadClaim(loadAssignment(attempt.assignment_id, workspace.dir)!.claim_id, workspace.dir)?.status, 'released');
    assert.ok(getLoop(implementationId, workspace.dir)?.artifacts.some((artifact) => artifact.type === 'execute_report'));

    assert.equal(
      getLoop(implementationId, workspace.dir)?.current_phase,
      'verify',
      'turn reconciliation advances execute to the engine-owned verify phase',
    );
    const verified = await call(workspace, 'bclaw_loop', {
      intent: 'verify', loop_id: implementationId, slot_id: boundLoop.slots[0]!.slot_id, agent: 'claude-code',
    });
    assertOk(verified);
    assert.equal((verified.result?.verify_report as { passed?: boolean; cwd?: string }).passed, true);
    assert.equal(path.resolve((verified.result?.verify_report as { cwd: string }).cwd), path.resolve(laneWorktree));

    const handoffReady = await call(workspace, 'bclaw_loop', {
      intent: 'advance', loop_id: implementationId, agent: 'claude-code',
    });
    assertOk(handoffReady);
    assert.equal((handoffReady.result?.loop as { current_phase: string }).current_phase, 'handoff_ready');
    const handoff = await call(workspace, 'bclaw_loop', {
      intent: 'add_artifact', loop_id: implementationId, agent: 'claude-code',
      artifact: {
        phase: 'handoff_ready', type: 'handoff', body: 'Sentinel implementation verified green.',
        ref: { kind: 'commit', id: integrated.integrated[0]!.commit_sha! },
      },
    });
    assertOk(handoff);
    const reviewAction = handoff.next_actions?.[0];
    assert.equal(reviewAction?.tool, 'bclaw_coordinate');
    assert.equal((reviewAction?.args.linked as { source_loop_id?: string }).source_loop_id, implementationId);
    assert.equal(reviewAction?.args.ref, integrated.integrated[0]?.commit_sha);

    const reviewArgs = { ...reviewAction!.args, targetAgents: ['codex'], autoExecute: false, agent: 'claude-code' };
    const review = await call(workspace, reviewAction!.tool, reviewArgs);
    assertOk(review);
    const reviewId = review.result?.loop_id as string;
    assert.equal(getLoop(reviewId, workspace.dir)?.linked?.source_loop_id, implementationId);

    const reviewClosed = await call(workspace, 'bclaw_loop', {
      intent: 'close', loop_id: reviewId, status: 'cancelled', reason: 'deterministic pipeline test cleanup', agent: 'claude-code',
    });
    assertOk(reviewClosed);
    await call(workspace, 'bclaw_loop', { intent: 'close', loop_id: implementationId, status: 'completed', agent: 'claude-code' });
    await call(workspace, 'bclaw_loop', { intent: 'close', loop_id: ideationId, status: 'completed', agent: 'claude-code' });
  });

  it('persists approval and deny decisions and resumes the same continuation exactly once', async () => {
    const plan = await call(workspace, 'bclaw_create', {
      entity: 'plan', data: { text: 'Approval-gated implementation', status: 'todo' }, agent: 'claude-code',
    });
    const planId = (plan as unknown as { id: string }).id;
    const sequence = await call(workspace, 'bclaw_create_sequence', {
      name: 'approval sequence', items: [{ planId, rank: 1, lane: 'approval', scope_hint: 'approval.txt' }], agent: 'claude-code',
    });
    const sequenceId = (sequence as unknown as { sequence_id: string }).sequence_id;
    const opened = await call(workspace, 'bclaw_loop', {
      intent: 'open', kind: 'ideation', title: 'Approval design', allow_orphan: true,
      phases: [{ name: 'synthesis' }], linked: { plan_ids: [planId], sequence_ids: [sequenceId] }, agent: 'claude-code',
    });
    assertOk(opened);
    const ideationId = (opened.result.loop as { id: string }).id;
    const synthesis = await call(workspace, 'bclaw_loop', {
      intent: 'add_artifact', loop_id: ideationId, agent: 'claude-code',
      artifact: {
        phase: 'synthesis', type: 'plan_draft', body: 'Approval-gated plan.',
        addresses_critique: ['art_critique1'],
        implementation_verify: { command: [process.execPath, '-e', 'process.exit(0)'] },
      },
    });
    assertOk(synthesis);

    const gated = await call(workspace, 'bclaw_loop', {
      intent: 'continue', loop_id: ideationId, autonomy_mode: 'require_approval', risk: 'normal', agent: 'claude-code',
    });
    assertOk(gated);
    const continuation = gated.result.continuation as { id: string; state: string; action_required_id: string };
    const approval = gated.result.action_required as { id: string; target: { kind: string; continuation_id: string } };
    assert.equal(continuation.state, 'approval_required');
    assert.equal(approval.id, continuation.action_required_id);
    assert.deepEqual(approval.target, { kind: 'continuation', continuation_id: continuation.id });
    assert.equal(listLoops({ kind: 'implementation' }, workspace.dir).length, 0);

    actAs(codexAgent);
    const approvedOutcome = await executeMcpToolCall({
      name: 'bclaw_assignment_action', cwd: workspace.dir, connectionSessionId: 'sess_codex_approval',
      args: {
        action_id: approval.id, outcome: 'resolved', text: 'approved for deterministic test',
        agent: codexAgent.agent_name, agentId: codexAgent.agent_id,
      },
    });
    assert.notEqual(approvedOutcome.response.isError, true, JSON.stringify(approvedOutcome.response.structuredContent));
    const approved = approvedOutcome.response.structuredContent as {
      continuation_result: { continuation: { state: string; downstream: { id: string } } };
    };
    const resumed = approved.continuation_result as {
      continuation: { state: string; downstream: { id: string } };
    };
    assert.equal(resumed.continuation.state, 'applied');
    assert.equal(getLoop(resumed.continuation.downstream.id, workspace.dir)?.current_phase, 'execute');
    assert.equal(listLoops({ kind: 'implementation' }, workspace.dir).length, 1);

    const duplicateApproval = await executeMcpToolCall({
      name: 'bclaw_assignment_action', cwd: workspace.dir, connectionSessionId: 'sess_codex_approval',
      args: { action_id: approval.id, outcome: 'resolved', agent: codexAgent.agent_name, agentId: codexAgent.agent_id },
    });
    assert.notEqual(duplicateApproval.response.isError, true, JSON.stringify(duplicateApproval.response.structuredContent));
    const duplicateResult = duplicateApproval.response.structuredContent as {
      continuation_result: { continuation: { downstream: { id: string } } };
    };
    assert.equal(duplicateResult.continuation_result.continuation.downstream.id, resumed.continuation.downstream.id);
    assert.equal(listLoops({ kind: 'implementation' }, workspace.dir).length, 1);

    actAs(workspace.currentAgent);
    const denySource = await call(workspace, 'bclaw_loop', {
      intent: 'open', kind: 'ideation', title: 'Denied design', allow_orphan: true,
      phases: [{ name: 'synthesis' }], linked: { plan_ids: [planId], sequence_ids: [sequenceId] }, agent: 'claude-code',
    });
    assertOk(denySource);
    const denySourceId = (denySource.result.loop as { id: string }).id;
    const denyDraft = await call(workspace, 'bclaw_loop', {
      intent: 'add_artifact', loop_id: denySourceId, agent: 'claude-code',
      artifact: {
        phase: 'synthesis', type: 'plan_draft', body: 'Denied plan.', addresses_critique: ['art_critique2'],
        implementation_verify: { command: [process.execPath, '-e', 'process.exit(0)'] },
      },
    });
    assertOk(denyDraft);
    const denied = await call(workspace, 'bclaw_loop', {
      intent: 'continue', loop_id: denySourceId, autonomy_mode: 'deny', risk: 'normal', agent: 'claude-code',
    });
    assertOk(denied);
    assert.equal((denied.result.continuation as { state: string }).state, 'denied');
    assert.equal(listLoops({ kind: 'implementation' }, workspace.dir).length, 1, 'deny creates no downstream loop');
  });
});
