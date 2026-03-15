import { memoryExists } from '../core/io.js';
import { readAuditLog } from '../core/audit.js';
import { loadState, saveState } from '../core/state.js';
import { loadCandidate, saveCandidate } from '../core/candidates.js';
import { appendAuditEntry } from '../core/audit.js';
import { buildOperationalIdentity } from '../core/identity.js';
import type { Constraint, Decision, Trap } from '../core/schema.js';

export interface RollbackOptions {
  auditId?: string;
  itemId?: string;
  actor?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface RollbackResult {
  ok: boolean;
  audit_entry?: string;
  item_id?: string;
  item_type?: string;
  action_reversed?: string;
  message: string;
}

export function runRollback(options: RollbackOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (!options.auditId && !options.itemId) {
    console.error('Error: provide --audit-id <id> or --item-id <id> to identify what to roll back.');
    process.exit(1);
  }

  let actor;
  try {
    actor = buildOperationalIdentity(options.actor);
  } catch {
    actor = { agent: options.actor ?? process.env.USER ?? process.env.USERNAME ?? 'unknown', agent_id: undefined };
  }

  // Find the target audit entry
  let entries = readAuditLog();

  if (options.auditId) {
    // Look for entry with matching timestamp prefix (first 20 chars are a sortable ISO prefix)
    entries = entries.filter(e => e.timestamp.startsWith(options.auditId!) || e.timestamp === options.auditId);
  } else if (options.itemId) {
    // Get most recent audit entry for this item that has a `before` snapshot
    entries = entries
      .filter(e => e.item_id === options.itemId && e.before !== undefined)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  if (entries.length === 0) {
    const result: RollbackResult = {
      ok: false,
      message: `No audit entry found for ${options.auditId ?? options.itemId}. Cannot roll back.`,
    };
    if (options.json) { console.log(JSON.stringify(result, null, 2)); } else { console.error(`Error: ${result.message}`); }
    process.exit(1);
  }

  const entry = entries[0]!;

  if (entry.before === undefined) {
    const result: RollbackResult = {
      ok: false,
      item_id: entry.item_id,
      message: `Audit entry at ${entry.timestamp} has no 'before' snapshot. Cannot roll back.`,
    };
    if (options.json) { console.log(JSON.stringify(result, null, 2)); } else { console.error(`Error: ${result.message}`); }
    process.exit(1);
  }

  const result = applyRollback(entry, actor.agent, options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    const dryLabel = options.dryRun ? ' (dry run)' : '';
    console.log(`✔ Rolled back ${result.item_type} [${result.item_id}]${dryLabel}: ${result.message}`);
  } else {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
}

function applyRollback(
  entry: ReturnType<typeof readAuditLog>[number],
  actorName: string,
  options: RollbackOptions,
): RollbackResult {
  const { item_id, item_type, before, action } = entry;

  if (!item_id || !item_type || !before) {
    return { ok: false, message: 'Audit entry is missing item_id, item_type, or before snapshot.' };
  }

  if (options.dryRun) {
    return {
      ok: true,
      audit_entry: entry.timestamp,
      item_id,
      item_type,
      action_reversed: action,
      message: `Would restore ${item_type} to state before ${action} at ${entry.timestamp}`,
    };
  }

  try {
    if (item_type === 'candidate') {
      try {
        const existing = loadCandidate(item_id);
        saveCandidate({ ...existing, ...(before as Record<string, unknown>) } as typeof existing);
      } catch {
        // Candidate may have been deleted — try to recreate from before snapshot
        saveCandidate(before as Parameters<typeof saveCandidate>[0]);
      }
    } else if (['constraint', 'decision', 'trap'].includes(item_type)) {
      const state = loadState();
      if (item_type === 'constraint') {
        const idx = state.active_constraints.findIndex(c => c.id === item_id);
        if (idx >= 0) {
          state.active_constraints[idx] = before as Constraint;
        } else {
          state.active_constraints.push(before as Constraint);
        }
      } else if (item_type === 'decision') {
        const idx = state.recent_decisions.findIndex(d => d.id === item_id);
        if (idx >= 0) {
          state.recent_decisions[idx] = before as Decision;
        } else {
          state.recent_decisions.push(before as Decision);
        }
      } else if (item_type === 'trap') {
        const idx = state.known_traps.findIndex(t => t.id === item_id);
        if (idx >= 0) {
          state.known_traps[idx] = before as Trap;
        } else {
          state.known_traps.push(before as Trap);
        }
      }
      saveState(state);
    } else {
      return { ok: false, message: `Rollback not supported for item_type '${item_type}'.` };
    }

    appendAuditEntry({
      actor: actorName,
      action: 'rollback',
      item_id,
      item_type,
      reason: `Rolled back ${action} at ${entry.timestamp}`,
    });

    return {
      ok: true,
      audit_entry: entry.timestamp,
      item_id,
      item_type,
      action_reversed: action,
      message: `Restored to state before '${action}' at ${entry.timestamp}`,
    };
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
