/**
 * pln#634 — outcome-derived `next_actions` builders.
 *
 * `NextActionSchema` has existed since pln#542, but only `bclaw_work`,
 * `bclaw_find`, `bclaw_search`, `bclaw_read_inbox` and `bclaw_quick_capture`
 * ever emitted it: the write surfaces an agent hits *while working* (coordinate,
 * dispatch, release_claim, transition, create) returned pure data and left the
 * agent to infer the protocol. That inference is exactly where behaviour
 * diverges between agent hosts (ideation lop_47b62c26f03acf4c).
 *
 * DESIGN RULE — every builder here takes the REAL outcome and returns `[]` when
 * there is no genuine follow-up. There are deliberately no per-tool static
 * tables: an action that does not follow from what actually happened is noise,
 * and noise teaches agents to ignore the field, which is strictly worse than an
 * absent field. Callers omit the key entirely when the array is empty.
 *
 * SECOND RULE — never suggest an MCP call for work that is not MCP-callable. A
 * manual launch command belongs in the text body, not in `next_actions`.
 *
 * @module
 */
import type { NextAction } from './facade-schema.js';

/**
 * Verifying a spawned worker: always `bclaw_dispatch_status`, never
 * `bclaw_find(agent_run)` + a pid check. On Windows an ack-wrapped spawn runs
 * under cmd.exe, so `agent_run.pid` is the wrapper (which exits by design) and
 * reads dead while the worker is alive (trp_7fc3e3c4). `dispatch_status`
 * returns a sentinel-based verdict instead.
 */
export function verifyDispatchAction(targetId: string, note?: string): NextAction {
  return {
    tool: 'bclaw_dispatch_status',
    args: { target_id: targetId },
    when: note
      ? `${note} — sentinel-based liveness verdict (do NOT judge from agent_run.pid)`
      : 'verify the spawned worker is actually alive — sentinel-based verdict (do NOT judge from agent_run.pid)',
  };
}

/** Cap on repeated per-target actions, so a wide fan-out cannot flood the field. */
const FANOUT_CAP = 3;

function verifyActions(targetIds: readonly string[], note?: string): NextAction[] {
  const shown = targetIds.slice(0, FANOUT_CAP);
  const actions = shown.map((id) => verifyDispatchAction(id, note));
  if (targetIds.length > shown.length) {
    // Say what was dropped rather than silently truncating.
    actions.push({
      tool: 'bclaw_dispatch_status',
      args: { target_id: '<one of the remaining targets>' },
      when: `${targetIds.length - shown.length} further target(s) were dispatched — verify each one the same way`,
    });
  }
  return actions;
}

export interface ReleaseClaimOutcome {
  claimId: string;
  planId?: string;
  /** True when the cascade actually moved the linked plan. */
  planTransitioned: boolean;
  /** Set when the plan was deliberately NOT transitioned (other claims still active). */
  planWarning?: string;
  /** Status the caller asked the plan to reach, when they asked for one. */
  requestedPlanStatus?: string;
}

/**
 * After a release, the follow-up depends entirely on what the cascade decided:
 * a blocked plan transition needs the other claim holders inspected, a
 * completed plan is ready for review, and a plain release has no next step at
 * all.
 */
export function releaseClaimNextActions(outcome: ReleaseClaimOutcome): NextAction[] {
  const actions: NextAction[] = [];
  if (outcome.planWarning && outcome.planId) {
    // The cascade refused: other claims still hold the plan. Both the diagnosis
    // and the eventual manual transition are real MCP calls.
    actions.push({
      tool: 'bclaw_find',
      args: { entity: 'claim', filter: { plan_id: outcome.planId, status: 'active' } },
      when: 'the plan was NOT transitioned because other claims are still active — see who else holds it',
    });
    actions.push({
      tool: 'bclaw_transition',
      args: { entity: 'plan', id: outcome.planId, to: outcome.requestedPlanStatus ?? 'done' },
      when: 'once the other claims are released, transition the plan yourself',
    });
    return actions;
  }
  if (outcome.planTransitioned && outcome.planId) {
    // Documented workflow: implement → release → review.
    actions.push({
      tool: 'bclaw_coordinate',
      args: {
        intent: 'review',
        task: `Review the work delivered under plan ${outcome.planId}`,
        open_loop: true,
      },
      when: 'the plan is done — the next workflow stage is review',
    });
  }
  return actions;
}

