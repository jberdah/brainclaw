/**
 * Cloud transport for Brainclaw Federation.
 * Pushes/pulls federation signals via the Brainclaw Cloud API (app.brainclaw.dev).
 *
 * @module
 */
import type { FederationMessage } from './federation-message.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const DEFAULT_API_URL = 'https://app.brainclaw.dev';

interface CloudConfig {
  apiUrl: string;
  apiKey: string;
  enabled: boolean;
}

function resolveCloudConfig(cwd?: string): CloudConfig | undefined {
  const envApiUrl = process.env.BRAINCLAW_CLOUD_URL;
  const envApiKey = process.env.BRAINCLAW_CLOUD_API_KEY;

  let configEnabled = false;
  let configEndpoint: string | undefined;
  let configApiKey: string | undefined;
  try {
    const config = loadConfig(cwd);
    if (config.cloud_sync) {
      configEnabled = config.cloud_sync.enabled === true;
      configEndpoint = config.cloud_sync.endpoint;
      configApiKey = config.cloud_sync.api_key;
    }
  } catch {
    // No config available — fall back to env only
  }

  const apiKey = envApiKey ?? configApiKey;
  if (!apiKey) return undefined;

  // Env-supplied key implies explicit opt-in; config flag is the alternative
  const enabled = Boolean(envApiKey) || configEnabled;

  const apiUrl = envApiUrl ?? configEndpoint ?? DEFAULT_API_URL;
  return { apiUrl, apiKey, enabled };
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

  try {
    const response = await fetch(`${cloud.apiUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': cloud.apiKey,
      },
      body: JSON.stringify(message),
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

  try {
    const response = await fetch(
      `${cloud.apiUrl}/api/v1/board/${encodeURIComponent(projectName)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': cloud.apiKey,
        },
        body: JSON.stringify(boardData),
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
