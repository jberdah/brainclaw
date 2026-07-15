/**
 * Ed25519 request signing for the Brainclaw Cloud federation bridge (pln#100).
 *
 * The cloud verifier (brainclaw-cloud/src/middleware/signature.ts) expects three
 * headers on a signed runtime write:
 *   X-Agent-Id:        the cloud agent id whose public_key_pem is stored in D1
 *   X-Agent-Signature: base64 Ed25519 signature over (body + timestamp)
 *   X-Agent-Timestamp: ISO-8601 timestamp (5-minute replay window)
 *
 * The signing key is the agent's local Ed25519 private key managed by
 * agent-registry (~/.brainclaw/keys/<id>.ed25519.pem). Its SPKI public-key PEM
 * is what gets registered with the cloud, and sha256(pem) is the fingerprint
 * both sides compute — so a local↔remote fingerprint match proves the same key.
 *
 * @module
 */
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { loadAgentSigningKey, resolveRegisteredAgentIdentity } from './agent-registry.js';
import { logger } from './logger.js';

export const AGENT_ID_HEADER = 'X-Agent-Id';
export const AGENT_SIGNATURE_HEADER = 'X-Agent-Signature';
export const AGENT_TIMESTAMP_HEADER = 'X-Agent-Timestamp';

export interface CloudSigningIdentity {
  /** Value sent as X-Agent-Id — the cloud's agent id (falls back to the local id when self-hosted). */
  cloudAgentId: string;
  /** Local brainclaw identity id backing the private key. */
  localAgentId: string;
  agentName: string;
  privateKeyPem: string;
  publicKeyPem: string;
  fingerprint: string;
}

/**
 * Sign a request body with an Ed25519 private key, producing the cloud's
 * signature headers. The signed message is exactly `body + timestamp` (UTF-8),
 * mirroring the verifier. Node signs Ed25519 with a null algorithm.
 */
export function signCloudBody(
  body: string,
  params: { agentId: string; privateKeyPem: string; timestamp?: string },
): Record<string, string> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const privateKey = crypto.createPrivateKey(params.privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(body + timestamp, 'utf-8'), privateKey);
  return {
    [AGENT_ID_HEADER]: params.agentId,
    [AGENT_SIGNATURE_HEADER]: signature.toString('base64'),
    [AGENT_TIMESTAMP_HEADER]: timestamp,
  };
}

/**
 * Build the outgoing header set for a cloud runtime write.
 *
 * - Always includes Content-Type + X-API-Key.
 * - Adds the Ed25519 signature headers when a signing identity is available.
 * - Returns `undefined` (fail-closed) when `requireSigned` is set but no signing
 *   identity is available — the caller MUST NOT send the request in that case.
 *
 * Pure and dependency-injected (no filesystem/network) so it is unit-testable.
 */
export function buildCloudWriteHeaders(
  body: string,
  opts: {
    apiKey: string;
    signing?: Pick<CloudSigningIdentity, 'cloudAgentId' | 'privateKeyPem'> | null;
    requireSigned?: boolean;
    timestamp?: string;
  },
): Record<string, string> | undefined {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': opts.apiKey,
  };
  if (opts.signing) {
    Object.assign(
      headers,
      signCloudBody(body, {
        agentId: opts.signing.cloudAgentId,
        privateKeyPem: opts.signing.privateKeyPem,
        timestamp: opts.timestamp,
      }),
    );
  } else if (opts.requireSigned) {
    return undefined;
  }
  return headers;
}

/**
 * Resolve the approved agent identity used to sign runtime writes.
 *
 * The private key is loaded from the LOCAL brainclaw identity (resolved by
 * configured agent name / current-agent), while `cloudAgentId` (the value for
 * X-Agent-Id) comes from the configured cloud agent id when set — the cloud
 * assigns its own id at registration, distinct from the local identity id. When
 * no cloud id is configured (self-hosted / id-preserving), the local id is used.
 *
 * Returns undefined when no agent is configured or no local Ed25519 key exists.
 */
export function resolveCloudSigningIdentity(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): CloudSigningIdentity | undefined {
  let cfgAgentId: string | undefined;
  let cfgAgentName: string | undefined;
  try {
    const config = loadConfig(cwd);
    cfgAgentId = config.cloud_sync?.agent_id;
    cfgAgentName = config.cloud_sync?.agent_name;
  } catch {
    // No project config — fall back to env only.
  }

  // X-Agent-Id must be the CLOUD agent id, which is distinct from the local
  // identity id. BRAINCLAW_AGENT_ID is already the LOCAL id everywhere in
  // brainclaw (current-agent resolution, etc.), so a dedicated
  // BRAINCLAW_CLOUD_AGENT_ID override avoids sending the local id as the cloud
  // header when a session exports BRAINCLAW_AGENT_ID (review finding, pln#100).
  const cloudAgentId = (env.BRAINCLAW_CLOUD_AGENT_ID?.trim() || cfgAgentId || '').trim() || undefined;
  const agentName =
    (env.BRAINCLAW_AGENT_NAME?.trim() || env.BRAINCLAW_AGENT?.trim() || cfgAgentName || '').trim() || undefined;

  // Resolve the LOCAL identity backing the private key: prefer name, then fall
  // back to a local-id match (self-hosted), then the current agent.
  const identity =
    resolveRegisteredAgentIdentity({ agentName, cwd, env, allowCurrent: true, allowEnv: true }) ??
    (cloudAgentId ? resolveRegisteredAgentIdentity({ agentId: cloudAgentId, cwd, env }) : undefined);
  if (!identity) {
    logger.debug('Cloud signing: no local agent identity resolved.');
    return undefined;
  }

  const key = loadAgentSigningKey(identity.agent_id, env);
  if (!key) {
    logger.debug(`Cloud signing: agent '${identity.agent_name}' has no local Ed25519 key.`);
    return undefined;
  }

  return {
    cloudAgentId: cloudAgentId ?? identity.agent_id,
    localAgentId: identity.agent_id,
    agentName: identity.agent_name,
    ...key,
  };
}
