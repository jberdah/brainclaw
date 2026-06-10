import {
  listDebrisAgentIdentities,
  registerAgentIdentity,
  removeAgentIdentity,
  setCurrentAgentIdentity,
} from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
import type { AgentKind, AgentTrustLevel } from '../core/schema.js';

export interface RegisterAgentOptions {
  kind?: AgentKind;
  capability?: string[];
  replaceCapabilities?: boolean;
  generateFingerprint?: boolean;
  setCurrent?: boolean;
  curator?: boolean;
  trustLevel?: AgentTrustLevel;
  json?: boolean;
}

export function runRegisterAgent(agentName: string, options: RegisterAgentOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const resolvedTrust: AgentTrustLevel | undefined =
    options.curator ? 'curator' : options.trustLevel;

  const agent = registerAgentIdentity({
    agentName,
    kind: options.kind ?? 'unknown',
    capabilities: options.capability,
    replaceCapabilities: options.replaceCapabilities,
    generateFingerprint: options.generateFingerprint,
    trustLevel: resolvedTrust,
  });

  if (options.setCurrent) {
    setCurrentAgentIdentity(agent);
  }

  if (options.json) {
    console.log(JSON.stringify({ ...agent, current: options.setCurrent ?? false }, null, 2));
    return;
  }

  const currentLabel = options.setCurrent ? ' [current]' : '';
  const capabilitiesLabel = agent.capabilities.length > 0 ? `, capabilities=${agent.capabilities.join(',')}` : '';
  const fingerprintLabel = agent.identity_key ? `, fp=${agent.identity_key.fingerprint.slice(0, 12)}` : '';
  console.log(`✔ Agent registered: ${agent.agent_name} (${agent.agent_id}, kind=${agent.kind}${capabilitiesLabel}${fingerprintLabel})${currentLabel}`);
}

export interface RemoveAgentOptions {
  force?: boolean;
  json?: boolean;
}

/**
 * Guarded identity removal (pln#562 step 2). Without --force, only known
 * debris identities (test fixtures, alias leftovers) can be removed.
 */
export function runRemoveAgent(agentNameOrId: string, options: RemoveAgentOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
  try {
    const removed = removeAgentIdentity(agentNameOrId, { force: options.force });
    if (options.json) {
      console.log(JSON.stringify({ removed: true, agent: removed }, null, 2));
      return;
    }
    console.log(`✔ Agent identity removed: ${removed.agent_name} (${removed.agent_id})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ removed: false, error: message }, null, 2));
    } else {
      console.error(`✖ ${message}`);
    }
    process.exitCode = 1;
  }
}

export interface ListDebrisAgentsOptions {
  json?: boolean;
}

/** List identities flagged as registration debris, without removing anything. */
export function runListDebrisAgents(options: ListDebrisAgentsOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
  const debris = listDebrisAgentIdentities();
  if (options.json) {
    console.log(JSON.stringify({
      debris: debris.map((d) => ({
        agent_id: d.identity.agent_id,
        agent_name: d.identity.agent_name,
        trust_level: d.identity.trust_level,
        reason: d.reason,
      })),
    }, null, 2));
    return;
  }
  if (debris.length === 0) {
    console.log('✔ No debris agent identities found.');
    return;
  }
  console.log(`⚠ ${debris.length} debris agent identit${debris.length === 1 ? 'y' : 'ies'} found:`);
  for (const d of debris) {
    console.log(`  - ${d.identity.agent_name} (${d.identity.agent_id}): ${d.reason}`);
  }
  console.log('Remove with `brainclaw register-agent <name> --remove`.');
}
