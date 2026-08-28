/**
 * Implementation-loop `bind` is an engine-only transition.
 *
 * It validates the sequence link and advances `bind -> execute`; it never
 * creates assignments or starts workers. Worker-backed implementation turns
 * must cross the common `dispatchLoopTurn` seam (`turn(dispatch=true)`), which
 * is where AttemptAuthority, execution-contract, claim and run fencing live.
 *
 * The historical launch-shaped inputs and result fields remain accepted so
 * callers can roll forward without a schema break. They are intentionally
 * inert and reported as a compatibility warning.
 */
import type { DispatchResult } from '../dispatcher.js';
import { loadSequence } from '../sequence.js';
import { loadState } from '../state.js';
import type { LoopSlot } from './types.js';
import { withLoopLock } from './lock.js';
import { getLoop } from './store.js';
import { advance } from './verbs.js';

export interface RunImplBindInput {
  loop_id: string;
  /** Coordinator identity recorded on the bind transition. */
  dispatcherAgent: string;
  /** Retained for input compatibility; bind no longer dispatches. */
  dispatcherAgentId?: string;
  /** Retained for input compatibility; bind no longer dispatches. */
  sessionId?: string;
  /** Preview validation only: no phase mutation. */
  dryRun?: boolean;
  /** @deprecated Retained for compatibility; use turn(dispatch=true). */
  lanes?: string[];
  /** @deprecated Retained for compatibility; use turn(dispatch=true). */
  autoExecute?: boolean;
  /** @deprecated Retained for compatibility; use turn(dispatch=true). */
  model?: string;
  /** @deprecated Retained for compatibility; use turn(dispatch=true). */
  maxAssignments?: number;
}

export interface ImplBindResult {
  loop_id: string;
  sequence_id: string;
  action: 'bound' | 'preview' | 'noop';
  /** Phase after the bind->execute advance (omitted for preview/noop). */
  advanced_to?: string;
  auto_closed?: boolean;
  /** Compatibility field. Always null because bind is engine-only. */
  dispatch: DispatchResult | null;
  /** Compatibility field. Always zero because bind is engine-only. */
  messages_sent: number;
  warnings: string[];
  reason: string;
  lanes?: Array<{ lane: string; slot_id: string; scope_hint?: string }>;
}

type SlotBinding = Pick<LoopSlot, 'lane' | 'scope_hint' | 'plan_ids' | 'step_ids'>;

function deriveBindings(loop: ReturnType<typeof getLoop>, sequenceId: string, cwd?: string): Record<string, SlotBinding> {
  if (!loop) throw new Error('implementation loop disappeared during bind');
  const sequence = loadSequence(sequenceId, cwd);
  if (sequence.items.length === 0) throw new Error(`linked sequence ${sequenceId} has no items`);
  const linkedPlans = new Set(loop.linked?.plan_ids ?? []);
  if (linkedPlans.size === 0) {
    throw new Error(`impl-bind requires linked.plan_ids in addition to linked.sequence_ids`);
  }
  const plans = new Map(loadState(cwd).plan_items.map((plan) => [plan.id, plan]));
  for (const item of sequence.items) {
    if (!linkedPlans.has(item.planId)) {
      throw new Error(`sequence item rank ${item.rank} references unlinked plan ${item.planId}`);
    }
    const plan = plans.get(item.planId);
    if (!plan) throw new Error(`linked sequence ${sequenceId} references missing plan ${item.planId}`);
    if (item.stepId && !(plan.steps ?? []).some((step) => step.id === item.stepId)) {
      throw new Error(`sequence item rank ${item.rank} references missing step ${item.stepId} on plan ${item.planId}`);
    }
  }

  const grouped = new Map<string, typeof sequence.items>();
  for (const item of sequence.items) {
    const lane = item.lane?.trim() || 'default';
    grouped.set(lane, [...(grouped.get(lane) ?? []), item]);
  }
  const lanes = [...grouped.keys()].sort();
  if (loop.slots.length !== lanes.length) {
    throw new Error(
      `impl-bind lane/slot mismatch: sequence ${sequenceId} has ${lanes.length} lane(s) (${lanes.join(', ')}) but loop has ${loop.slots.length} slot(s); open one worker slot per lane`,
    );
  }
  // A positional fallback is unsafe here: callers commonly attach a
  // perspective to a slot, and silently pairing that perspective with a
  // different alphabetically-sorted lane can invert the lane's scope policy.
  // Single-lane sequences retain the historical default-slot convenience;
  // multi-lane binds must carry an explicit, unique lane on every slot.
  if (lanes.length > 1) {
    const slotLanes = loop.slots.map((slot) => slot.lane?.trim() || '');
    if (slotLanes.some((lane) => !lane)) {
      throw new Error(
        `impl-bind requires explicit slot.lane for every lane when binding multiple lanes (${lanes.join(', ')}); positional slot order is rejected to prevent lane permutation`,
      );
    }
    const uniqueSlotLanes = new Set(slotLanes);
    if (uniqueSlotLanes.size !== slotLanes.length || uniqueSlotLanes.size !== lanes.length) {
      throw new Error(
        `impl-bind requires one unique slot.lane per sequence lane; slots=${slotLanes.join(', ')}, lanes=${lanes.join(', ')}`,
      );
    }
    const unknown = slotLanes.filter((lane) => !grouped.has(lane));
    if (unknown.length > 0) {
      throw new Error(
        `impl-bind slot lane(s) not present in sequence ${sequenceId}: ${unknown.join(', ')}; expected ${lanes.join(', ')}`,
      );
    }
  }
  const bindings: Record<string, SlotBinding> = {};
  loop.slots.forEach((slot, index) => {
    const lane = lanes.length > 1 ? slot.lane!.trim() : (slot.lane?.trim() || lanes[index]!);
    const items = grouped.get(lane)!;
    const scopes = [...new Set(items.map((item) => item.scope_hint?.trim()).filter((value): value is string => Boolean(value)))];
    bindings[slot.slot_id] = {
      lane,
      scope_hint: scopes.length > 0 ? scopes.join(', ') : undefined,
      plan_ids: [...new Set(items.map((item) => item.planId))],
      step_ids: [...new Set(items.flatMap((item) => item.stepId ? [item.stepId] : []))],
    };
  });
  return bindings;
}

