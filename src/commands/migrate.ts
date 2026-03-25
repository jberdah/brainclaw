import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { resolveTargetStore } from '../core/store-resolution.js';
import { appendAuditEntry } from '../core/audit.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import type { Constraint, Decision, Trap } from '../core/schema.js';

export interface MigrateOptions {
  promoteMachineItems?: boolean;
  dryRun?: boolean;
  cwd?: string;
}

export function runMigrate(options: MigrateOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (options.promoteMachineItems) {
    promoteMachineItems(cwd, options.dryRun ?? false);
  } else {
    console.log('Usage: brainclaw migrate --promote-machine-items [--dry-run]');
    console.log('');
    console.log('Moves items tagged scope:machine from project store to user store (~/.brainclaw/).');
  }
}

function promoteMachineItems(cwd: string, dryRun: boolean): void {
  const state = loadState(cwd);
  const agent = resolveCurrentAgentName(cwd);

  const machineConstraints = state.active_constraints.filter((c) => c.scope === 'machine');
  const machineDecisions = state.recent_decisions.filter((d) => d.scope === 'machine');
  const machineTraps = state.known_traps.filter((t) => t.scope === 'machine');

  const total = machineConstraints.length + machineDecisions.length + machineTraps.length;

  if (total === 0) {
    console.log('No machine-scoped items found in project store.');
    return;
  }

  console.log(`Found ${total} machine-scoped item(s) in project store:\n`);
  for (const c of machineConstraints) console.log(`  [constraint] ${c.id} — ${c.text.slice(0, 80)}`);
  for (const d of machineDecisions) console.log(`  [decision]   ${d.id} — ${d.text.slice(0, 80)}`);
  for (const t of machineTraps) console.log(`  [trap]       ${t.id} — ${t.text.slice(0, 80)}`);

  if (dryRun) {
    console.log(`\n(dry-run) Would move ${total} item(s) to user store.`);
    return;
  }

  // Resolve user store
  let userCwd: string;
  try {
    userCwd = resolveTargetStore(cwd, 'user');
  } catch {
    console.error('Error: cannot resolve user store. Run `brainclaw setup` first.');
    process.exit(1);
  }

  const userState = loadState(userCwd);

  // Move constraints
  for (const c of machineConstraints) {
    userState.active_constraints.push(c);
    state.active_constraints = state.active_constraints.filter((x) => x.id !== c.id);
    appendAuditEntry({ actor: agent, action: 'update', item_id: c.id, item_type: 'constraint', reason: 'promote to user store (machine scope)' }, cwd);
  }

  // Move decisions
  for (const d of machineDecisions) {
    userState.recent_decisions.push(d);
    state.recent_decisions = state.recent_decisions.filter((x) => x.id !== d.id);
    appendAuditEntry({ actor: agent, action: 'update', item_id: d.id, item_type: 'decision', reason: 'promote to user store (machine scope)' }, cwd);
  }

  // Move traps
  for (const t of machineTraps) {
    userState.known_traps.push(t);
    state.known_traps = state.known_traps.filter((x) => x.id !== t.id);
    appendAuditEntry({ actor: agent, action: 'update', item_id: t.id, item_type: 'trap', reason: 'promote to user store (machine scope)' }, cwd);
  }

  persistState(userState, userCwd);
  persistState(state, cwd);

  console.log(`\n✔ Promoted ${total} item(s) to user store (${userCwd})`);
}
