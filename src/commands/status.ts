import { listAgentIdentities } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { resolveCurrentHostId } from '../core/host.js';
import { listClaims } from '../core/claims.js';
import { loadInstructions } from '../core/instructions.js';
import { buildReputationSnapshot } from '../core/reputation.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { loadState } from '../core/state.js';
import { listOperationalTraps } from '../core/traps.js';
import { generateMarkdown } from '../core/markdown.js';
import { memoryExists } from '../core/io.js';
import type { Config, State } from '../core/schema.js';

export interface StatusOptions {
  json?: boolean;
  markdown?: boolean;
}

function printHumanStatus(state: State, config: Config): void {
  const activePlans = state.plan_items.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  const activeInstructions = loadInstructions().filter((entry) => entry.active);
  const activeClaims = listClaims().filter((claim) => claim.status === 'active');
  const registeredAgents = listAgentIdentities();
  const currentHost = resolveCurrentHostId();
  const sharedRuntimeNotes = listRuntimeNotes({ visibility: 'shared' });
  const machineRuntimeNotes = listRuntimeNotes({ visibility: 'machine' });
  const machineTraps = listOperationalTraps({ visibility: 'machine' });
  const counts = {
    instructions: activeInstructions.length,
    claims: activeClaims.length,
    runtime: sharedRuntimeNotes.length + machineRuntimeNotes.length,
    plans: activePlans.length,
    constraints: state.active_constraints.length,
    decisions: state.recent_decisions.length,
    traps: state.known_traps.length + machineTraps.length,
    handoffs: state.open_handoffs.length,
  };

  const total = counts.instructions + counts.claims + counts.runtime + counts.plans + counts.constraints + counts.decisions + counts.traps + counts.handoffs;

  console.log(`Project memory: ${total} item(s)`);
  console.log('');
  console.log(`  Project ID  : ${config.project_id ?? 'unknown'}`);
  console.log(`  Current agent: ${config.current_agent ?? 'unknown'}${config.current_agent_id ? ` (${config.current_agent_id})` : ''}`);
  console.log(`  Registered  : ${registeredAgents.length} agent(s)`);
  console.log(`  Storage dir : ${config.storage_dir}`);
  console.log(`  Topology    : ${config.topology}`);
  console.log(`  Project mode: ${config.project_mode}`);
  console.log(`  Strategy    : ${config.projects.strategy}`);
  console.log(`  Instructions: ${counts.instructions}`);
  console.log(`  Claims      : ${counts.claims}`);
  console.log(`  Runtime     : ${sharedRuntimeNotes.length} shared, ${machineRuntimeNotes.length} machine-local (${currentHost})`);
  console.log(`  Plans       : ${counts.plans}`);
  console.log(`  Constraints : ${counts.constraints}`);
  console.log(`  Decisions   : ${counts.decisions}`);
  console.log(`  Traps       : ${state.known_traps.length} shared, ${machineTraps.length} machine-local (${currentHost})`);
  console.log(`  Handoffs    : ${counts.handoffs}`);

  if (config.project_mode === 'multi-project') {
    console.log(`  Projects    : ${config.projects.known.length}`);
  }

  // Show recent items (last 3 per section)
  const sections = [
    { label: 'Shared instructions', items: activeInstructions },
    { label: 'Active claims', items: activeClaims },
    { label: 'Shared plan', items: activePlans },
    { label: 'Active constraints', items: state.active_constraints },
    { label: 'Recent decisions', items: state.recent_decisions },
    { label: 'Known traps', items: state.known_traps },
    { label: 'Open handoffs', items: state.open_handoffs },
  ] as const;

  for (const section of sections) {
    if (section.items.length > 0) {
      console.log('');
      console.log(`  ${section.label}:`);
      const recent = section.items.slice(-3);
      for (const item of recent) {
        const text = 'text' in item ? item.text : '';
        console.log(`    [${item.id}] ${text}`);
      }
      if (section.items.length > 3) {
        console.log(`    ... and ${section.items.length - 3} more`);
      }
    }
  }

  // Warnings
  const openHandoffs = state.open_handoffs.filter(h => h.status === 'open');
  if (openHandoffs.length > 0) {
    console.log('');
    console.log(`  ⚠ ${openHandoffs.length} open handoff(s) pending`);
  }
}

export function runStatus(options: StatusOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig();
  const state = loadState();
  const currentHost = resolveCurrentHostId();
  const sharedRuntimeNotes = listRuntimeNotes({ visibility: 'shared' });
  const machineRuntimeNotes = listRuntimeNotes({ visibility: 'machine' });
  const machineTraps = listOperationalTraps({ visibility: 'machine' });
  const registeredAgents = listAgentIdentities();
  const reputation = buildReputationSnapshot();

  if (options.json) {
    console.log(JSON.stringify({
      config,
      agents: {
        current_name: config.current_agent,
        current_id: config.current_agent_id,
        registered: registeredAgents,
      },
      state,
      runtime: {
        current_host: currentHost,
        shared: sharedRuntimeNotes.length,
        machine_local: machineRuntimeNotes.length,
      },
      traps: {
        shared: state.known_traps.length,
        machine_local: machineTraps.length,
      },
      reputation,
    }, null, 2));
    return;
  }

  if (options.markdown) {
    console.log(generateMarkdown(state));
    return;
  }

  printHumanStatus(state, config);
}