export interface TransitionOutcome {
  entity: string;
  id: string;
  to: string;
}

/**
 * Only two transitions imply an unambiguous next call. Everything else
 * (candidate accepted, plan done, trap retired, …) is terminal for the caller,
 * so it returns nothing rather than inventing busywork.
 */
export function transitionNextActions(outcome: TransitionOutcome): NextAction[] {
  if (outcome.entity === 'plan' && outcome.to === 'in_progress') {
    return [{
      tool: 'bclaw_work',
      args: { intent: 'execute', planId: outcome.id, scope: '<scope you are about to edit>' },
      when: 'the plan is in progress — claim the scope before editing',
    }];
  }
  if (outcome.entity === 'plan' && outcome.to === 'blocked') {
    return [{
      tool: 'bclaw_quick_capture',
      args: { text: '<what blocks this plan>', type: 'trap' },
      when: 'record WHY it is blocked so the next agent does not rediscover it',
    }];
  }
  return [];
}

export interface CoordinateOutcome {
  intent: string;
  /** Assignment ids created by this call, in delivery order. */
  assignmentIds: readonly string[];
  loopId?: string;
  candidateId?: string;
  /** Facade `execution_status`, when the intent spawns. */
  executionStatus?: string;
}

/**
 * Coordinate's follow-up is driven by whether anything actually spawned, not by
 * the intent alone: the same `intent='assign'` needs verification when it
 * spawned and nothing MCP-callable when it produced manual commands.
 */
export function coordinateNextActions(outcome: CoordinateOutcome): NextAction[] {
  const actions: NextAction[] = [];
  const spawned = outcome.executionStatus === 'delivered_and_started';

  if (spawned && outcome.assignmentIds.length > 0) {
    actions.push(...verifyActions(outcome.assignmentIds));
  }

  if (outcome.loopId) {
    actions.push({
      tool: 'bclaw_loop',
      args: { intent: 'get', loop_id: outcome.loopId },
      when: spawned
        ? 'inspect loop state — its `next_expected` names the turn the loop is waiting on'
        : 'the loop is open but nothing spawned — inspect it and drive the turn yourself',
    });
  }

  // Manual-handoff spawning intents: the launch commands are in the text body
  // (not MCP-callable), so the only real MCP follow-up is verification AFTER
  // the operator runs them.
  if (!spawned && outcome.executionStatus === 'command_ready_manual' && outcome.assignmentIds.length > 0) {
    actions.push(verifyActions(outcome.assignmentIds, 'once you have run the launch command(s) printed above')[0]);
  }

  return actions;
}

export interface DispatchOutcome {
  spawnedTargets: readonly string[];
  blockedCount: number;
  dryRun: boolean;
}

export function dispatchNextActions(outcome: DispatchOutcome): NextAction[] {
  if (outcome.dryRun) {
    return [{
      tool: 'bclaw_dispatch',
      args: { intent: 'execute' },
      when: 'this was a dry run — nothing was dispatched; re-run without dryRun to actually spawn',
    }];
  }
  const actions: NextAction[] = [];
  if (outcome.spawnedTargets.length > 0) {
    actions.push(...verifyActions(outcome.spawnedTargets));
  }
  if (outcome.blockedCount > 0) {
    actions.push({
      tool: 'bclaw_dispatch',
      args: { intent: 'analysis' },
      when: `${outcome.blockedCount} lane(s) are blocked — analysis explains which gate holds each one`,
    });
  }
  return actions;
}

export interface CreateEntityOutcome {
  entity: string;
  id: string;
}

export function createEntityNextActions(outcome: CreateEntityOutcome): NextAction[] {
  if (outcome.entity === 'plan') {
    return [{
      tool: 'bclaw_add_step',
      args: { planId: outcome.id, data: { text: '<first unit of work>' } },
      when: 'break the plan into steps so progress is trackable',
    }];
  }
  if (outcome.entity === 'sequence') {
    return [{
      tool: 'bclaw_dispatch',
      args: { intent: 'analysis' },
      when: 'inspect lane readiness before dispatching the sequence',
    }];
  }
  return [];
}
