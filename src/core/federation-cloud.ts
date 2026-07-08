/**
 * Cloud transport for Brainclaw Federation.
 * Pushes/pulls federation signals via the Brainclaw Cloud API (app.brainclaw.dev).
 *
 * Runtime writes (push) are signed with the approved agent's Ed25519 key when a
 * signing identity is configured (pln#100); reads (pull) use the API key only.
 * With `require_signed` set, an unsignable write fails closed rather than
 * silently downgrading to API-key-only auth.
 *
 * @module
 */
import type { FederationMessage } from './federation-message.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import {
  buildCloudWriteHeaders,
  resolveCloudSigningIdentity,
  type CloudSigningIdentity,
} from './federation-signing.js';

const DEFAULT_API_URL = 'https://app.brainclaw.dev';

interface CloudConfig {
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
  projectId?: string;
  requireSigned: boolean;
}

function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function resolveCloudConfig(cwd?: string): CloudConfig | undefined {
  const envApiUrl = process.env.BRAINCLAW_CLOUD_URL;
  const envApiKey = process.env.BRAINCLAW_CLOUD_API_KEY;
  const envProjectId = process.env.BRAINCLAW_PROJECT_ID;
  const envRequireSigned = process.env.BRAINCLAW_CLOUD_REQUIRE_SIGNED;

  let configEnabled = false;
  let configEndpoint: string | undefined;
  let configApiKey: string | undefined;
  let configProjectId: string | undefined;
  let configRequireSigned = false;
  try {
    const config = loadConfig(cwd);
    if (config.cloud_sync) {
      configEnabled = config.cloud_sync.enabled === true;
      configEndpoint = config.cloud_sync.endpoint;
      configApiKey = config.cloud_sync.api_key;
      configProjectId = config.cloud_sync.project_id;
      configRequireSigned = config.cloud_sync.require_signed === true;
    }
  } catch {
    // No config available — fall back to env only
  }

  const apiKey = envApiKey ?? configApiKey;
  if (!apiKey) return undefined;

  // Env-supplied key implies explicit opt-in; config flag is the alternative
  const enabled = Boolean(envApiKey) || configEnabled;

  const apiUrl = envApiUrl ?? configEndpoint ?? DEFAULT_API_URL;
  const projectId = envProjectId?.trim() || configProjectId;
  const requireSigned = envRequireSigned !== undefined ? envFlag(envRequireSigned) : configRequireSigned;
  return { apiUrl, apiKey, enabled, projectId, requireSigned };
}

/**
 * Build the outgoing headers for a runtime write, signing when possible.
 * Returns undefined when `require_signed` is set but no signing identity is
 * available — the caller must NOT send the request (fail-closed).
 */
function writeHeaders(body: string, cloud: CloudConfig, cwd?: string): Record<string, string> | undefined {
  const signing = resolveCloudSigningIdentity(cwd);
  return buildCloudWriteHeaders(body, {
    apiKey: cloud.apiKey,
    signing,
    requireSigned: cloud.requireSigned,
  });
}

export async function pushSignalToCloud(
  message: FederationMessage,
  cwd?: string,
): Promise<boolean> {
  const cloud = resolveCloudConfig(cwd);
  if (!cloud) {
    logger.debug('Cloud not configured — skipping push');
    return false;
  }

  const body = JSON.stringify(message);
  const headers = writeHeaders(body, cloud, cwd);
  if (!headers) {
    logger.warn(
      'Cloud push refused: require_signed is set but no approved signing identity/key is available (fail-closed).',
    );
    return false;
  }

  try {
    const response = await fetch(`${cloud.apiUrl}/api/v1/messages`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      logger.debug(`Cloud push failed: ${response.status} ${response.statusText}`);
      return false;
    }

    return true;
  } catch (err) {
    logger.debug('Cloud push error:', err);
    return false;
  }
}

