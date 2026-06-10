/**
 * `brainclaw stale` — minimal operator flow over the staleness detector.
 *
 * Phase 4 Sprint 1 Lane A step 4 (pln#390 / stp_18d6bc03). Lets operators
 * list stale items and apply the canonical v1.0 action without having to
 * remember per-entity syntax.
 *
 * Subcommands:
 *   list                — print the stale report (same as doctor + board)
 *   resolve <id>        — apply the canonical action for the entity type:
 *                           plan        → transition status 'dropped'
 *                           handoff     → transition status 'closed'
 *                           candidate   → transition status 'rejected'
 *                           trap        → transition status 'resolved'
 *                           runtime_note → remove (archive via entity-operations)
 */

import { listCandidates } from '../core/candidates.js';
import {
  removeEntity,
  transitionEntity,
} from '../core/entity-operations.js';
import type { EntityName } from '../core/entity-registry.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { loadState } from '../core/state.js';
import {
  detectStaleness,
  staleSummary,
  type StalenessEntity,
  type StalenessReport,
  type StalenessWarning,
} from '../core/staleness.js';

export interface StaleOptions {
  json?: boolean;
  cwd?: string;
}

/**
 * Resolve the canonical transition target (or removal) per entity kind.
 * decision/constraint are intentionally absent: they are only flagged for
 * dead related_paths (pln#557 step 2), and the fix is updating the paths via
 * bclaw_update — not a lifecycle transition.
 */
const RESOLVE_ACTIONS: Partial<Record<StalenessEntity, { kind: 'transition'; entity: EntityName; to: string } | { kind: 'remove'; entity: EntityName }>> = {
  plan: { kind: 'transition', entity: 'plan', to: 'dropped' },
  handoff: { kind: 'transition', entity: 'handoff', to: 'closed' },
  candidate: { kind: 'transition', entity: 'candidate', to: 'rejected' },
  trap: { kind: 'transition', entity: 'trap', to: 'resolved' },
  runtime_note: { kind: 'remove', entity: 'runtime_note' },
};

function buildReport(cwd?: string): StalenessReport {
  const state = loadState(cwd);
  const pending = listCandidates('pending', cwd);
  const notes = listRuntimeNotes(undefined, cwd);
  return detectStaleness(
    state.plan_items,
    state.known_traps,
    state.open_handoffs,
    pending,
    Date.now(),
    notes,
    {
      decisions: state.recent_decisions,
      constraints: state.active_constraints,
      projectRoot: cwd ?? process.cwd(),
    },
  );
}

export function runStaleList(options: StaleOptions = {}): void {
  const report = buildReport(options.cwd);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.warnings.length === 0) {
    console.log('✔ No stale items detected.');
    return;
  }

  console.log(`⚠ ${staleSummary(report)}`);
  console.log('');
  for (const w of report.warnings) {
    console.log(`  [${w.entity} ${w.id}] ${w.reason}`);
    console.log(`    → brainclaw stale resolve ${w.id}   # or: ${w.suggested_action}`);
  }
}

export function runStaleResolve(id: string, options: StaleOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const report = buildReport(cwd);
  const warning = report.warnings.find((w) => w.id === id);
  if (!warning) {
    console.error(`Error: ${id} is not currently flagged stale.`);
    console.error('Run `brainclaw stale list` to see the current warnings.');
    process.exit(1);
  }

  const action = RESOLVE_ACTIONS[warning.entity];
  if (!action) {
    console.error(`Error: ${warning.entity} ${id} has no canonical stale-resolve action.`);
    console.error(`Fix it directly instead: ${warning.suggested_action}`);
    process.exit(1);
  }
  try {
    if (action.kind === 'transition') {
      const result = transitionEntity(action.entity, id, action.to, cwd, 'resolved via brainclaw stale resolve');
      if (options.json) {
        console.log(JSON.stringify({ resolved: id, ...result }, null, 2));
      } else {
        console.log(`✔ ${warning.entity} ${id}: ${result.from} → ${action.to}`);
      }
    } else {
      const result = removeEntity(action.entity, id, cwd);
      if (options.json) {
        console.log(JSON.stringify({ resolved: id, ...result }, null, 2));
      } else {
        const verb = result.purged ? 'purged' : 'archived';
        console.log(`✔ ${warning.entity} ${id}: ${verb}`);
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: could not resolve ${id} — ${msg}`);
    process.exit(1);
  }
}

export function runStale(subcommand: string | undefined, arg: string | undefined, options: StaleOptions = {}): void {
  const effective = subcommand ?? 'list';
  switch (effective) {
    case 'list':
      runStaleList(options);
      return;
    case 'resolve': {
      if (!arg) {
        console.error('Error: `brainclaw stale resolve <id>` requires an entity id.');
        process.exit(1);
      }
      runStaleResolve(arg, options);
      return;
    }
    default:
      console.error(`Error: unknown subcommand '${effective}'. Use: list | resolve <id>.`);
      process.exit(1);
  }
}
