import { loadAgentIdentity, loadAgentSigningKey } from '../core/agent-registry.js';
import { loadConnectionState } from '../core/federation-state.js';
import {
  ATTEMPT_AUTHORITY_WRITER_VERSION,
  activateAttemptAuthorityV2,
  attemptRolloutActivationDigest,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
  readLocalAuthorityHome,
  resolveActiveAttemptRollout,
  type AttemptWriterParticipant,
} from '../core/loops/attempt-rollout.js';

export interface AttemptAuthorityCommandOptions {
  cwd?: string;
  json?: boolean;
  membershipEpoch?: string | number;
  writers?: string[];
  agentId?: string;
  preparedBy?: string;
  activatedBy?: string;
}

function epoch(value: string | number | undefined, fallback = 1): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('membership epoch must be a positive integer');
  return parsed;
}

function print(value: unknown, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export function runAttemptAuthorityCommand(
  subcommand: string,
  options: AttemptAuthorityCommandOptions = {},
): void {
  const cwd = options.cwd ?? process.cwd();
  if (subcommand === 'status') {
    const active = resolveActiveAttemptRollout(cwd);
    print({
      writer_version: ATTEMPT_AUTHORITY_WRITER_VERSION,
      local_authority_home: readLocalAuthorityHome(cwd),
      active,
    }, options.json);
    return;
  }

  if (subcommand === 'prepare') {
    const writerIds = options.writers ?? [];
    if (writerIds.length === 0) throw new Error('prepare requires at least one --writers <agent_id>');
    const participants: AttemptWriterParticipant[] = writerIds.map((writerId) => {
      const identity = loadAgentIdentity(writerId, cwd);
      if (!identity.identity_key) {
        throw new Error(`agent ${writerId} has no Ed25519 identity key; re-register it before preparing rollout`);
      }
      return {
        writer_id: writerId,
        public_key_pem: identity.identity_key.public_key,
        key_fingerprint: identity.identity_key.fingerprint,
        status: 'active',
      };
    });
    const active = resolveActiveAttemptRollout(cwd);
    const membershipEpoch = epoch(options.membershipEpoch, (active?.guard.membership_epoch ?? 0) + 1);
    const connection = loadConnectionState(cwd);
    const home = ensureLocalAuthorityHome(cwd, { device_id: connection?.device.device_id });
    const guard = prepareAttemptAuthorityRollout(cwd, {
      membership_epoch: membershipEpoch,
      authority_home: home,
      participants,
      previous_activation_digest: active ? attemptRolloutActivationDigest(active.activation) : undefined,
      prepared_by: options.preparedBy ?? 'operator',
    });
    print(guard, options.json);
    return;
  }

  if (subcommand === 'ack') {
    const writerId = options.agentId;
    if (!writerId) throw new Error('ack requires --agent-id <agent_id>');
    const signing = loadAgentSigningKey(writerId);
    if (!signing) throw new Error(`no local Ed25519 signing key for ${writerId}`);
    const ack = publishAttemptRolloutAck(cwd, {
      membership_epoch: epoch(options.membershipEpoch),
      writer_id: writerId,
      writer_version: ATTEMPT_AUTHORITY_WRITER_VERSION,
      private_key_pem: signing.privateKeyPem,
    });
    print(ack, options.json);
    return;
  }

  if (subcommand === 'activate') {
    const activation = activateAttemptAuthorityV2(
      cwd,
      epoch(options.membershipEpoch),
      options.activatedBy ?? 'operator',
    );
    print(activation, options.json);
    return;
  }

  throw new Error(`unknown attempt-authority subcommand: ${subcommand}`);
}
