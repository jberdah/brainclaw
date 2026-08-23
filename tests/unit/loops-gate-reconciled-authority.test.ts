import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { fingerprintPublicKeyPem } from '../../src/core/agent-registry.js';
import { saveClaim } from '../../src/core/claims.js';
import {
  activateAttemptAuthorityV2,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
} from '../../src/core/loops/attempt-rollout.js';
import { sealArtifactEvidence } from '../../src/core/loops/evidence.js';
import { evaluateGateCondition, GATE_POLICIES } from '../../src/core/loops/gate-policy.js';
import { getLoop, openLoop, writeThreadFile } from '../../src/core/loops/store.js';
import { prepareTurnExecution, type PrepareTurnExecutionInput } from '../../src/core/loops/turn-execution.js';
import type { LoopArtifact } from '../../src/core/loops/types.js';
import { advance } from '../../src/core/loops/verbs.js';

function tempWorkspace(): { root: string; cwd: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gate-authority-'));
  const cwd = path.join(root, 'authority');
  const worktree = path.join(root, 'worker');
  fs.mkdirSync(cwd);
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', 'seed.txt'], { cwd });
  execFileSync('git', [
    '-c', 'user.email=brainclaw-test@example.invalid',
    '-c', 'user.name=Brainclaw Test',
    'commit', '-m', 'seed',
  ], { cwd, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'worker', worktree], { cwd, stdio: 'ignore' });
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  return { root, cwd, worktree };
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

describe('reconciled evidence gate authority', () => {
  let root: string;
  let cwd: string;
  let worktree: string;
  let priorIdentityRoot: string | undefined;

  beforeEach(() => {
    ({ root, cwd, worktree } = tempWorkspace());
    priorIdentityRoot = process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
    process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = path.join(root, '.test-local-identities');
  });

  afterEach(() => {
    if (priorIdentityRoot === undefined) delete process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
    else process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = priorIdentityRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('opens a gate only for the exact current AttemptAuthority v2 tuple', () => {
    activateV2(cwd);
    const opened = openLoop({
      kind: 'review',
      title: 'reconciled gate authority',
      created_by: 'coord',
      mode: 'symmetric',
      phases: [{ name: 'findings' }],
      stop_condition: { kind: 'reviewer_green' },
      slots: [{ role: 'reviewer', agent: 'codex', agent_id: 'agt_codex' }],
    }, cwd);
    const slotId = opened.slots[0]!.slot_id;
    const scope = `review-loop:${opened.id}`;
    saveClaim({
      schema_version: 2,
      id: 'clm_gate_authority',
      agent: 'codex',
      scope,
      description: 'gate authority test',
      created_at: new Date().toISOString(),
      status: 'active',
    }, cwd);
    const input: PrepareTurnExecutionInput = {
      kind: 'review',
      loop_id: opened.id,
      slot_id: slotId,
      phase: 'findings',
      agent: 'codex',
      agent_id: 'agt_codex',
      claim_id: 'clm_gate_authority',
      dispatcher_agent: 'coord',
      scope,
      description: 'review',
      task: 'review',
      cwd,
      worktree_path: worktree,
    };
    const attempt = prepareTurnExecution(input);
    assert.equal(attempt.kind, 'won');
    if (attempt.kind !== 'won') return;
    assert.ok(attempt.execution_contract_ref);
    assert.ok(attempt.workspace_digest);

    const loop = getLoop(opened.id, cwd)!;
    const slot = loop.slots.find((candidate) => candidate.slot_id === slotId)!;
    const base: Omit<LoopArtifact, 'evidence'> = {
      artifact_id: 'art_current_authority',
      phase: 'findings',
      type: 'verdict',
      body: 'accepted: authoritative generation',
      produced_by: 'codex',
      produced_at: loop.updated_at,
      iteration: loop.iteration_count,
    };
    const context = {
      channel: 'reconcile_turn' as const,
      producer_kind: 'slot' as const,
      producer_id: 'codex',
      agent_id: 'agt_codex',
      slot_id: slot.slot_id,
      slot_role: slot.role,
      turn_id: attempt.turn_id,
      assignment_id: attempt.assignment_id,
      claim_id: 'clm_gate_authority',
      run_id: attempt.run_id,
      nonce: attempt.nonce,
      attempt_epoch: attempt.attempt_epoch,
      execution_contract_hash: attempt.execution_contract_ref.hash,
      workspace_digest: attempt.workspace_digest,
    };
    const exact = sealArtifactEvidence(loop, base, context);
    const exactDecision = evaluateGateCondition(
      { ...loop, artifacts: [exact] },
      { kind: 'reviewer_green' },
      cwd,
    );
    assert.equal(exactDecision.passed, true);

    const mismatches = [
      ['turn_id', { turn_id: 'tat_wrong' }, /wrong_subject_turn/],
      ['assignment_id', { assignment_id: 'asgn_wrong' }, /wrong_subject_assignment/],
      ['run_id', { run_id: 'run_wrong' }, /reconciled_authority_mismatch:run_id/],
      ['nonce_digest', { nonce: 'nonce_wrong' }, /reconciled_authority_mismatch:nonce_digest/],
      ['attempt_epoch', { attempt_epoch: (attempt.attempt_epoch ?? 0) + 1 }, /reconciled_authority_mismatch:attempt_epoch/],
      ['execution_contract_hash', { execution_contract_hash: 'a'.repeat(64) }, /reconciled_authority_mismatch:execution_contract_hash/],
      ['workspace_digest', { workspace_digest: 'b'.repeat(64) }, /reconciled_authority_mismatch:workspace_digest/],
    ] as const;
    for (const [field, override, expectedReason] of mismatches) {
      const forged = sealArtifactEvidence(
        loop,
        { ...base, artifact_id: `art_wrong_${field}` },
        { ...context, ...override },
      );
      const decision = evaluateGateCondition(
        { ...loop, artifacts: [forged] },
        { kind: 'reviewer_green' },
        cwd,
      );
      assert.equal(decision.passed, false, `${field} mismatch must not open the gate`);
      assert.match(decision.rejected[0]?.reason ?? '', expectedReason);
    }

    // Production proof: advance reloads the thread from a cwd distinct from
    // process.cwd(). An arbitrary but well-formed contract hash must not close
    // the real loop; restoring exact authority must auto-close it.
    const arbitraryHash = sealArtifactEvidence(
      loop,
      { ...base, artifact_id: 'art_arbitrary_hash' },
      { ...context, execution_contract_hash: 'a'.repeat(64) },
    );
    writeThreadFile({ ...loop, artifacts: [arbitraryHash] }, cwd);
    assert.throws(
      () => advance({ id: loop.id, actor: 'coord' }, cwd),
      /already at last phase/,
      'a forged reconciled hash must leave reviewer_green closed',
    );
    assert.equal(getLoop(loop.id, cwd)!.status, 'open');

    writeThreadFile({ ...loop, artifacts: [exact] }, cwd);
    const closed = advance({ id: loop.id, actor: 'coord' }, cwd);
    assert.equal(closed.auto_closed, true);
    assert.equal(closed.loop.status, 'completed');
  });

  it('keeps specialized gate authorities fail-closed outside their loop kind', () => {
    const expected = {
      review: { artifact: true, reviewer_green: true, command_green: false, critic_signal: false },
      ideation: { artifact: true, reviewer_green: false, command_green: false, critic_signal: true },
      implementation: { artifact: true, reviewer_green: false, command_green: true, critic_signal: false },
      research: { artifact: true, reviewer_green: false, command_green: false, critic_signal: true },
      debug: { artifact: true, reviewer_green: false, command_green: true, critic_signal: false },
    } as const;
    for (const [kind, purposes] of Object.entries(expected)) {
      for (const [purpose, allowed] of Object.entries(purposes)) {
        assert.equal(
          GATE_POLICIES[kind as keyof typeof GATE_POLICIES]
            .requirements[purpose as keyof typeof purposes].authorities.length > 0,
          allowed,
          `${kind}.${purpose}`,
        );
      }
    }
  });
});
