import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  AgentRunFencedError,
  loadAgentRun,
  recordAgentRunProgress,
} from '../../src/core/agentruns.js';
import { loadAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { fingerprintPublicKeyPem } from '../../src/core/agent-registry.js';
import { loadClaim, saveClaim } from '../../src/core/claims.js';
import { handleBclawAssignmentUpdate, handleBclawReleaseClaim, type McpWriteClaimsContext } from '../../src/commands/mcp-write-claims.js';
import { removeEntity, transitionEntity } from '../../src/core/entity-operations.js';
import { takeoverLoopAttempt } from '../../src/core/loops/attempt-takeover.js';
import { fenceForGeneration, readLaunchDecision, resolveTurnGenerationChain } from '../../src/core/loops/attempt-generations.js';
import { settleActiveAttemptGenerationV2 } from '../../src/core/loops/attempt-authority.js';
import {
  activateAttemptAuthorityV2,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
} from '../../src/core/loops/attempt-rollout.js';
import { reconcileTurn } from '../../src/core/loops/reconcile-turn.js';
import { getLoop, openLoop } from '../../src/core/loops/store.js';
import { evaluateGateCondition } from '../../src/core/loops/gate-policy.js';
import { prepareTurnExecution, type PrepareTurnExecutionInput } from '../../src/core/loops/turn-execution.js';
import { ensureRuntimeDirs, getRuntimeSignalPath } from '../../src/core/runtime-signals.js';
import type { LaneResult } from '../../src/core/schema.js';

function tempWorkspace(): { root: string; cwd: string; workspace0: string; workspace1: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-takeover-int-'));
  const cwd = path.join(root, 'authority');
  const workspace0 = path.join(root, 'workspace-0');
  const workspace1 = path.join(root, 'workspace-1');
  fs.mkdirSync(cwd);
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'brainclaw-test@example.invalid'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Brainclaw Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', 'seed.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'attempt-zero', workspace0], { cwd, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'attempt-one', workspace1], { cwd, stdio: 'ignore' });
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  return { root, cwd, workspace0, workspace1 };
}

