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
}

function resolveCloudConfig(cwd?: string): CloudConfig | undefined {
  // Check env vars first
  const apiUrl = process.env.BRAINCLAW_CLOUD_URL ?? DEFAULT_API_URL;
  const apiKey = process.env.BRAINCLAW_CLOUD_API_KEY;

  if (apiKey) {
    return { apiUrl, apiKey };
  }

  // Check config.yaml
  try {
    const config = loadConfig(cwd);
    const cloud = (config as Record<string, unknown>).cloud as
      | { api_url?: string; api_key?: string }
      | undefined;
    if (cloud?.api_key) {
      return { apiUrl: cloud.api_url ?? apiUrl, apiKey: cloud.api_key };
    }
  } catch {
    // No config — cloud not configured
  }

  return undefined;
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
