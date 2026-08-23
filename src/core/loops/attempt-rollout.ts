import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { memoryDir, writeFileAtomic } from '../io.js';
import { nowISO } from '../ids.js';
import { fingerprintPublicKeyPem } from '../agent-registry.js';
import { AuthorityHomeSchema, type AuthorityHome } from './attempt-generations.js';

/**
 * Two-release activation guard for AttemptAuthority v2.
 *
 * Release A publishes one immutable membership guard and one independently
 * signed ACK per writer. ACKs are deliberately separate cells: writers may
 * prepare/sign/publish them in parallel without contending on a shared JSON
 * document. Release B is enabled by one immutable activation CAS only after all
 * non-revoked participants acknowledged the same guard digest.
 */

export const ATTEMPT_AUTHORITY_WRITER_VERSION = 2 as const;
export const ATTEMPT_AUTHORITY_READER_VERSION = 2 as const;
const ROLLOUT_SCHEMA_VERSION = 1 as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const AttemptWriterParticipantSchema = z.object({
  writer_id: z.string().regex(SAFE_ID),
  public_key_pem: z.string().min(1),
  key_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['active', 'revoked']).default('active'),
}).strict();
export type AttemptWriterParticipant = z.infer<typeof AttemptWriterParticipantSchema>;

export const AttemptRolloutGuardSchema = z.object({
  schema_version: z.literal(ROLLOUT_SCHEMA_VERSION),
  document_kind: z.literal('attempt_authority_writer_guard'),
  membership_epoch: z.number().int().positive(),
  minimum_writer_version: z.number().int().positive(),
  minimum_reader_version: z.number().int().positive(),
  authority_home: AuthorityHomeSchema,
  participants: z.array(AttemptWriterParticipantSchema).min(1),
  previous_activation_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  prepared_by: z.string().min(1),
  prepared_at: z.string().min(1),
}).strict();
export type AttemptRolloutGuard = z.infer<typeof AttemptRolloutGuardSchema>;

const AttemptRolloutAckUnsignedSchema = z.object({
  schema_version: z.literal(ROLLOUT_SCHEMA_VERSION),
  document_kind: z.literal('attempt_authority_writer_ack'),
  membership_epoch: z.number().int().positive(),
  writer_id: z.string().regex(SAFE_ID),
  writer_version: z.number().int().positive(),
  reader_version: z.number().int().positive(),
  guard_digest: z.string().regex(/^[a-f0-9]{64}$/),
  key_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledged_at: z.string().min(1),
}).strict();

export const AttemptRolloutAckSchema = AttemptRolloutAckUnsignedSchema.extend({
  signature: z.string().min(1),
}).strict();
export type AttemptRolloutAck = z.infer<typeof AttemptRolloutAckSchema>;

export const AttemptRolloutActivationSchema = z.object({
  schema_version: z.literal(ROLLOUT_SCHEMA_VERSION),
  document_kind: z.literal('attempt_authority_activation'),
  membership_epoch: z.number().int().positive(),
  guard_digest: z.string().regex(/^[a-f0-9]{64}$/),
  ack_digests: z.record(z.string().regex(SAFE_ID), z.string().regex(/^[a-f0-9]{64}$/)),
  authority_home: AuthorityHomeSchema,
  activated_by: z.string().min(1),
  activated_at: z.string().min(1),
}).strict();
export type AttemptRolloutActivation = z.infer<typeof AttemptRolloutActivationSchema>;

