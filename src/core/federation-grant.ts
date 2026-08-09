/**
 * Remise attestée d'une clé privée d'epoch. Le Cloud relaie ce manifeste et
 * son ciphertext sans pouvoir ouvrir l'un ou l'autre.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './federation-canonical.js';
import { HPKE_SUITE, open as hpkeOpen, seal, type SealedBlob } from './federation-hpke.js';
import { epochPublicKey, fingerprintKeyPem, loadDevicePrivateKey, loadEpochPrivateKey, storeEpochPrivateKey } from './federation-keyring.js';

export const EPOCH_GRANT_SCHEMA = 'brainclaw.federation-epoch-grant/v1' as const;
export const EPOCH_GRANT_KIND = 'epoch_grant' as const;
export const EPOCH_GRANT_AAD_PROTOCOL = 'brainclaw/federation-epoch-grant/aad/v1' as const;

const Aad = z.object({
  protocol: z.literal(EPOCH_GRANT_AAD_PROTOCOL),
  cloud_project_id: z.string().min(1),
  epoch: z.number().int().positive(),
  target_device_id: z.string().min(1),
  target_x25519_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  policy_revision: z.number().int().nonnegative(),
  grant_id: z.string().min(1),
}).strict();
const Sealed = z.object({
  alg: z.literal(HPKE_SUITE),
  enc: z.string().min(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
}).strict();
export const EpochGrantManifestSchema = z.object({
  schema: z.literal(EPOCH_GRANT_SCHEMA),
  kind: z.literal(EPOCH_GRANT_KIND),
  grant_id: z.string().min(1),
  cloud_project_id: z.string().min(1),
  epoch: z.number().int().positive(),
  policy_revision: z.number().int().nonnegative(),
  target: z.object({
    device_id: z.string().min(1),
    x25519_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  /** Le lecteur recompose cet AAD et le compare avant de déchiffrer. */
  aad: Aad,
  epoch_public_key_pem: z.string().min(1),
  epoch_public_key_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sealed: Sealed,
  custodian_sig: z.object({
    alg: z.literal('Ed25519'),
    key_id: z.string().min(1),
    value: z.string().min(1),
  }).strict(),
}).strict();
export type EpochGrantAad = z.infer<typeof Aad>;
export type EpochGrantManifest = z.infer<typeof EpochGrantManifestSchema>;

export interface AttestedGrantTarget {
  deviceId: string;
  x25519PublicKeyPem: string;
  x25519Fingerprint: string;
  active: boolean;
  attested: boolean;
  canRead: boolean;
  /** L'horizon est appliqué par l'émission explicite d'un manifest par epoch. */
  authorizedEpochs: readonly number[];
}
export interface BuildEpochGrantParams {
  cloudProjectId: string;
  epoch: number;
  grantId: string;
  policyRevision: number;
  custodian: { keyId: string; privateKeyPem: string; active: boolean };
  target: AttestedGrantTarget;
  home?: string;
}
export function epochGrantAad(params: {
  cloudProjectId: string;
  epoch: number;
  grantId: string;
  policyRevision: number;
  targetDeviceId: string;
  targetX25519Fingerprint: string;
}): EpochGrantAad {
  return {
    protocol: EPOCH_GRANT_AAD_PROTOCOL,
    cloud_project_id: params.cloudProjectId,
    epoch: params.epoch,
    target_device_id: params.targetDeviceId,
    target_x25519_fingerprint: params.targetX25519Fingerprint,
    policy_revision: params.policyRevision,
    grant_id: params.grantId,
  };
}
type Unsigned = Omit<EpochGrantManifest, 'custodian_sig'>;
export function epochGrantSigningInput(manifest: Unsigned): Buffer {
  return Buffer.concat([
    Buffer.from('brainclaw/federation-epoch-grant/v1\0', 'utf8'),
    Buffer.from(canonicalJson(manifest), 'utf8'),
  ]);
}
function unsigned(manifest: EpochGrantManifest): Unsigned {
  const { custodian_sig: _signature, ...value } = manifest;
  return value;
}
function publicX25519(pem: string): void {
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey(pem); } catch { throw new Error('Clé X25519 cible illisible.'); }
  if (key.asymmetricKeyType !== 'x25519') throw new Error('La cible doit fournir une clé X25519.');
}
function privateEd25519(pem: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(pem); } catch { throw new Error('Clé Ed25519 custodian illisible.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Le custodian doit signer en Ed25519.');
  return key;
}
function normalizedPem(pem: string): string { return pem.replace(/\r/g, '').trim(); }

