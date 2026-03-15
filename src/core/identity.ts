import { requireOperationalAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';

export interface OperationalIdentity {
  agent: string;
  agent_id: string;
  project_id?: string;
  host_id: string;
  session_id?: string;
}

export function resolveCurrentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.BRAINCLAW_SESSION_ID?.trim()
    || env.OPENCLAW_SESSION_ID?.trim()
    || env.CLAUDE_SESSION_ID?.trim()
    || env.COPILOT_SESSION_ID?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function buildOperationalIdentity(agentName?: string, cwd?: string): OperationalIdentity {
  const actor = requireOperationalAgentIdentity(agentName, cwd);
  const config = loadConfig(cwd);
  return {
    agent: actor.agent_name,
    agent_id: actor.agent_id,
    project_id: config.project_id,
    host_id: resolveCurrentHostId(),
    session_id: resolveCurrentSessionId(),
  };
}

export function resolveEventSessionId(event: { session_id?: string; metadata?: Record<string, unknown> | undefined }): string | undefined {
  if (typeof event.session_id === 'string' && event.session_id.trim().length > 0) {
    return event.session_id;
  }
  const metadataSession = event.metadata?.session;
  return typeof metadataSession === 'string' && metadataSession.trim().length > 0
    ? metadataSession
    : undefined;
}
