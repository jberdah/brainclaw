import { memoryExists } from '../core/io.js';
import { resolveCurrentAgentIdentity, resolveExistingCurrentAgent } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { resolveCurrentHostId } from '../core/host.js';
import { buildOperationalIdentity } from '../core/identity.js';

export interface WhoamiOptions {
  json?: boolean;
}

export function runWhoami(options: WhoamiOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig();
  const hostId = resolveCurrentHostId();

  let identity;
  try {
    identity = buildOperationalIdentity();
  } catch { /* no agent configured */ }

  const agent = identity
    ? resolveCurrentAgentIdentity()
    : undefined;

  const result = {
    resolved_agent: identity?.agent ?? null,
    agent_id: identity?.agent_id ?? null,
    host_id: hostId,
    session_id: identity?.session_id ?? null,
    project_id: identity?.project_id ?? null,
    project_name: config.project_name,
    storage_dir: config.storage_dir,
    trust_level: agent?.trust_level ?? 'contributor',
    capabilities: agent?.capabilities ?? [],
    kind: agent?.kind ?? 'unknown',
    env_agent: process.env.BRAINCLAW_AGENT ?? null,
    env_session: process.env.BRAINCLAW_SESSION_ID ?? null,
    env_host: process.env.BRAINCLAW_HOST_ID ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Identity resolved for: ${result.resolved_agent ?? '(no agent)'}`);
  if (result.agent_id) console.log(`  Agent ID   : ${result.agent_id}`);
  console.log(`  Trust level: ${result.trust_level}`);
  if (result.capabilities.length > 0) console.log(`  Capabilities: ${result.capabilities.join(', ')}`);
  console.log(`  Kind       : ${result.kind}`);
  console.log(`  Host ID    : ${result.host_id}`);
  if (result.session_id) console.log(`  Session ID : ${result.session_id}`);
  console.log(`  Project    : ${result.project_name} (${result.project_id ?? 'n/a'})`);
  console.log(`  Storage    : ${result.storage_dir}`);
}
