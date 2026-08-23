import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  activateAttemptAuthorityV2,
  assertAttemptAuthorityV2Writable,
  attemptRolloutAckPath,
  attemptRolloutActivationDigest,
  AttemptRolloutError,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
  readLocalAuthorityHome,
  resolveActiveAttemptRollout,
  type AttemptWriterParticipant,
} from '../../src/core/loops/attempt-rollout.js';
import { fingerprintPublicKeyPem } from '../../src/core/agent-registry.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainclaw-attempt-rollout-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.brainclaw'), { recursive: true });
  return root;
}

function writer(writerId: string): { participant: AttemptWriterParticipant; privateKeyPem: string } {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    participant: {
      writer_id: writerId,
      public_key_pem: publicKeyPem,
      key_fingerprint: fingerprintPublicKeyPem(publicKeyPem),
      status: 'active',
    },
    privateKeyPem,
  };
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('AttemptAuthority v2 two-release writer guard', () => {
  it('publishes independent signed writer ACKs then one activation cell', () => {
    const cwd = tempRoot();
    const alpha = writer('writer-alpha');
    const beta = writer('writer-beta');
    const home = { store_instance_id: 'sti_home', device_id: 'dev_home' };

    prepareAttemptAuthorityRollout(cwd, {
      membership_epoch: 1,
      authority_home: home,
      participants: [alpha.participant, beta.participant],
      prepared_by: 'operator',
    });
    publishAttemptRolloutAck(cwd, {
      membership_epoch: 1,
      writer_id: 'writer-alpha',
      writer_version: 2,
      private_key_pem: alpha.privateKeyPem,
    });
    assert.throws(
      () => activateAttemptAuthorityV2(cwd, 1, 'operator'),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'not_active',
    );
    publishAttemptRolloutAck(cwd, {
      membership_epoch: 1,
      writer_id: 'writer-beta',
      writer_version: 2,
      private_key_pem: beta.privateKeyPem,
    });

    const activation = activateAttemptAuthorityV2(cwd, 1, 'operator');
    assert.deepEqual(Object.keys(activation.ack_digests).sort(), ['writer-alpha', 'writer-beta']);
    assert.equal(resolveActiveAttemptRollout(cwd)?.guard.membership_epoch, 1);
    assert.equal(assertAttemptAuthorityV2Writable(cwd, home, 2, 'writer-alpha').activation.membership_epoch, 1);
    assert.throws(
      () => assertAttemptAuthorityV2Writable(cwd, home, 2, 'writer-unknown'),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'participant_unknown',
    );
    const betaAckPath = attemptRolloutAckPath(cwd, 1, 'writer-beta');
    const betaAck = JSON.parse(fs.readFileSync(betaAckPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(betaAckPath, JSON.stringify({ ...betaAck, signature: 'tampered-after-activation' }));
    assert.throws(
      () => resolveActiveAttemptRollout(cwd),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'bad_signature',
      'every active read revalidates the signed ACK chain',
    );
  });

  it('refuses old writers, foreign authority homes and tampered ACK signatures', () => {
    const cwd = tempRoot();
    const alpha = writer('writer-alpha');
    const home = { store_instance_id: 'sti_home', device_id: 'dev_home' };
    prepareAttemptAuthorityRollout(cwd, {
      membership_epoch: 1,
      authority_home: home,
      participants: [alpha.participant],
      prepared_by: 'operator',
    });
    assert.throws(
      () => publishAttemptRolloutAck(cwd, {
        membership_epoch: 1,
        writer_id: 'writer-alpha',
        writer_version: 1,
        private_key_pem: alpha.privateKeyPem,
      }),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'writer_too_old',
    );
    assert.throws(
      () => publishAttemptRolloutAck(cwd, {
        membership_epoch: 1,
        writer_id: 'writer-alpha',
        writer_version: 2,
        reader_version: 1,
        private_key_pem: alpha.privateKeyPem,
      }),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'writer_too_old',
    );
    const ack = publishAttemptRolloutAck(cwd, {
      membership_epoch: 1,
      writer_id: 'writer-alpha',
      writer_version: 2,
      private_key_pem: alpha.privateKeyPem,
    });
    fs.writeFileSync(attemptRolloutAckPath(cwd, 1, 'writer-alpha'), JSON.stringify({ ...ack, signature: 'tampered' }));
    assert.throws(
      () => activateAttemptAuthorityV2(cwd, 1, 'operator'),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'bad_signature',
    );

    fs.rmSync(path.join(cwd, '.brainclaw', 'loops', 'attempt-authority-v2'), { recursive: true, force: true });
    prepareAttemptAuthorityRollout(cwd, {
      membership_epoch: 1,
      authority_home: home,
      participants: [alpha.participant],
      prepared_by: 'operator',
    });
    publishAttemptRolloutAck(cwd, {
      membership_epoch: 1,
      writer_id: 'writer-alpha',
      writer_version: 2,
      private_key_pem: alpha.privateKeyPem,
    });
    activateAttemptAuthorityV2(cwd, 1, 'operator');
    assert.throws(
      () => assertAttemptAuthorityV2Writable(cwd, { ...home, device_id: 'dev_replica' }, 2, 'writer-alpha'),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'authority_home_mismatch',
    );
    assert.throws(
      () => assertAttemptAuthorityV2Writable(cwd, home, 1, 'writer-alpha'),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'writer_too_old',
    );
  });

  it('chains a new membership epoch so an offline writer can be explicitly revoked', () => {
    const cwd = tempRoot();
    const alpha = writer('writer-alpha');
    const beta = writer('writer-beta');
    const home = { store_instance_id: 'sti_home', device_id: 'dev_home' };
    prepareAttemptAuthorityRollout(cwd, {
      membership_epoch: 1,
      authority_home: home,
      participants: [alpha.participant, beta.participant],
      prepared_by: 'operator',
    });
    for (const [writerId, privateKeyPem] of [['writer-alpha', alpha.privateKeyPem], ['writer-beta', beta.privateKeyPem]] as const) {
      publishAttemptRolloutAck(cwd, { membership_epoch: 1, writer_id: writerId, writer_version: 2, private_key_pem: privateKeyPem });
    }
    const first = activateAttemptAuthorityV2(cwd, 1, 'operator');

    assert.throws(
      () => prepareAttemptAuthorityRollout(cwd, {
        membership_epoch: 2,
        authority_home: { ...home, device_id: 'dev_other' },
        participants: [alpha.participant],
        previous_activation_digest: attemptRolloutActivationDigest(first),
        prepared_by: 'operator',
      }),
      (error: unknown) => error instanceof AttemptRolloutError && error.code === 'authority_home_mismatch',
    );

    prepareAttemptAuthorityRollout(cwd, {
      membership_epoch: 2,
      authority_home: home,
      participants: [alpha.participant, { ...beta.participant, status: 'revoked' }],
      previous_activation_digest: attemptRolloutActivationDigest(first),
      prepared_by: 'operator',
    });
    publishAttemptRolloutAck(cwd, {
      membership_epoch: 2,
      writer_id: 'writer-alpha',
      writer_version: 2,
      private_key_pem: alpha.privateKeyPem,
    });
    activateAttemptAuthorityV2(cwd, 2, 'operator');
    assert.equal(resolveActiveAttemptRollout(cwd)?.guard.membership_epoch, 2);
  });

  it('keeps store_instance/device identity outside a copied project store', () => {
    const first = tempRoot();
    const second = tempRoot();
    const identityRoot = path.join(tempRoot(), 'identity-registry');
    const a = ensureLocalAuthorityHome(first, { identity_root: identityRoot });
    assert.deepEqual(readLocalAuthorityHome(first, { identity_root: identityRoot }), a);
    const b = ensureLocalAuthorityHome(second, { identity_root: identityRoot });
    assert.notEqual(a.store_instance_id, b.store_instance_id);
    assert.notEqual(a.device_id, b.device_id);
  });
});