export function buildEpochGrant(params: BuildEpochGrantParams): EpochGrantManifest {
  if (!params.custodian.active) throw new Error('Custodian inactif.');
  if (!params.target.active || !params.target.attested || !params.target.canRead) throw new Error('Cible non autorisée.');
  if (!params.target.authorizedEpochs.includes(params.epoch)) throw new Error('Epoch hors horizon autorisé.');
  if (!Number.isInteger(params.epoch) || params.epoch <= 0 || !Number.isInteger(params.policyRevision) || params.policyRevision < 0) {
    throw new Error('Epoch ou révision de politique invalide.');
  }
  if (!params.cloudProjectId || !params.grantId || !params.target.deviceId) throw new Error('Projet, grant_id ou cible absent.');
  publicX25519(params.target.x25519PublicKeyPem);
  const targetFingerprint = fingerprintKeyPem(params.target.x25519PublicKeyPem);
  if (targetFingerprint !== params.target.x25519Fingerprint) throw new Error('Empreinte cible différente de la clé attestée.');
  const epochPrivate = loadEpochPrivateKey(params.cloudProjectId, params.epoch, params.home);
  const announced = epochPublicKey(params.cloudProjectId, params.epoch, params.home);
  if (!epochPrivate || !announced) throw new Error('Custodian non détenteur de cet epoch.');
  const aad = epochGrantAad({
    cloudProjectId: params.cloudProjectId,
    epoch: params.epoch,
    grantId: params.grantId,
    policyRevision: params.policyRevision,
    targetDeviceId: params.target.deviceId,
    targetX25519Fingerprint: targetFingerprint,
  });
  const sealed = seal({
    recipientPublicKeyPem: params.target.x25519PublicKeyPem,
    plaintext: new TextEncoder().encode(epochPrivate.export({ type: 'pkcs8', format: 'pem' }).toString()),
    aadCanonicalBytes: new TextEncoder().encode(canonicalJson(aad)),
  });
  const value: Unsigned = {
    schema: EPOCH_GRANT_SCHEMA,
    kind: EPOCH_GRANT_KIND,
    grant_id: params.grantId,
    cloud_project_id: params.cloudProjectId,
    epoch: params.epoch,
    policy_revision: params.policyRevision,
    target: { device_id: params.target.deviceId, x25519_fingerprint: targetFingerprint },
    aad,
    epoch_public_key_pem: announced.public_key_pem,
    epoch_public_key_fingerprint: announced.fingerprint,
    sealed,
  };
  const signature = crypto.sign(null, epochGrantSigningInput(value), privateEd25519(params.custodian.privateKeyPem)).toString('base64url');
  return EpochGrantManifestSchema.parse({
    ...value,
    custodian_sig: { alg: 'Ed25519', key_id: params.custodian.keyId, value: signature },
  });
}

export type EpochGrantRejectionReason =
  | 'schema_invalid' | 'non_custodian' | 'bad_signature' | 'aad_mismatch' | 'target_mismatch'
  | 'recipient_key_unavailable' | 'undecryptable' | 'epoch_key_mismatch' | 'storage_refused';
export type EpochGrantAcceptance =
  | { ok: true; manifest: EpochGrantManifest }
  | { ok: false; reason: EpochGrantRejectionReason; detail: string };
function reject(reason: EpochGrantRejectionReason, detail: string): EpochGrantAcceptance {
  return { ok: false, reason, detail };
}
function signatureValid(manifest: EpochGrantManifest, signer: string): boolean {
  try {
    const key = crypto.createPublicKey(signer);
    return key.asymmetricKeyType === 'ed25519'
      && crypto.verify(null, epochGrantSigningInput(unsigned(manifest)), key, Buffer.from(manifest.custodian_sig.value, 'base64url'));
  } catch { return false; }
}

