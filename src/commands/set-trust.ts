import { memoryExists } from '../core/io.js';
import {
  hasElevatedAgent,
  requireMinimumTrustLevel,
  requireRegisteredAgentIdentity,
  setAgentTrustLevel,
} from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { resetCircuitBreaker } from '../core/circuit-breaker.js';
import type { AgentTrustLevel } from '../core/schema.js';

export interface SetTrustOptions {
  level?: AgentTrustLevel;
  resetBreaker?: boolean;
  json?: boolean;
  cwd?: string;
}

export function runSetTrust(agentName: string, options: SetTrustOptions): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  // --reset-breaker path: only resets the circuit-breaker override, no trust change needed
  if (options.resetBreaker) {
    try {
      resetCircuitBreaker(agentName, options.cwd);
      if (options.json) {
        console.log(JSON.stringify({ ok: true, agent: agentName, action: 'circuit_breaker_reset' }));
      } else {
        console.log(`✔ Circuit-breaker reset for agent '${agentName}'. Auto-promote is restored.`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
    return;
  }

  if (!options.level) {
    console.error('Error: --level is required unless --reset-breaker is specified.');
    process.exit(1);
  }
  const level = options.level;

  const validLevels: AgentTrustLevel[] = ['observer', 'contributor', 'trusted', 'curator'];
  if (!validLevels.includes(level)) {
    console.error(`Error: invalid trust level '${level}'. Must be one of: ${validLevels.join(', ')}`);
    process.exit(1);
  }

  let actor = 'unknown';
  let actorId: string | undefined;
  try {
    const identity = buildOperationalIdentity();
    actor = identity.agent;
    actorId = identity.agent_id;
  } catch { /* use default */ }

  let bootstrapCurator = false;
  if (!hasElevatedAgent()) {
    if (level !== 'curator') {
      console.error("Error: no trusted or curator agent exists yet. Bootstrap the first curator with `brainclaw set-trust <agent> --level curator`.");
      process.exit(1);
    }
    bootstrapCurator = true;
  } else {
    try {
      const actorIdentity = requireRegisteredAgentIdentity();
      requireMinimumTrustLevel(actorIdentity, 'curator');
      actor = actorIdentity.agent_name;
      actorId = actorIdentity.agent_id;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  }

  let updated;
  try {
    updated = setAgentTrustLevel(agentName, level);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  appendAuditEntry({
    action: 'trust_change',
    actor,
    actor_id: actorId,
    item_id: updated.agent_id,
    item_type: 'agent',
    after: { trust_level: level },
    reason: bootstrapCurator ? 'bootstrap_curator' : `set by ${actor}`,
  });

  if (options.json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }

  console.log(`✔ Trust level for ${agentName} set to '${level}' (${updated.agent_id})`);
}