export class AttemptRolloutError extends Error {
  constructor(
    public readonly code:
      | 'not_prepared'
      | 'not_active'
      | 'participant_unknown'
      | 'writer_too_old'
      | 'bad_signature'
      | 'membership_mismatch'
      | 'authority_home_mismatch'
      | 'hardlink_unsupported'
      | 'corrupt_rollout_cell',
    message: string,
  ) {
    super(message);
    this.name = 'AttemptRolloutError';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function attemptRolloutGuardDigest(guard: AttemptRolloutGuard): string {
  return digest(AttemptRolloutGuardSchema.parse(guard));
}

export function attemptRolloutAckDigest(ack: AttemptRolloutAck): string {
  return digest(AttemptRolloutAckSchema.parse(ack));
}

export function attemptRolloutActivationDigest(activation: AttemptRolloutActivation): string {
  return digest(AttemptRolloutActivationSchema.parse(activation));
}

function rolloutRoot(cwd: string): string {
  return path.join(memoryDir(cwd), 'loops', 'attempt-authority-v2', 'rollout');
}

function epochDir(cwd: string, membershipEpoch: number): string {
  return path.join(rolloutRoot(cwd), `epoch-${membershipEpoch}`);
}

export function attemptRolloutGuardPath(cwd: string, membershipEpoch: number): string {
  return path.join(epochDir(cwd, membershipEpoch), 'guard.json');
}

export function attemptRolloutAckPath(cwd: string, membershipEpoch: number, writerId: string): string {
  if (!SAFE_ID.test(writerId)) throw new Error(`unsafe writer_id: ${writerId}`);
  return path.join(epochDir(cwd, membershipEpoch), 'acks', `${writerId}.json`);
}

export function attemptRolloutActivationPath(cwd: string, membershipEpoch: number): string {
  return path.join(epochDir(cwd, membershipEpoch), 'active.decision.json');
}

const HARDLINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EPERM', 'EACCES']);

function readCell<T>(filePath: string, schema: z.ZodType<T>): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return schema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    throw new AttemptRolloutError('corrupt_rollout_cell', `rollout cell is corrupt: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function publishCell<T>(filePath: string, value: T, schema: z.ZodType<T>): { won: boolean; cell: T } {
  const cell = schema.parse(value);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx');
  try {
    const bytes = Buffer.from(`${JSON.stringify(cell, null, 2)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, filePath);
    try { fs.unlinkSync(temp); } catch { /* orphan temp is non-authoritative */ }
    return { won: true, cell };
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const incumbent = readCell(filePath, schema);
      if (!incumbent) throw new AttemptRolloutError('corrupt_rollout_cell', `rollout incumbent vanished: ${filePath}`);
      return { won: false, cell: incumbent };
    }
    if (code && HARDLINK_UNSUPPORTED.has(code)) {
      throw new AttemptRolloutError('hardlink_unsupported', `filesystem cannot publish rollout cells with hardlink CAS (${code})`);
    }
    throw error;
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export interface PrepareAttemptRolloutInput {
  membership_epoch: number;
  minimum_writer_version?: number;
  minimum_reader_version?: number;
  authority_home: AuthorityHome;
  participants: AttemptWriterParticipant[];
  previous_activation_digest?: string;
  prepared_by: string;
  prepared_at?: string;
}

export function prepareAttemptAuthorityRollout(cwd: string, input: PrepareAttemptRolloutInput): AttemptRolloutGuard {
  const participants = input.participants.map((participant) => {
    const parsed = AttemptWriterParticipantSchema.parse(participant);
    if (fingerprintPublicKeyPem(parsed.public_key_pem) !== parsed.key_fingerprint) {
      throw new AttemptRolloutError('bad_signature', `public key fingerprint mismatch for ${parsed.writer_id}`);
    }
    return parsed;
  });
  if (new Set(participants.map((participant) => participant.writer_id)).size !== participants.length) {
    throw new AttemptRolloutError('membership_mismatch', 'rollout participants contain duplicate writer_id values');
  }
  const guard = AttemptRolloutGuardSchema.parse({
    schema_version: ROLLOUT_SCHEMA_VERSION,
    document_kind: 'attempt_authority_writer_guard',
    membership_epoch: input.membership_epoch,
    minimum_writer_version: input.minimum_writer_version ?? ATTEMPT_AUTHORITY_WRITER_VERSION,
    minimum_reader_version: input.minimum_reader_version ?? ATTEMPT_AUTHORITY_READER_VERSION,
    authority_home: input.authority_home,
    participants,
    previous_activation_digest: input.previous_activation_digest,
    prepared_by: input.prepared_by,
    prepared_at: input.prepared_at ?? nowISO(),
  });
  const current = resolveActiveAttemptRollout(cwd);
  if (current) {
    if (guard.membership_epoch <= current.guard.membership_epoch) {
      throw new AttemptRolloutError('membership_mismatch', 'new membership epoch must exceed the active epoch');
    }
    if (guard.previous_activation_digest !== attemptRolloutActivationDigest(current.activation)) {
      throw new AttemptRolloutError('membership_mismatch', 'new guard does not chain from the active rollout');
    }
    if (!same(guard.authority_home, current.guard.authority_home)) {
      throw new AttemptRolloutError('authority_home_mismatch', 'membership rollover cannot change authority_home without an explicit transfer protocol');
    }
  } else if (guard.membership_epoch !== 1 || guard.previous_activation_digest !== undefined) {
    throw new AttemptRolloutError('membership_mismatch', 'the first rollout guard must be membership epoch 1 without a predecessor');
  }
  const published = publishCell(attemptRolloutGuardPath(cwd, guard.membership_epoch), guard, AttemptRolloutGuardSchema);
  if (!same(published.cell, guard)) {
    throw new AttemptRolloutError('membership_mismatch', `a different guard already exists for epoch ${guard.membership_epoch}`);
  }
  return published.cell;
}

function ackSigningBytes(ack: z.infer<typeof AttemptRolloutAckUnsignedSchema>): Buffer {
  return Buffer.from(JSON.stringify(canonical(AttemptRolloutAckUnsignedSchema.parse(ack))), 'utf8');
}

export interface PublishAttemptRolloutAckInput {
  membership_epoch: number;
  writer_id: string;
  writer_version: number;
  reader_version?: number;
  private_key_pem: string;
  acknowledged_at?: string;
}

export function publishAttemptRolloutAck(cwd: string, input: PublishAttemptRolloutAckInput): AttemptRolloutAck {
  const guard = readCell(attemptRolloutGuardPath(cwd, input.membership_epoch), AttemptRolloutGuardSchema);
  if (!guard) throw new AttemptRolloutError('not_prepared', `rollout epoch ${input.membership_epoch} is not prepared`);
  const participant = guard.participants.find((candidate) => candidate.writer_id === input.writer_id && candidate.status === 'active');
  if (!participant) throw new AttemptRolloutError('participant_unknown', `writer ${input.writer_id} is not active in rollout epoch ${input.membership_epoch}`);
  if (input.writer_version < guard.minimum_writer_version) {
    throw new AttemptRolloutError('writer_too_old', `writer ${input.writer_id} version ${input.writer_version} < ${guard.minimum_writer_version}`);
  }
  const readerVersion = input.reader_version ?? ATTEMPT_AUTHORITY_READER_VERSION;
  if (readerVersion < guard.minimum_reader_version) {
    throw new AttemptRolloutError('writer_too_old', `writer ${input.writer_id} reader version ${readerVersion} < ${guard.minimum_reader_version}`);
  }
  const privateKey = crypto.createPrivateKey(input.private_key_pem);
  const publicKeyPem = crypto.createPublicKey(privateKey as unknown as crypto.PublicKeyInput).export({ type: 'spki', format: 'pem' }).toString();
  if (fingerprintPublicKeyPem(publicKeyPem) !== participant.key_fingerprint) {
    throw new AttemptRolloutError('bad_signature', `private key does not belong to writer ${input.writer_id}`);
  }
  const unsigned = AttemptRolloutAckUnsignedSchema.parse({
    schema_version: ROLLOUT_SCHEMA_VERSION,
    document_kind: 'attempt_authority_writer_ack',
    membership_epoch: guard.membership_epoch,
    writer_id: input.writer_id,
    writer_version: input.writer_version,
    reader_version: readerVersion,
    guard_digest: attemptRolloutGuardDigest(guard),
    key_fingerprint: participant.key_fingerprint,
    acknowledged_at: input.acknowledged_at ?? nowISO(),
  });
  const ack = AttemptRolloutAckSchema.parse({
    ...unsigned,
    signature: crypto.sign(null, ackSigningBytes(unsigned), privateKey).toString('base64url'),
  });
  const published = publishCell(attemptRolloutAckPath(cwd, guard.membership_epoch, input.writer_id), ack, AttemptRolloutAckSchema);
  if (!same(published.cell, ack)) {
    throw new AttemptRolloutError('membership_mismatch', `writer ${input.writer_id} already acknowledged with different bytes`);
  }
  return published.cell;
}

function verifyAck(guard: AttemptRolloutGuard, ack: AttemptRolloutAck): void {
  const participant = guard.participants.find((candidate) => candidate.writer_id === ack.writer_id && candidate.status === 'active');
  if (!participant) throw new AttemptRolloutError('participant_unknown', `ack writer ${ack.writer_id} is not active`);
  if (ack.membership_epoch !== guard.membership_epoch || ack.guard_digest !== attemptRolloutGuardDigest(guard)) {
    throw new AttemptRolloutError('membership_mismatch', `ack ${ack.writer_id} targets a different guard`);
  }
  if (ack.writer_version < guard.minimum_writer_version) {
    throw new AttemptRolloutError('writer_too_old', `ack ${ack.writer_id} advertises writer version ${ack.writer_version}`);
  }
  if (ack.reader_version < guard.minimum_reader_version) {
    throw new AttemptRolloutError('writer_too_old', `ack ${ack.writer_id} reader version ${ack.reader_version} < ${guard.minimum_reader_version}`);
  }
  const { signature, ...unsigned } = ack;
  const valid = crypto.verify(
    null,
    ackSigningBytes(AttemptRolloutAckUnsignedSchema.parse(unsigned)),
    crypto.createPublicKey(participant.public_key_pem),
    Buffer.from(signature, 'base64url'),
  );
  if (!valid || participant.key_fingerprint !== ack.key_fingerprint) {
    throw new AttemptRolloutError('bad_signature', `ack signature is invalid for ${ack.writer_id}`);
  }
}

export function activateAttemptAuthorityV2(
  cwd: string,
  membershipEpoch: number,
  activatedBy: string,
  activatedAt = nowISO(),
): AttemptRolloutActivation {
  const guard = readCell(attemptRolloutGuardPath(cwd, membershipEpoch), AttemptRolloutGuardSchema);
  if (!guard) throw new AttemptRolloutError('not_prepared', `rollout epoch ${membershipEpoch} is not prepared`);
  const ackDigests: Record<string, string> = {};
  for (const participant of guard.participants.filter((candidate) => candidate.status === 'active')) {
    const ack = readCell(attemptRolloutAckPath(cwd, membershipEpoch, participant.writer_id), AttemptRolloutAckSchema);
    if (!ack) throw new AttemptRolloutError('not_active', `writer ${participant.writer_id} has not acknowledged rollout epoch ${membershipEpoch}`);
    verifyAck(guard, ack);
    ackDigests[participant.writer_id] = attemptRolloutAckDigest(ack);
  }
  const activation = AttemptRolloutActivationSchema.parse({
    schema_version: ROLLOUT_SCHEMA_VERSION,
    document_kind: 'attempt_authority_activation',
    membership_epoch: membershipEpoch,
    guard_digest: attemptRolloutGuardDigest(guard),
    ack_digests: ackDigests,
    authority_home: guard.authority_home,
    activated_by: activatedBy,
    activated_at: activatedAt,
  });
  const published = publishCell(attemptRolloutActivationPath(cwd, membershipEpoch), activation, AttemptRolloutActivationSchema);
  if (!same(published.cell, activation)) {
    throw new AttemptRolloutError('membership_mismatch', `rollout epoch ${membershipEpoch} was activated with different acknowledgements`);
  }
  return published.cell;
}

export interface ActiveAttemptRollout {
  guard: AttemptRolloutGuard;
  activation: AttemptRolloutActivation;
}

export function resolveActiveAttemptRollout(cwd: string): ActiveAttemptRollout | undefined {
  const root = rolloutRoot(cwd);
  if (!fs.existsSync(root)) return undefined;
  const epochs = fs.readdirSync(root)
    .map((name) => /^epoch-(\d+)$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  let latest: ActiveAttemptRollout | undefined;
  for (const membershipEpoch of epochs) {
    const activation = readCell(attemptRolloutActivationPath(cwd, membershipEpoch), AttemptRolloutActivationSchema);
    if (!activation) continue;
    const guard = readCell(attemptRolloutGuardPath(cwd, membershipEpoch), AttemptRolloutGuardSchema);
    if (!guard || activation.guard_digest !== attemptRolloutGuardDigest(guard) || !same(activation.authority_home, guard.authority_home)) {
      throw new AttemptRolloutError('corrupt_rollout_cell', `activation/guard mismatch at epoch ${membershipEpoch}`);
    }
    if (!latest) {
      if (guard.membership_epoch !== 1 || guard.previous_activation_digest !== undefined) {
        throw new AttemptRolloutError('corrupt_rollout_cell', 'activation chain does not start at membership epoch 1');
      }
    } else {
      if (guard.previous_activation_digest !== attemptRolloutActivationDigest(latest.activation)) {
        throw new AttemptRolloutError('corrupt_rollout_cell', `activation epoch ${membershipEpoch} is not chained to its predecessor`);
      }
      if (!same(guard.authority_home, latest.guard.authority_home)) {
        throw new AttemptRolloutError('authority_home_mismatch', 'activation chain changes authority_home without transfer');
      }
    }
    for (const participant of guard.participants.filter((candidate) => candidate.status === 'active')) {
      const ack = readCell(attemptRolloutAckPath(cwd, membershipEpoch, participant.writer_id), AttemptRolloutAckSchema);
      if (!ack) throw new AttemptRolloutError('corrupt_rollout_cell', `activated writer ${participant.writer_id} has no ACK`);
      verifyAck(guard, ack);
      if (activation.ack_digests[participant.writer_id] !== attemptRolloutAckDigest(ack)) {
        throw new AttemptRolloutError('corrupt_rollout_cell', `activation ACK digest mismatch for ${participant.writer_id}`);
      }
    }
    latest = { guard, activation };
  }
  return latest;
}

export function assertAttemptAuthorityV2Writable(
  cwd: string,
  localAuthorityHome: AuthorityHome,
  writerVersion: number = ATTEMPT_AUTHORITY_WRITER_VERSION,
  writerId?: string,
  readerVersion: number = ATTEMPT_AUTHORITY_READER_VERSION,
): ActiveAttemptRollout {
  const active = resolveActiveAttemptRollout(cwd);
  if (!active) throw new AttemptRolloutError('not_active', 'AttemptAuthority v2 has no activated writer guard');
  if (writerVersion < active.guard.minimum_writer_version) {
    throw new AttemptRolloutError('writer_too_old', `writer version ${writerVersion} < ${active.guard.minimum_writer_version}`);
  }
  if (readerVersion < active.guard.minimum_reader_version) {
    throw new AttemptRolloutError('writer_too_old', `reader version ${readerVersion} < ${active.guard.minimum_reader_version}`);
  }
  const participant = writerId
    ? active.guard.participants.find((candidate) => candidate.writer_id === writerId && candidate.status === 'active')
    : undefined;
  if (!participant || active.activation.ack_digests[participant.writer_id] === undefined) {
    throw new AttemptRolloutError('participant_unknown', `writer ${writerId ?? '(missing)'} is not active in the activated membership`);
  }
  if (!same(AuthorityHomeSchema.parse(localAuthorityHome), active.guard.authority_home)) {
    throw new AttemptRolloutError('authority_home_mismatch', 'this store/device is not the activated authority_home');
  }
  return active;
}

export interface LocalAuthorityIdentityOptions {
  /** Test/portable override; defaults to the user-level Brainclaw registry. */
  identity_root?: string;
  /** Federation device id when paired; a random local device id otherwise. */
  device_id?: string;
}

function localIdentityPath(cwd: string, options: LocalAuthorityIdentityOptions = {}): string {
  const root = options.identity_root
    ?? process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT
    ?? path.join(os.homedir(), '.brainclaw', 'store-instances');
  let canonicalPath: string;
  try { canonicalPath = fs.realpathSync.native(cwd); } catch { canonicalPath = path.resolve(cwd); }
  const locator = crypto.createHash('sha256').update(process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath).digest('hex');
  return path.join(root, `${locator}.json`);
}

export function ensureLocalAuthorityHome(cwd: string, options: LocalAuthorityIdentityOptions = {}): AuthorityHome {
  const filePath = localIdentityPath(cwd, options);
  if (fs.existsSync(filePath)) {
    const existing = AuthorityHomeSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    if (options.device_id && existing.device_id !== options.device_id) {
      throw new AttemptRolloutError('authority_home_mismatch', `local authority identity is bound to ${existing.device_id}, not paired device ${options.device_id}`);
    }
    return existing;
  }
  const identity = AuthorityHomeSchema.parse({
    store_instance_id: `sti_${crypto.randomUUID()}`,
    device_id: options.device_id ?? `dev_${crypto.randomUUID()}`,
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

export function readLocalAuthorityHome(cwd: string, options: LocalAuthorityIdentityOptions = {}): AuthorityHome | undefined {
  const filePath = localIdentityPath(cwd, options);
  if (!fs.existsSync(filePath)) return undefined;
  return AuthorityHomeSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}
