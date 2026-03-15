import { memoryExists } from '../core/io.js';
import { setAgentTrustLevel } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { buildOperationalIdentity } from '../core/identity.js';
import type { AgentTrustLevel } from '../core/schema.js';

export interface SetTrustOptions {
  level: AgentTrustLevel;
  json?: boolean;
}

export function runSetTrust(agentName: string, options: SetTrustOptions): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const validLevels: AgentTrustLevel[] = ['observer', 'contributor', 'trusted', 'curator'];
  if (!validLevels.includes(options.level)) {
    console.error(`Error: invalid trust level '${options.level}'. Must be one of: ${validLevels.join(', ')}`);
    process.exit(1);
  }

  let actor = 'unknown';
  try {
    const identity = buildOperationalIdentity();
    actor = identity.agent;
  } catch { /* use default */ }

  let updated;
  try {
    updated = setAgentTrustLevel(agentName, options.level);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  appendAuditEntry({
    action: 'trust_change',
    actor,
    item_id: updated.agent_id,
    item_type: 'agent',
    after: { trust_level: options.level },
    reason: `set by ${actor}`,
  });

  if (options.json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }

  console.log(`✔ Trust level for ${agentName} set to '${options.level}' (${updated.agent_id})`);
}