describe('AttemptAuthority v2 takeover integration', () => {
  let cwd: string;
  let root: string;
  let workspace0: string;
  let workspace1: string;
  let priorIdentityRoot: string | undefined;

  beforeEach(() => {
    ({ root, cwd, workspace0, workspace1 } = tempWorkspace());
    priorIdentityRoot = process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
    process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = path.join(root, '.test-local-identities');
  });

  afterEach(() => {
    if (priorIdentityRoot === undefined) delete process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
    else process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = priorIdentityRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rotates Assignment/executor, fences epoch 0, crosses epoch 1 once and settles only full-fence evidence', async () => {
    const home = ensureLocalAuthorityHome(cwd);
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    prepareAttemptAuthorityRollout(cwd, {
      membership_epoch: 1,
      authority_home: home,
      participants: [{
        writer_id: 'coord',
        public_key_pem: publicKeyPem,
        key_fingerprint: fingerprintPublicKeyPem(publicKeyPem),
        status: 'active',
      }],
      prepared_by: 'coord',
    });
    publishAttemptRolloutAck(cwd, {
      membership_epoch: 1,
      writer_id: 'coord',
      writer_version: 2,
      private_key_pem: privateKeyPem,
    });
    activateAttemptAuthorityV2(cwd, 1, 'coord');

    const loop = openLoop({
      kind: 'review',
      title: 'takeover integration',
      created_by: 'coord',
      mode: 'symmetric',
      phases: [{ name: 'findings' }],
      stop_condition: { kind: 'reviewer_green' },
      slots: [{ role: 'reviewer', agent: 'codex', agent_id: 'agt_codex' }],
    }, cwd);
    const slotId = loop.slots[0]!.slot_id;
    const scope = `review-loop:${loop.id}`;
    saveClaim({
      schema_version: 2,
      id: 'clm_takeover',
      agent: 'codex',
      scope,
      description: 'takeover test',
      created_at: new Date().toISOString(),
      status: 'active',
    }, cwd);
    const input: PrepareTurnExecutionInput = {
      kind: 'review',
      loop_id: loop.id,
      slot_id: slotId,
      phase: 'findings',
      agent: 'codex',
      agent_id: 'agt_codex',
      claim_id: 'clm_takeover',
      dispatcher_agent: 'coord',
      scope,
      description: 'review the candidate',
      task: 'review',
      cwd,
      worktree_path: workspace0,
    };

    const first = prepareTurnExecution(input);
    assert.equal(first.kind, 'won');
    if (first.kind !== 'won') return;
    assert.equal(first.attempt_epoch, 0);
    assert.ok(first.execution_contract_ref);
    const updateCtx = {
      ensureTrust: () => ({ identity: { agent_name: 'codex', agent_id: 'agt_codex' } }),
    } as unknown as McpWriteClaimsContext;
    const generationUpdate = (turn: typeof first, status: 'accepted' | 'started' | 'progress' | 'completed') => ({
      name: 'bclaw_assignment_update',
      cwd,
      args: {
        assignment_id: turn.assignment_id,
        status,
        turn_id: turn.turn_id,
        run_id: turn.run_id,
        nonce: turn.nonce,
        attempt_epoch: turn.attempt_epoch,
        execution_contract_hash: turn.execution_contract_ref!.hash,
        workspace_digest: turn.workspace_digest,
      },
    });
    transitionAssignment(first.assignment_id, 'offered', { actor: 'coord' }, cwd);
    assert.ok(!(await handleBclawAssignmentUpdate(generationUpdate(first, 'accepted'), updateCtx)).response.isError);
    assert.ok(!(await handleBclawAssignmentUpdate(generationUpdate(first, 'started'), updateCtx)).response.isError);
    assert.equal(loadAssignment(first.assignment_id, cwd)?.status, 'started');
    assert.equal(loadAgentRun(first.run_id, cwd)?.status, 'running');
    saveClaim({
      schema_version: 2,
      id: 'clm_takeover_successor',
      agent: 'codex',
      scope,
      description: 'takeover successor',
      created_at: new Date().toISOString(),
      status: 'active',
    }, cwd);

    const takeoverInput = {
      loop_id: loop.id,
      slot_id: slotId,
      turn_id: first.turn_id,
      expected_epoch: 0,
      authority_home: home,
      actor: 'coord',
      writer_id: 'coord',
      cause: 'heartbeat and process evidence are stale',
      liveness_evidence: 'no heartbeat for 30m; wrapper exited',
      external_effect_policy: 'idempotent' as const,
      next_workspace_path: workspace1,
      next_executor: {
        agent: 'codex',
        agent_id: 'agt_codex',
        claim_id: 'clm_takeover_successor',
        capability_snapshot: first.capability_snapshot!,
      },
      cwd,
    };
    const taken = takeoverLoopAttempt(takeoverInput);
    assert.notEqual(taken.assignment_id, first.assignment_id, 'each generation owns a distinct Assignment');
    assert.notEqual(taken.run_id, first.run_id, 'physical AgentRun changes');
    assert.equal(taken.attempt_epoch, 1);
    assert.equal(loadAgentRun(first.run_id, cwd)?.status, 'interrupted');
    assert.equal(loadAgentRun(taken.run_id, cwd)?.attempt_index, 2);
    const replay = takeoverLoopAttempt(takeoverInput);
    assert.equal(replay.run_id, taken.run_id, 'takeover replay adopts the immutable successor');
    assert.equal(replay.won_close, false);

    assert.throws(
      () => recordAgentRunProgress(first.run_id, { message: 'late old-worker write' }, cwd),
      (error: unknown) => error instanceof AgentRunFencedError,
    );

    const staleLane: LaneResult = {
      assignment_id: first.assignment_id,
      turn_id: first.turn_id,
      run_id: first.run_id,
      nonce: first.nonce,
      attempt_epoch: 0,
      workspace_digest: first.workspace_digest,
      execution_contract_hash: first.execution_contract_ref!.hash,
      capability_snapshot_hash: first.execution_contract_ref!.snapshot_hash,
      status: 'completed',
      summary: 'stale generation completed late',
      review_verdict: 'approve',
    };
    const stale = reconcileTurn({ turn_id: first.turn_id, lane: staleLane, cwd });
    assert.equal(stale.reconciled, false);
    assert.match(stale.reason, /does not match|fence|generation/i);

    const second = prepareTurnExecution({
      ...input,
      claim_id: 'clm_takeover_successor',
      worktree_path: workspace1,
    });
    assert.equal(second.kind, 'won', second.kind === 'denied' ? second.reason : 'won');
    if (second.kind !== 'won') return;
    assert.equal(second.attempt_epoch, 1);
    assert.equal(second.assignment_id, taken.assignment_id);
    assert.equal(second.run_id, taken.run_id);
    assert.equal(prepareTurnExecution(input).kind, 'denied', 'launch(epoch 1) has one winner');
    transitionAssignment(second.assignment_id, 'offered', { actor: 'coord' }, cwd);

    const assignmentBeforeStaleUpdate = JSON.stringify(loadAssignment(second.assignment_id, cwd));
    const runBeforeStaleUpdate = JSON.stringify(loadAgentRun(second.run_id, cwd));
    const claimBeforeStaleUpdate = JSON.stringify(loadClaim('clm_takeover_successor', cwd));
    const staleUpdate = await handleBclawAssignmentUpdate({
      name: 'bclaw_assignment_update',
      cwd,
      args: {
        assignment_id: first.assignment_id,
        status: 'progress',
        turn_id: first.turn_id,
        run_id: first.run_id,
        nonce: first.nonce,
        attempt_epoch: first.attempt_epoch,
        execution_contract_hash: first.execution_contract_ref!.hash,
        workspace_digest: first.workspace_digest,
      },
    }, updateCtx);
    assert.equal(staleUpdate.response.isError, true);
    assert.equal(JSON.stringify(loadAssignment(second.assignment_id, cwd)), assignmentBeforeStaleUpdate);
    assert.equal(JSON.stringify(loadAgentRun(second.run_id, cwd)), runBeforeStaleUpdate);
    assert.equal(JSON.stringify(loadClaim('clm_takeover_successor', cwd)), claimBeforeStaleUpdate);
    assert.throws(
      () => transitionEntity('assignment', first.assignment_id, 'completed', cwd),
      /AttemptAuthority v2/,
    );
    assert.throws(
      () => removeEntity('assignment', first.assignment_id, cwd),
      /AttemptAuthority v2/,
    );
    const releaseCtx = {
      blockCrossProjectExecution: () => undefined,
      resolveMutationIdentity: () => ({
        identity: { agent_name: 'codex', agent_id: 'agt_codex', trust_level: 'contributor' },
      }),
    } as unknown as McpWriteClaimsContext;
    const staleRelease = await handleBclawReleaseClaim({
      name: 'bclaw_release_claim',
      cwd,
      args: {
        id: 'clm_takeover',
        turn_id: first.turn_id,
        run_id: first.run_id,
        nonce: first.nonce,
        attempt_epoch: first.attempt_epoch,
        execution_contract_hash: first.execution_contract_ref!.hash,
        workspace_digest: first.workspace_digest,
      },
    }, releaseCtx);
    assert.equal(staleRelease.response.isError, true);
    assert.equal(loadClaim('clm_takeover', cwd).status, 'active');
    assert.equal(loadClaim('clm_takeover_successor', cwd).status, 'active');
    const staleTrustedReleaseCtx = {
      blockCrossProjectExecution: () => undefined,
      resolveMutationIdentity: () => ({
        identity: { agent_name: 'codex', agent_id: 'agt_codex', trust_level: 'trusted' },
      }),
    } as unknown as McpWriteClaimsContext;
    const staleTrustedOverride = await handleBclawReleaseClaim({
      name: 'bclaw_release_claim',
      cwd,
      args: {
        id: 'clm_takeover',
        coordinator_override: true,
        turn_id: first.turn_id,
        run_id: first.run_id,
        nonce: first.nonce,
        attempt_epoch: first.attempt_epoch,
        execution_contract_hash: first.execution_contract_ref!.hash,
        workspace_digest: first.workspace_digest,
      },
    }, staleTrustedReleaseCtx);
    assert.equal(staleTrustedOverride.response.isError, true);
    assert.equal(loadClaim('clm_takeover', cwd).status, 'active');
    assert.equal(loadClaim('clm_takeover_successor', cwd).status, 'active');
    assert.throws(
      () => transitionEntity('claim', 'clm_takeover', 'released', cwd, undefined, {
        override: true,
        agent: 'codex',
        agent_id: 'agt_codex',
      }),
      /authenticated loop creator coord/,
    );
    assert.equal(loadClaim('clm_takeover', cwd).status, 'active');

    const currentAccepted = await handleBclawAssignmentUpdate(generationUpdate(second, 'accepted'), updateCtx);
    assert.ok(!currentAccepted.response.isError, JSON.stringify(currentAccepted.response.content));
    const currentStarted = await handleBclawAssignmentUpdate(generationUpdate(second, 'started'), updateCtx);
    assert.ok(!currentStarted.response.isError, JSON.stringify(currentStarted.response.content));
    assert.equal(loadAssignment(second.assignment_id, cwd)?.status, 'started');
    assert.equal(loadAgentRun(second.run_id, cwd)?.status, 'running');
    const prematureCompletion = await handleBclawAssignmentUpdate(generationUpdate(second, 'completed'), updateCtx);
    assert.equal(prematureCompletion.response.isError, true);
    assert.equal(loadAssignment(second.assignment_id, cwd)?.status, 'started');
    assert.equal(loadClaim('clm_takeover_successor', cwd).status, 'active');

    ensureRuntimeDirs(cwd);
    fs.writeFileSync(getRuntimeSignalPath(cwd, second.assignment_id, 'ack', second.run_id), JSON.stringify({
      status: 'accepted',
      turn_id: second.turn_id,
      run_id: second.run_id,
      nonce: second.nonce,
      contract_hash: second.execution_contract_ref!.hash,
      capability_snapshot_hash: second.execution_contract_ref!.snapshot_hash,
      attempt_epoch: second.attempt_epoch,
      workspace_digest: second.workspace_digest,
      cwd: process.platform === 'win32'
        ? fs.realpathSync.native(workspace1).toLowerCase()
        : fs.realpathSync.native(workspace1),
    }));

    const currentLane: LaneResult = {
      assignment_id: second.assignment_id,
      turn_id: second.turn_id,
      run_id: second.run_id,
      nonce: second.nonce,
      attempt_epoch: second.attempt_epoch,
      workspace_digest: second.workspace_digest,
      execution_contract_hash: second.execution_contract_ref!.hash,
      capability_snapshot_hash: second.execution_contract_ref!.snapshot_hash,
      status: 'completed',
      summary: 'current generation complete',
      review_verdict: 'approve',
    };
    const activeChain = resolveTurnGenerationChain(cwd, second.turn_id);
    assert.equal(activeChain?.status, 'active');
    const activeGeneration = activeChain!.latest_generation;
    const sealed = settleActiveAttemptGenerationV2(
      second.turn_id,
      fenceForGeneration(activeGeneration),
      currentLane,
      home,
      'coord',
      'coord',
      cwd,
    );
    assert.equal(sealed?.won, true, 'authoritative evidence is durable before mutable projections');

    const divergentReplay: LaneResult = {
      ...currentLane,
      summary: 'different narrative after settlement crash',
      review_verdict: 'request_changes',
    };
    const settled = reconcileTurn({ turn_id: second.turn_id, lane: divergentReplay, cwd });
    assert.equal(settled.reconciled, true, JSON.stringify(settled));
    assert.equal(resolveTurnGenerationChain(cwd, second.turn_id)?.status, 'settled');
    assert.equal(loadAgentRun(second.run_id, cwd)?.status, 'completed');
    const finalLoop = getLoop(loop.id, cwd);
    assert.equal(finalLoop?.status, 'completed', `sealed approve evidence wins over divergent replay: ${JSON.stringify({ settled, gate: finalLoop && evaluateGateCondition(finalLoop, finalLoop.stop_condition, cwd) })}`);
    assert.match(JSON.stringify(finalLoop?.artifacts), /accepted/);
    assert.doesNotMatch(JSON.stringify(finalLoop?.artifacts), /different narrative after settlement crash/);

    const cutoverLoop = openLoop({
      kind: 'review',
      title: 'cutover crash repair',
      created_by: 'coord',
      mode: 'symmetric',
      phases: [{ name: 'findings' }],
      stop_condition: { kind: 'reviewer_green' },
      slots: [{ role: 'reviewer', agent: 'codex', agent_id: 'agt_codex' }],
    }, cwd);
    saveClaim({
      schema_version: 2,
      id: 'clm_cutover_crash',
      agent: 'codex',
      scope: `review-loop:${cutoverLoop.id}`,
      description: 'cutover crash test',
      created_at: new Date().toISOString(),
      status: 'active',
    }, cwd);
    const cutoverInput: PrepareTurnExecutionInput = {
      ...input,
      loop_id: cutoverLoop.id,
      slot_id: cutoverLoop.slots[0]!.slot_id,
      claim_id: 'clm_cutover_crash',
      scope: `review-loop:${cutoverLoop.id}`,
      on_cutover_stage: (stage) => {
        if (stage === 'legacy_crossed') throw new Error('simulated crash after legacy crossing');
      },
    };
    const crashedCutover = prepareTurnExecution(cutoverInput);
    assert.equal(crashedCutover.kind, 'denied');
    const cutoverTurnId = crashedCutover.turn_id!;
    assert.equal(resolveTurnGenerationChain(cwd, cutoverTurnId), undefined);
    const repairedCutover = prepareTurnExecution({ ...cutoverInput, on_cutover_stage: undefined });
    assert.equal(repairedCutover.kind, 'denied');
    assert.match(repairedCutover.reason, /repaired v1→v2 cutover/);
    const repairedChain = resolveTurnGenerationChain(cwd, cutoverTurnId);
    assert.equal(repairedChain?.status, 'active');
    assert.equal(repairedChain?.latest_generation.attempt_epoch, 0);

    const anchorCrashLoop = openLoop({
      kind: 'review',
      title: 'anchor-to-launch crash repair',
      created_by: 'coord',
      mode: 'symmetric',
      phases: [{ name: 'findings' }],
      stop_condition: { kind: 'reviewer_green' },
      slots: [{ role: 'reviewer', agent: 'codex', agent_id: 'agt_codex' }],
    }, cwd);
    saveClaim({
      schema_version: 2,
      id: 'clm_anchor_crash',
      agent: 'codex',
      scope: `review-loop:${anchorCrashLoop.id}`,
      description: 'anchor crash test',
      created_at: new Date().toISOString(),
      status: 'active',
    }, cwd);
    const anchorCrashInput: PrepareTurnExecutionInput = {
      ...input,
      loop_id: anchorCrashLoop.id,
      slot_id: anchorCrashLoop.slots[0]!.slot_id,
      claim_id: 'clm_anchor_crash',
      scope: `review-loop:${anchorCrashLoop.id}`,
      on_cutover_stage: (stage) => {
        if (stage === 'initial_anchored') throw new Error('simulated crash between generation zero and launch zero');
      },
    };
    const anchorCrash = prepareTurnExecution(anchorCrashInput);
    assert.equal(anchorCrash.kind, 'denied');
    const anchorCrashTurnId = anchorCrash.turn_id!;
    assert.equal(resolveTurnGenerationChain(cwd, anchorCrashTurnId)?.latest_generation.attempt_epoch, 0);
    assert.equal(readLaunchDecision(cwd, anchorCrashTurnId, 0), undefined);
    const anchorRepair = prepareTurnExecution({ ...anchorCrashInput, on_cutover_stage: undefined });
    assert.equal(anchorRepair.kind, 'denied');
    assert.equal(readLaunchDecision(cwd, anchorCrashTurnId, 0)?.decision, 'crossed');

  });
});
