import { buildCoordinationSnapshot } from '../core/coordination.js';
import { listAgentIdentities } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';

export interface AgentBoardOptions {
  agent?: string;
  project?: string;
  for?: string;
  host?: string;
  allHosts?: boolean;
  json?: boolean;
  withReputation?: boolean;
  capabilities?: boolean;
  suggest?: string;
  includeSessionMeta?: boolean;
}

export function runAgentBoard(options: AgentBoardOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const board = buildCoordinationSnapshot({
    agent: options.agent,
    project: options.project,
    target: options.for,
    host: options.host,
    allHosts: options.allHosts,
    includeReputation: options.withReputation,
    includeSessionMeta: options.includeSessionMeta,
  });

  if (options.json) {
    console.log(JSON.stringify(board, null, 2));
    return;
  }

  console.log(`Agent board${board.agent ? ` for ${board.agent}` : ''}${board.project ? ` (${board.project})` : ''}`);
  console.log('');
  console.log(`Current host: ${board.current_host}`);
  if (board.all_hosts) {
    console.log('Host filter: all-hosts');
  } else if (board.host_filter) {
    console.log(`Host filter: ${board.host_filter}`);
  }
  if (options.withReputation && board.reputation_summary) {
    console.log(`Reputation: tracked=${board.reputation_summary.tracked_agents}, avg_trust=${board.reputation_summary.avg_internal_trust}`);
    if (board.agent_reputation) {
      console.log(`Agent trust: ${board.agent_reputation.internal_trust} (cq=${board.agent_reputation.contribution_quality}, rv=${board.agent_reputation.review_reliability}, ct=${board.agent_reputation.continuity_hygiene})`);
    }
  }
  console.log('');
  console.log(`Active plans: ${board.active_plans.length}`);
  for (const plan of board.active_plans.slice(0, 10)) {
    const claims = plan.claims.length ? ` claims=${plan.claims.map((claim) => claim.agent).join(',')}` : '';
    console.log(`  [${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})${claims}`);
  }
  console.log('');
  console.log(`Active claims: ${board.active_claims.length}`);
  for (const claim of board.active_claims.slice(0, 10)) {
    console.log(`  [${claim.id}] ${claim.agent} -> ${claim.scope}${claim.plan_id ? ` (plan ${claim.plan_id})` : ''}`);
  }
  console.log('');
  const sessionMetaHint = board.session_meta_hidden > 0 ? ` (+${board.session_meta_hidden} session lifecycle notes hidden — use --include-session-meta to show)` : '';
  console.log(`Runtime notes: ${board.runtime_notes.length}${sessionMetaHint}`);
  for (const note of board.runtime_notes.slice(-10)) {
    const scope = note.visibility === 'shared' ? 'shared' : `${note.visibility}:${note.host_id ?? 'unknown-host'}`;
    console.log(`  [${note.id}] ${note.agent}: ${note.text}${note.plan_id ? ` (plan ${note.plan_id})` : ''} [${scope}]`);
  }
  console.log('');
  console.log(`Open handoffs: ${board.open_handoffs.length}`);
  for (const handoff of board.open_handoffs.slice(0, 10)) {
    console.log(`  [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}${handoff.plan_id ? ` (plan ${handoff.plan_id})` : ''}`);
  }
  console.log('');
  console.log(`Resolved instructions: ${board.resolved_instructions.length}`);
  for (const instruction of board.resolved_instructions.slice(0, 10)) {
    console.log(`  [${instruction.id}] <${instruction.layer}${instruction.scope ? `:${instruction.scope}` : ''}> ${instruction.text}`);
  }

  // Capability routing
  if (options.capabilities || options.suggest) {
    const agents = listAgentIdentities();
    if (agents.length === 0) {
      console.log('');
      console.log('No agents registered.');
      return;
    }

    if (options.suggest) {
      const query = options.suggest.toLowerCase();
      const scored = agents
        .map(a => ({
          name: a.agent_name,
          capabilities: a.capabilities ?? [],
          score: (a.capabilities ?? []).filter(c => c.toLowerCase().includes(query)).length,
          trust_level: a.trust_level ?? 'contributor',
        }))
        .filter(a => a.score > 0)
        .sort((a, b) => b.score - a.score);

      console.log('');
      if (scored.length === 0) {
        console.log(`No agents have capabilities matching '${options.suggest}'.`);
      } else {
        console.log(`Suggested agents for '${options.suggest}':`);
        for (const a of scored) {
          console.log(`  ${a.name} (${a.trust_level}) — ${a.capabilities.join(', ')}`);
        }
      }
    } else {
      console.log('');
      console.log(`Registered agents: ${agents.length}`);
      for (const a of agents) {
        const caps = (a.capabilities ?? []).length > 0 ? ` — ${a.capabilities!.join(', ')}` : '';
        const fingerprint = a.identity_key?.fingerprint ? ` fp=${a.identity_key.fingerprint.slice(0, 12)}` : '';
        console.log(`  ${a.agent_name} (${a.trust_level ?? 'contributor'})${caps}${fingerprint}`);
      }
    }
  }
}
