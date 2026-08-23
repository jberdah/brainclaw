import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { handleBclawLoop } from '../../src/commands/loops-handlers.js';
import { runLoopCommand } from '../../src/commands/loop.js';
import { fingerprintPublicKeyPem } from '../../src/core/agent-registry.js';
import { saveClaim } from '../../src/core/claims.js';
import { takeoverLoopAttempt } from '../../src/core/loops/attempt-takeover.js';
import {
  activateAttemptAuthorityV2,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
} from '../../src/core/loops/attempt-rollout.js';
import { getLoop, listLoopEvents, openLoop } from '../../src/core/loops/store.js';
import { prepareTurnExecution, type PrepareTurnExecutionInput } from '../../src/core/loops/turn-execution.js';

function tempWorkspace(): { root: string; cwd: string; workspace0: string; workspace1: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-complete-fence-'));
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

function activateV2(cwd: string): void {
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
}

describe('complete_turn AttemptAuthority fence', () => {
  let root: string;
  let cwd: string;
  let workspace0: string;
  let workspace1: string;
  let priorIdentityRoot: string | undefined;
  let priorClaimId: string | undefined;

  beforeEach(() => {
    ({ root, cwd, workspace0, workspace1 } = tempWorkspace());
    priorIdentityRoot = process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
    priorClaimId = process.env.BRAINCLAW_CLAIM_ID;
    process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = path.join(root, '.test-local-identities');
    process.env.BRAINCLAW_CLAIM_ID = 'clm_takeover';
  });

  afterEach(() => {
    if (priorIdentityRoot === undefined) delete process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
    else process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = priorIdentityRoot;
    if (priorClaimId === undefined) delete process.env.BRAINCLAW_CLAIM_ID;
    else process.env.BRAINCLAW_CLAIM_ID = priorClaimId;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects epoch 0 after takeover without loop mutation, then accepts epoch 1', async () => {
    activateV2(cwd);
    const loop = openLoop({
      kind: 'review',
      title: 'complete turn takeover fence',
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
      description: 'complete_turn takeover fence test',
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

    const epoch0 = prepareTurnExecution(input);
    assert.equal(epoch0.kind, 'won');
    if (epoch0.kind !== 'won') return;
    assert.equal(epoch0.attempt_epoch, 0);
    assert.ok(epoch0.execution_contract_ref);
    assert.ok(epoch0.workspace_digest);

    const home = ensureLocalAuthorityHome(cwd);
    takeoverLoopAttempt({
      loop_id: loop.id,
      slot_id: slotId,
      turn_id: epoch0.turn_id,
      expected_epoch: 0,
      authority_home: home,
      actor: 'coord',
      writer_id: 'coord',
      cause: 'epoch 0 worker is stale',
      liveness_evidence: 'worker heartbeat expired',
      external_effect_policy: 'idempotent',
      next_workspace_path: workspace1,
      cwd,
    });

    const epoch1 = prepareTurnExecution(input);
    assert.equal(epoch1.kind, 'won');
    if (epoch1.kind !== 'won') return;
    assert.equal(epoch1.attempt_epoch, 1);
    assert.ok(epoch1.execution_contract_ref);
    assert.ok(epoch1.workspace_digest);

    const loopBeforeStale = JSON.stringify(getLoop(loop.id, cwd));
    const eventsBeforeStale = JSON.stringify(listLoopEvents(loop.id, cwd));
    const stale = await handleBclawLoop({
      cwd,
      args: {
        intent: 'complete_turn',
        loop_id: loop.id,
        slot_id: slotId,
        assignment_id: epoch0.assignment_id,
        turn_id: epoch0.turn_id,
        run_id: epoch0.run_id,
        nonce: epoch0.nonce,
        attempt_epoch: epoch0.attempt_epoch,
        execution_contract_hash: epoch0.execution_contract_ref.hash,
        workspace_digest: epoch0.workspace_digest,
        outcome: 'done',
        artifact: { phase: 'findings', type: 'verdict', body: 'accepted: stale epoch' },
        agent: 'codex',
        agentId: 'agt_codex',
      },
    });
    assert.equal(stale.response.status, 'error');
    assert.match(stale.response.error ?? '', /^attempt_fence_rejected: attempt_fence_stale/);
    assert.equal(JSON.stringify(getLoop(loop.id, cwd)), loopBeforeStale);
    assert.equal(JSON.stringify(listLoopEvents(loop.id, cwd)), eventsBeforeStale);

    const current = await runLoopCommand('complete-turn', { loop_id: loop.id }, {
      slot: slotId,
      assignmentId: epoch1.assignment_id,
      turnId: epoch1.turn_id,
      runId: epoch1.run_id,
      nonce: epoch1.nonce,
      attemptEpoch: epoch1.attempt_epoch,
      executionContractHash: epoch1.execution_contract_ref.hash,
      workspaceDigest: epoch1.workspace_digest,
      outcome: 'done',
      artifact: JSON.stringify({ phase: 'findings', type: 'verdict', body: 'accepted: current epoch' }),
    }, cwd);
    assert.equal(current.ok, true);
    const completed = getLoop(loop.id, cwd)!;
    assert.equal(completed.slots.find((slot) => slot.slot_id === slotId)?.status, 'done');
    const verdict = completed.artifacts.find((artifact) => artifact.body === 'accepted: current epoch');
    assert.equal(verdict?.evidence?.subject.assignment_id, epoch1.assignment_id);
    assert.equal(verdict?.evidence?.subject.turn_id, epoch1.turn_id);
    assert.equal(verdict?.evidence?.subject.run_id, epoch1.run_id);
    assert.equal(verdict?.evidence?.subject.attempt_epoch, 1);
    assert.equal(verdict?.evidence?.subject.execution_contract_hash, epoch1.execution_contract_ref.hash);
    assert.equal(verdict?.evidence?.subject.workspace_digest, epoch1.workspace_digest);
  });

  it('keeps complete_turn without an attempt fence compatible for a legacy slot', async () => {
    const loop = openLoop({
      kind: 'review',
      title: 'legacy complete turn',
      created_by: 'coord',
      mode: 'symmetric',
      phases: [{ name: 'findings' }],
      stop_condition: { kind: 'reviewer_green' },
      slots: [{ role: 'reviewer', agent: 'codex', agent_id: 'agt_codex' }],
    }, cwd);
    const result = await handleBclawLoop({
      cwd,
      args: {
        intent: 'complete_turn',
        loop_id: loop.id,
        slot_id: loop.slots[0]!.slot_id,
        outcome: 'done',
        agent: 'coord',
        agentId: 'coord',
      },
    });
    assert.equal(result.response.status, 'ok');
    assert.equal(getLoop(loop.id, cwd)!.slots[0]!.status, 'done');
  });
});
