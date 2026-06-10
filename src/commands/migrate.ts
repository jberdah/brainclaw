import { loadState, mutateState } from '../core/state.js';
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

  const movedIds = {
    constraints: new Set(machineConstraints.map((c) => c.id)),
    decisions: new Set(machineDecisions.map((d) => d.id)),
    traps: new Set(machineTraps.map((t) => t.id)),
  };

  // Write target FIRST (a crash here leaves a duplicate, never silent loss),
  // each side as an atomic locked RMW so concurrent writes are not clobbered.
  mutateState((userState) => {
    for (const c of machineConstraints) {
      if (!userState.active_constraints.some((x) => x.id === c.id)) userState.active_constraints.push(c);
    }
    for (const d of machineDecisions) {
      if (!userState.recent_decisions.some((x) => x.id === d.id)) userState.recent_decisions.push(d);
    }
    for (const t of machineTraps) {
      if (!userState.known_traps.some((x) => x.id === t.id)) userState.known_traps.push(t);
    }
  }, userCwd);

  // Then delete from source — mutateState persists with deleteMissing so the
  // promoted entity files are actually unlinked from the project store.
  mutateState((sourceState) => {
    sourceState.active_constraints = sourceState.active_constraints.filter((x) => !movedIds.constraints.has(x.id));
    sourceState.recent_decisions = sourceState.recent_decisions.filter((x) => !movedIds.decisions.has(x.id));
    sourceState.known_traps = sourceState.known_traps.filter((x) => !movedIds.traps.has(x.id));
  }, cwd);

  for (const c of machineConstraints) {
    appendAuditEntry({ actor: agent, action: 'update', item_id: c.id, item_type: 'constraint', reason: 'promote to user store (machine scope)' }, cwd);
  }
  for (const d of machineDecisions) {
    appendAuditEntry({ actor: agent, action: 'update', item_id: d.id, item_type: 'decision', reason: 'promote to user store (machine scope)' }, cwd);
  }
  for (const t of machineTraps) {
    appendAuditEntry({ actor: agent, action: 'update', item_id: t.id, item_type: 'trap', reason: 'promote to user store (machine scope)' }, cwd);
  }

  console.log(`\n✔ Promoted ${total} item(s) to user store (${userCwd})`);
}