const ENGINE_ONLY_WARNING =
  'implementation bind is engine-only and does not dispatch workers; use bclaw_loop(intent="turn", dispatch=true, slot_id=...) in execute';

function compatibilityWarnings(input: RunImplBindInput): string[] {
  const usedLaunchOption = input.lanes !== undefined
    || input.autoExecute !== undefined
    || input.model !== undefined
    || input.maxAssignments !== undefined;
  return usedLaunchOption
    ? [`${ENGINE_ONLY_WARNING}; bind launch options are retained but ignored`]
    : [ENGINE_ONLY_WARNING];
}

/**
 * Validate an implementation loop's linked sequence and advance to execute.
 *
 * Idempotent: a loop already past `bind` returns `noop`. The phase re-check and
 * advance happen under the loop lock, so racing bind calls cannot advance twice.
 */
export async function runImplBind(input: RunImplBindInput, cwd?: string): Promise<ImplBindResult> {
  const { loop_id, dispatcherAgent } = input;
  const loop = getLoop(loop_id, cwd);
  if (!loop) throw new Error(`unknown loop_id ${loop_id}`);
  if (loop.kind !== 'implementation') {
    throw new Error(
      `bind is only valid for implementation loops (loop ${loop_id} is kind='${loop.kind}'); review/ideation loops dispatch via bclaw_coordinate`,
    );
  }
  if (loop.status !== 'open') {
    throw new Error(
      `bind requires an open loop; loop ${loop_id} is ${loop.status} (resume a paused loop, or reopen a terminal one, before binding)`,
    );
  }

  const sequenceId = loop.linked?.sequence_ids?.[0];
  if (loop.current_phase !== 'bind') {
    return {
      loop_id,
      sequence_id: sequenceId ?? '',
      action: 'noop',
      dispatch: null,
      messages_sent: 0,
      warnings: compatibilityWarnings(input),
      reason: `loop is in phase '${loop.current_phase}', not 'bind' - already bound (idempotent)`,
    };
  }
  if (!sequenceId) {
    throw new Error(
      `impl-bind requires a linked sequence: open the implementation loop with linked.sequence_ids=[...] (the sequence whose lanes it executes). None found on ${loop_id}.`,
    );
  }
  let bindings: Record<string, SlotBinding>;
  try { bindings = deriveBindings(loop, sequenceId, cwd); }
  catch (error) {
    throw new Error(
      `impl-bind validation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (input.dryRun) {
    return {
      loop_id,
      sequence_id: sequenceId,
      action: 'preview',
      dispatch: null,
      messages_sent: 0,
      warnings: compatibilityWarnings(input),
      reason: `dry run: linked sequence ${sequenceId} is valid; loop stays in 'bind' and no worker is dispatched`,
      lanes: Object.entries(bindings).map(([slot_id, binding]) => ({ slot_id, lane: binding.lane!, scope_hint: binding.scope_hint })),
    };
  }

  const advanced = withLoopLock<{ phase: string; auto_closed: boolean } | null>({
    cwd,
    intent: 'impl-bind-advance',
    agentId: dispatcherAgent,
    scope: { kind: 'loop', loopId: loop_id },
    work: () => {
      const fresh = getLoop(loop_id, cwd);
      if (!fresh || fresh.status !== 'open' || fresh.current_phase !== 'bind') return null;
      const freshSequenceId = fresh.linked?.sequence_ids?.[0];
      if (freshSequenceId !== sequenceId) {
        throw new Error(`linked sequence ${sequenceId} changed or disappeared before bind could advance`);
      }
      const freshBindings = deriveBindings(fresh, sequenceId, cwd);
      const result = advance({ id: loop_id, actor: dispatcherAgent, slot_bindings: freshBindings }, cwd);
      return { phase: result.loop.current_phase, auto_closed: result.auto_closed };
    },
  });

  if (!advanced) {
    return {
      loop_id,
      sequence_id: sequenceId,
      action: 'noop',
      dispatch: null,
      messages_sent: 0,
      warnings: compatibilityWarnings(input),
      reason: `phase already advanced out of 'bind' under a concurrent bind (idempotent - not re-advanced)`,
    };
  }
  return {
    loop_id,
    sequence_id: sequenceId,
    action: 'bound',
    advanced_to: advanced.phase,
    auto_closed: advanced.auto_closed,
    dispatch: null,
    messages_sent: 0,
    warnings: compatibilityWarnings(input),
    reason: `validated linked sequence ${sequenceId}; advanced bind -> ${advanced.phase}; dispatch worker slots with turn(dispatch=true)`,
    lanes: Object.entries(bindings).map(([slot_id, binding]) => ({ slot_id, lane: binding.lane!, scope_hint: binding.scope_hint })),
  };
}
