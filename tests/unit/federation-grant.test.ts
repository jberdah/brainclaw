/**
 * Golden fixture and rejection proofs for an epoch_grant relay payload.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildEpochGrant,
  epochGrantAad,
  verifyAndStoreEpochGrant,
  type AttestedGrantTarget,
  type EpochGrantManifest,
} from '../../src/core/federation-grant.js';
import { epochPublicKey, fingerprintKeyPem, storeEpochPrivateKey } from '../../src/core/federation-keyring.js';

function temporaryHome(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-grant-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function pem(key: crypto.KeyObject, type: 'public' | 'private'): string {
  return type === 'public'
    ? key.export({ type: 'spki', format: 'pem' }).toString()
    : key.export({ type: 'pkcs8', format: 'pem' }).toString();
}
interface Fixture {
  manifest: EpochGrantManifest;
  target: AttestedGrantTarget;
  targetPrivate: crypto.KeyObject;
  signerPrivate: crypto.KeyObject;
  custodians: Map<string, string>;
}
function fixture(home: string): Fixture {
  const epoch = crypto.generateKeyPairSync('x25519');
  storeEpochPrivateKey('prj_grant', 7, pem(epoch.privateKey, 'private'), home);
  const recipient = crypto.generateKeyPairSync('x25519');
  const recipientPublic = pem(recipient.publicKey, 'public');
  const signer = crypto.generateKeyPairSync('ed25519');
  const target: AttestedGrantTarget = {
    deviceId: 'dev_reader_b',
    x25519PublicKeyPem: recipientPublic,
    x25519Fingerprint: fingerprintKeyPem(recipientPublic),
    active: true,
    attested: true,
    canRead: true,
    authorizedEpochs: [7],
  };
  return {
    manifest: buildEpochGrant({
      cloudProjectId: 'prj_grant',
      epoch: 7,
      grantId: 'grant_fixture_7',
      policyRevision: 11,
      custodian: { keyId: 'custodian_a', privateKeyPem: pem(signer.privateKey, 'private'), active: true },
      target,
      home,
    }),
    target,
    targetPrivate: recipient.privateKey,
    signerPrivate: signer.privateKey,
    custodians: new Map([['custodian_a', pem(signer.publicKey, 'public')]]),
  };
}

describe('epoch_grant — remise attestée', () => {
  it('golden fixture: AAD complet, signature et clé annoncée sont vérifiés avant rangement', () => {
    const grantor = temporaryHome();
    const receiver = temporaryHome();
    try {
      const { manifest, targetPrivate, custodians } = fixture(grantor.dir);
      assert.deepEqual(manifest.aad, epochGrantAad({
        cloudProjectId: 'prj_grant',
        epoch: 7,
        grantId: 'grant_fixture_7',
        policyRevision: 11,
        targetDeviceId: 'dev_reader_b',
        targetX25519Fingerprint: manifest.target.x25519_fingerprint,
      }));
      const result = verifyAndStoreEpochGrant({
        raw: manifest,
        recipientDeviceId: 'dev_reader_b',
        recipientPrivateKey: targetPrivate,
        activeCustodians: custodians,
        home: receiver.dir,
      });
      assert.equal(result.ok, true);
      assert.equal(epochPublicKey('prj_grant', 7, receiver.dir)?.fingerprint, manifest.epoch_public_key_fingerprint);
    } finally { grantor.cleanup(); receiver.cleanup(); }
  });

  it('refuse un AAD altéré sans écrire de clé', () => {
    const grantor = temporaryHome();
    const receiver = temporaryHome();
    try {
      const { manifest, targetPrivate, custodians } = fixture(grantor.dir);
      const result = verifyAndStoreEpochGrant({
        raw: { ...manifest, aad: { ...manifest.aad, policy_revision: 12 } },
        recipientDeviceId: 'dev_reader_b',
        recipientPrivateKey: targetPrivate,
        activeCustodians: custodians,
        home: receiver.dir,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'bad_signature');
      assert.equal(epochPublicKey('prj_grant', 7, receiver.dir), undefined);
    } finally { grantor.cleanup(); receiver.cleanup(); }
  });

  it('refuse un signataire non-custodian sans écrire de clé', () => {
    const grantor = temporaryHome();
    const receiver = temporaryHome();
    try {
      const { manifest, targetPrivate } = fixture(grantor.dir);
      const result = verifyAndStoreEpochGrant({
        raw: manifest,
        recipientDeviceId: 'dev_reader_b',
        recipientPrivateKey: targetPrivate,
        activeCustodians: new Map(),
        home: receiver.dir,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'non_custodian');
      assert.equal(epochPublicKey('prj_grant', 7, receiver.dir), undefined);
    } finally { grantor.cleanup(); receiver.cleanup(); }
  });

  it('refuse une cible substituée malgré une signature custodian valide', () => {
    const grantor = temporaryHome();
    const receiver = temporaryHome();
    try {
      const { target, signerPrivate, custodians } = fixture(grantor.dir);
      const other = crypto.generateKeyPairSync('x25519');
      const otherPublic = pem(other.publicKey, 'public');
      const substituted = buildEpochGrant({
        cloudProjectId: 'prj_grant',
        epoch: 7,
        grantId: 'grant_other_7',
        policyRevision: 11,
        custodian: { keyId: 'custodian_a', privateKeyPem: pem(signerPrivate, 'private'), active: true },
        target: {
          ...target,
          deviceId: 'dev_other',
          x25519PublicKeyPem: otherPublic,
          x25519Fingerprint: fingerprintKeyPem(otherPublic),
        },
        home: grantor.dir,
      });
      const result = verifyAndStoreEpochGrant({
        raw: substituted,
        recipientDeviceId: target.deviceId,
        recipientPrivateKey: other.privateKey,
        activeCustodians: custodians,
        home: receiver.dir,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'target_mismatch');
      assert.equal(epochPublicKey('prj_grant', 7, receiver.dir), undefined);
    } finally { grantor.cleanup(); receiver.cleanup(); }
  });
});

