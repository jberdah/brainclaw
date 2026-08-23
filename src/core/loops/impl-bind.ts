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
import { listSequences } from '../sequence.js';
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
  if (!listSequences(cwd).some((sequence) => sequence.id === sequenceId)) {
    throw new Error(`linked sequence ${sequenceId} not found for loop ${loop_id}`);
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
      if (freshSequenceId !== sequenceId
        || !listSequences(cwd).some((sequence) => sequence.id === sequenceId)) {
        throw new Error(`linked sequence ${sequenceId} changed or disappeared before bind could advance`);
      }
      const result = advance({ id: loop_id, actor: dispatcherAgent }, cwd);
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
  };
}