/**
 * La clé n'est écrite qu'après roster custodian, signature, AAD, cible, HPKE et
 * comparaison de la clé publique redérivée avec l'annonce signée.
 */
export function verifyAndStoreEpochGrant(params: {
  raw: unknown;
  recipientDeviceId: string;
  /** key_id -> PEM Ed25519 des seuls détenteurs ACTIFS de cet epoch. */
  activeCustodians: ReadonlyMap<string, string>;
  recipientPrivateKey?: crypto.KeyObject;
  home?: string;
}): EpochGrantAcceptance {
  const parsed = EpochGrantManifestSchema.safeParse(params.raw);
  if (!parsed.success) return reject('schema_invalid', parsed.error.issues.map((issue) => issue.message).join('; '));
  const manifest = parsed.data;
  const signer = params.activeCustodians.get(manifest.custodian_sig.key_id);
  if (!signer) return reject('non_custodian', 'Signataire absent des custodians actifs.');
  if (!signatureValid(manifest, signer)) return reject('bad_signature', 'Signature Ed25519 invalide.');
  const aad = epochGrantAad({
    cloudProjectId: manifest.cloud_project_id,
    epoch: manifest.epoch,
    grantId: manifest.grant_id,
    policyRevision: manifest.policy_revision,
    targetDeviceId: manifest.target.device_id,
    targetX25519Fingerprint: manifest.target.x25519_fingerprint,
  });
  if (canonicalJson(manifest.aad) !== canonicalJson(aad)) return reject('aad_mismatch', 'AAD différent des liaisons annoncées.');
  if (manifest.target.device_id !== params.recipientDeviceId) return reject('target_mismatch', 'Remise destinée à un autre appareil.');
  const recipient = params.recipientPrivateKey ?? loadDevicePrivateKey(params.recipientDeviceId, params.home);
  if (!recipient || recipient.asymmetricKeyType !== 'x25519') return reject('recipient_key_unavailable', 'Clé X25519 destinataire absente.');
  const recipientPublic = crypto.createPublicKey(recipient as unknown as crypto.PublicKeyInput).export({ type: 'spki', format: 'pem' }).toString();
  if (fingerprintKeyPem(recipientPublic) !== manifest.target.x25519_fingerprint) return reject('target_mismatch', 'Clé locale différente de la cible attestée.');
  const clear = hpkeOpen({
    recipientPrivateKey: recipient,
    sealed: manifest.sealed as SealedBlob,
    aadCanonicalBytes: new TextEncoder().encode(canonicalJson(aad)),
  });
  if (!clear) return reject('undecryptable', 'HPKE a refusé la remise.');
  let privatePem: string;
  let derivedPublic: string;
  try {
    privatePem = new TextDecoder().decode(clear);
    const epochPrivate = crypto.createPrivateKey(privatePem);
    if (epochPrivate.asymmetricKeyType !== 'x25519') throw new Error('non-X25519');
    derivedPublic = crypto.createPublicKey(epochPrivate as unknown as crypto.PublicKeyInput).export({ type: 'spki', format: 'pem' }).toString();
  } catch { return reject('epoch_key_mismatch', 'Clair d’epoch invalide.'); }
  if (
    normalizedPem(derivedPublic) !== normalizedPem(manifest.epoch_public_key_pem)
    || fingerprintKeyPem(derivedPublic) !== manifest.epoch_public_key_fingerprint
    || fingerprintKeyPem(manifest.epoch_public_key_pem) !== manifest.epoch_public_key_fingerprint
  ) return reject('epoch_key_mismatch', 'Clé publique redérivée différente de l’annonce.');
  try { storeEpochPrivateKey(manifest.cloud_project_id, manifest.epoch, privatePem, params.home); }
  catch (error) { return reject('storage_refused', error instanceof Error ? error.message : String(error)); }
  return { ok: true, manifest };
}