export async function pullSignalsFromCloud(
  agentName: string,
  options?: { since?: string; limit?: number },
  cwd?: string,
): Promise<FederationMessage[]> {
  const cloud = resolveCloudConfig(cwd);
  if (!cloud) {
    return [];
  }

  try {
    const params = new URLSearchParams();
    if (options?.since) params.set('since', options.since);
    if (options?.limit) params.set('limit', String(options.limit));

    const url = `${cloud.apiUrl}/api/v1/inbox/${encodeURIComponent(agentName)}?${params}`;
    const response = await fetch(url, {
      headers: { 'X-API-Key': cloud.apiKey },
    });

    if (!response.ok) {
      logger.debug(`Cloud pull failed: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as { messages: FederationMessage[] };
    return data.messages ?? [];
  } catch (err) {
    logger.debug('Cloud pull error:', err);
    return [];
  }
}

export async function pushBoardToCloud(
  projectName: string,
  boardData: unknown,
  cwd?: string,
): Promise<boolean> {
  const cloud = resolveCloudConfig(cwd);
  if (!cloud) return false;

  const body = JSON.stringify(boardData);
  const headers = writeHeaders(body, cloud, cwd);
  if (!headers) {
    logger.warn(
      'Cloud board push refused: require_signed is set but no approved signing identity/key is available (fail-closed).',
    );
    return false;
  }

  try {
    const response = await fetch(
      `${cloud.apiUrl}/api/v1/board/${encodeURIComponent(projectName)}`,
      {
        method: 'POST',
        headers,
        body,
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export function isCloudConfigured(cwd?: string): boolean {
  return resolveCloudConfig(cwd) !== undefined;
}

/**
 * Returns true when cloud sync is both configured AND explicitly opted-in.
 * Use this gate for automatic lifecycle hooks (session-start pull, session-end push).
 * `isCloudConfigured` alone does NOT imply opt-in — a stale config api_key without
 * `cloud_sync.enabled=true` and without the BRAINCLAW_CLOUD_API_KEY env var stays inert.
 */
export function isCloudSyncEnabled(cwd?: string): boolean {
  const cloud = resolveCloudConfig(cwd);
  return cloud !== undefined && cloud.enabled;
}

// ── Diagnostics (pln#100 step 5) ────────────────────────────────────────────

export interface CloudBridgeDiagnostics {
  configured: boolean;
  enabled: boolean;
  apiUrl: string;
  projectId?: string;
  requireSigned: boolean;
  health?: { ok: boolean; status?: string; version?: string; error?: string };
  signing:
    | { available: true; cloudAgentId: string; agentName: string; fingerprint: string }
    | { available: false; reason: string };
  approvedAgent?: {
    found: boolean;
    status?: string;
    trustLevel?: string;
    fingerprintMatch?: boolean;
    error?: string;
  };
}

/**
 * Startup diagnostics for the cloud bridge: remote health, resolved signing
 * identity, approved-agent lookup, and a local↔remote key fingerprint match.
 * Never throws — every probe degrades to an error field so the CLI can print a
 * complete report.
 */
export async function diagnoseCloudBridge(cwd?: string): Promise<CloudBridgeDiagnostics> {
  const cloud = resolveCloudConfig(cwd);
  const apiUrl = cloud?.apiUrl ?? process.env.BRAINCLAW_CLOUD_URL ?? DEFAULT_API_URL;

  const signingIdentity: CloudSigningIdentity | undefined = resolveCloudSigningIdentity(cwd);
  const diag: CloudBridgeDiagnostics = {
    configured: Boolean(cloud),
    enabled: cloud?.enabled ?? false,
    apiUrl,
    projectId: cloud?.projectId,
    requireSigned: cloud?.requireSigned ?? false,
    signing: signingIdentity
      ? {
          available: true,
          cloudAgentId: signingIdentity.cloudAgentId,
          agentName: signingIdentity.agentName,
          fingerprint: signingIdentity.fingerprint,
        }
      : {
          available: false,
          reason:
            'No approved agent id/name configured, or the agent has no local Ed25519 key. '
            + 'Register the agent and its key with the cloud first.',
        },
  };

  if (!cloud) return diag;

  // Remote health
  try {
    const res = await fetch(`${apiUrl}/api/v1/health`);
    const data = (await res.json()) as Record<string, unknown>;
    diag.health = { ok: res.ok, status: String(data.status ?? ''), version: String(data.version ?? '') };
  } catch (e) {
    diag.health = { ok: false, error: (e as Error).message };
  }

  // Approved-agent lookup + fingerprint match
  if (signingIdentity) {
    try {
      const res = await fetch(`${apiUrl}/api/v1/agents/${encodeURIComponent(signingIdentity.cloudAgentId)}`, {
        headers: { 'X-API-Key': cloud.apiKey },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          agent?: { status?: string; trust_level?: string; key_fingerprint?: string };
        };
        const agent = data.agent;
        diag.approvedAgent = {
          found: Boolean(agent),
          status: agent?.status,
          trustLevel: agent?.trust_level,
          fingerprintMatch: agent?.key_fingerprint
            ? agent.key_fingerprint === signingIdentity.fingerprint
            : false,
        };
      } else {
        diag.approvedAgent = { found: false, error: `HTTP ${res.status}` };
      }
    } catch (e) {
      diag.approvedAgent = { found: false, error: (e as Error).message };
    }
  }

  return diag;
}
