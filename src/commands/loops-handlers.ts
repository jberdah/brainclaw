import type { FacadeResponse } from '../core/facade-schema.js';
import {
  add_artifact,
  advance,
  closeLoop,
  complete_turn,
  getLoop,
  listLoopEvents,
  listLoops,
  openLoop,
  pause,
  resume,
  turn,
  type LoopEvent,
  type LoopPhase,
  type LoopSlot,
  type LoopThread,
  type LoopRef,
} from '../core/loops/index.js';
import {
  BclawLoopRequestSchema,
  type BclawLoopRequest,
} from '../core/loops/facade-schema.js';

export interface HandleBclawLoopOptions {
  args: unknown;
  cwd?: string;
  /**
   * Optional actor fallback used when the caller omits `agent`/`agentId`.
   * Defaults to "bclaw_loop" to make origin traceable in the event journal.
   */
  defaultActor?: string;
}

export interface HandleBclawLoopResult {
  response: FacadeResponse;
  summary: string;
}

type ValidRequest = BclawLoopRequest;

function resolveActor(
  req: { agent?: string; agentId?: string },
  defaultActor: string,
): { actor: string; agentId: string } {
  const agentId = req.agentId?.trim() || defaultActor;
  const actor = req.agent?.trim() || req.agentId?.trim() || defaultActor;
  return { actor, agentId };
}

function successResponse(
  intent: string,
  result: unknown,
  artifacts: FacadeResponse['artifacts'],
  side_effects: FacadeResponse['side_effects'],
  warnings: string[],
  durationMs: number,
  summary: string,
): HandleBclawLoopResult {
  return {
    response: {
      status: 'ok',
      intent: `bclaw_loop.${intent}`,
      result,
      artifacts,
      side_effects,
      warnings,
      duration_ms: durationMs,
    },
    summary,
  };
}

function errorResponse(
  intent: string,
  code: string,
  message: string,
  durationMs: number,
): HandleBclawLoopResult {
  return {
    response: {
      status: 'error',
      intent: `bclaw_loop.${intent}`,
      result: null,
      artifacts: [],
      side_effects: [],
      warnings: [],
      error: `${code}: ${message}`,
      duration_ms: durationMs,
    },
    summary: `✘ bclaw_loop[${intent}] ${code}: ${message}`,
  };
}

function loopArtifactEntry(id: string): FacadeResponse['artifacts'][number] {
  return { type: 'loop', id };
}

function loopEventArtifactEntry(id: string): FacadeResponse['artifacts'][number] {
  return { type: 'loop_event', id };
}

function sideEffectCreate(entity: 'loop' | 'loop_event', id: string): FacadeResponse['side_effects'][number] {
  return { action: 'create', entity, id };
}

function sideEffectUpdate(entity: 'loop' | 'loop_event', id: string): FacadeResponse['side_effects'][number] {
  return { action: 'update', entity, id };
}

function latestEventSideEffect(loop: LoopThread, cwd?: string): FacadeResponse['side_effects'][number] | null {
  const events = listLoopEvents(loop.id, cwd);
  const last = events[events.length - 1];
  if (!last) return null;
  return sideEffectCreate('loop_event', last.event_id);
}

function latestEventArtifact(loop: LoopThread, cwd?: string): FacadeResponse['artifacts'][number] | null {
  const events = listLoopEvents(loop.id, cwd);
  const last = events[events.length - 1];
  if (!last) return null;
  return loopEventArtifactEntry(last.event_id);
}

/**
 * `NextExpectedHint` — self-describing hint to the caller about the most
 * natural next intent. Kept conservative for the MVP: we look at the loop's
 * status + slot states and pick the smallest correct action.
 */
function computeNextExpected(loop: LoopThread): {
  action: 'turn' | 'advance' | 'close';
  intent: string;
  reason?: string;
  phase?: string;
  slot_id?: string;
  role?: string;
  from_phase?: string;
  to_phase?: string;
  blocking_on: string[];
} | null {
  if (loop.status === 'completed' || loop.status === 'cancelled' || loop.status === 'blocked') {
    return null;
  }
  if (loop.status === 'paused') {
    return null;
  }

  const currentPhaseSlots: LoopSlot[] = loop.slots.filter(
    (s: LoopSlot) => (s.phase ?? loop.current_phase) === loop.current_phase,
  );
  const openSlots: LoopSlot[] = currentPhaseSlots.filter((s: LoopSlot) => s.status === 'open');
  if (openSlots.length > 0) {
    const first = openSlots[0];
    return {
      action: 'turn',
      intent: 'bclaw_loop.turn',
      phase: loop.current_phase,
      slot_id: first.slot_id,
      role: first.role,
      blocking_on: openSlots.map((s: LoopSlot) => s.slot_id),
    };
  }

  const assignedOrWorking: LoopSlot[] = currentPhaseSlots.filter(
    (s: LoopSlot) => s.status === 'assigned' || s.status === 'working',
  );
  if (assignedOrWorking.length > 0) {
    return {
      action: 'turn',
      intent: 'bclaw_loop.complete_turn',
      phase: loop.current_phase,
      slot_id: assignedOrWorking[0].slot_id,
      role: assignedOrWorking[0].role,
      blocking_on: assignedOrWorking.map((s: LoopSlot) => s.slot_id),
    };
  }

  const phaseNames: string[] = loop.phases.map((p: LoopPhase) => p.name);
  const currentIndex = phaseNames.indexOf(loop.current_phase);
  if (currentIndex >= 0 && currentIndex + 1 < phaseNames.length) {
    return {
      action: 'advance',
      intent: 'bclaw_loop.advance',
      from_phase: loop.current_phase,
      to_phase: phaseNames[currentIndex + 1],
      blocking_on: [],
    };
  }

  return {
    action: 'close',
    intent: 'bclaw_loop.close',
    reason: 'terminal_phase_reached',
    blocking_on: [],
  };
}

function summarizeLoop(loop: LoopThread, autoClosed?: boolean): string {
  const suffix = autoClosed ? ' (auto-closed)' : '';
  return `✔ loop ${loop.id} [${loop.kind}] phase=${loop.current_phase} status=${loop.status}${suffix}`;
}

export function handleBclawLoop(options: HandleBclawLoopOptions): HandleBclawLoopResult {
  const startMs = Date.now();
  const defaultActor = options.defaultActor ?? 'bclaw_loop';
  const parseResult = BclawLoopRequestSchema.safeParse(options.args);
  if (!parseResult.success) {
    return errorResponse('unknown', 'validation_error', parseResult.error.message, Date.now() - startMs);
  }
  const req: ValidRequest = parseResult.data;
  const { actor, agentId } = resolveActor(req, defaultActor);

  try {
    switch (req.intent) {
      case 'open': {
        const loop = openLoop(
          {
            kind: req.kind,
            title: req.title,
            goal: req.goal,
            phases: req.phases,
            slots: req.slots,
            linked: req.linked,
            stop_condition: req.stop_condition,
            mode: req.mode,
            created_by: agentId,
          },
          options.cwd,
        );
        const eventSE = latestEventSideEffect(loop, options.cwd);
        const eventArt = latestEventArtifact(loop, options.cwd);
        return successResponse(
          'open',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id), ...(eventArt ? [eventArt] : [])],
          [sideEffectCreate('loop', loop.id), ...(eventSE ? [eventSE] : [])],
          [],
          Date.now() - startMs,
          `✔ opened ${loop.id} [${loop.kind}] phase=${loop.current_phase}`,
        );
      }

      case 'get': {
        const loop = getLoop(req.loop_id, options.cwd);
        if (!loop) {
          return errorResponse('get', 'not_found', `unknown loop_id ${req.loop_id}`, Date.now() - startMs);
        }
        const events = req.include_events ? listLoopEvents(req.loop_id, options.cwd) : undefined;
        return successResponse(
          'get',
          { loop, events, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id)],
          [],
          [],
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'list': {
        const loops = listLoops({ kind: req.kind, status: req.status }, options.cwd);
        const sliced = typeof req.offset === 'number' || typeof req.limit === 'number'
          ? loops.slice(req.offset ?? 0, (req.offset ?? 0) + (req.limit ?? loops.length))
          : loops;
        return successResponse(
          'list',
          { loops: sliced, total: loops.length },
          sliced.map((l) => loopArtifactEntry(l.id)),
          [],
          [],
          Date.now() - startMs,
          `✔ list ${sliced.length}/${loops.length} loops`,
        );
      }

      case 'turn': {
        const loop = turn(
          {
            id: req.loop_id,
            slot_id: req.slot_id,
            role: req.role,
            input: req.input,
            dispatch: req.dispatch,
            assignment_id: req.assignment_id,
            actor,
          },
          options.cwd,
        );
        const eventSE = latestEventSideEffect(loop, options.cwd);
        return successResponse(
          'turn',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id)],
          [sideEffectUpdate('loop', loop.id), ...(eventSE ? [eventSE] : [])],
          [],
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'complete_turn': {
        const loop = complete_turn(
          {
            id: req.loop_id,
            slot_id: req.slot_id,
            outcome: req.outcome,
            failure_reason: req.failure_reason,
            artifact: req.artifact
              ? {
                  phase: req.artifact.phase,
                  type: req.artifact.type,
                  body: req.artifact.body,
                  ref: req.artifact.ref as LoopRef | undefined,
                }
              : undefined,
            actor,
            caller_agent_id: req.agentId,
          },
          options.cwd,
        );
        const eventSE = latestEventSideEffect(loop, options.cwd);
        return successResponse(
          'complete_turn',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id)],
          [sideEffectUpdate('loop', loop.id), ...(eventSE ? [eventSE] : [])],
          [],
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'advance': {
        const result = advance(
          {
            id: req.loop_id,
            to_phase: req.to_phase,
            reason: req.reason,
            force: req.force,
            actor,
          },
          options.cwd,
        );
        const eventSE = latestEventSideEffect(result.loop, options.cwd);
        return successResponse(
          'advance',
          { loop: result.loop, auto_closed: result.auto_closed, next_expected: computeNextExpected(result.loop) },
          [loopArtifactEntry(result.loop.id)],
          [sideEffectUpdate('loop', result.loop.id), ...(eventSE ? [eventSE] : [])],
          [],
          Date.now() - startMs,
          summarizeLoop(result.loop, result.auto_closed),
        );
      }

      case 'add_artifact': {
        const loop = add_artifact(
          {
            id: req.loop_id,
            artifact: {
              phase: req.artifact.phase,
              type: req.artifact.type,
              body: req.artifact.body,
              produced_by: req.artifact.produced_by,
              ref: req.artifact.ref as LoopRef | undefined,
            },
            actor,
          },
          options.cwd,
        );
        const eventSE = latestEventSideEffect(loop, options.cwd);
        return successResponse(
          'add_artifact',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id)],
          [sideEffectUpdate('loop', loop.id), ...(eventSE ? [eventSE] : [])],
          [],
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'pause': {
        const loop = pause({ id: req.loop_id, reason: req.reason, actor }, options.cwd);
        return successResponse(
          'pause',
          { loop, next_expected: null },
          [loopArtifactEntry(loop.id)],
          [sideEffectUpdate('loop', loop.id)],
          [],
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'resume': {
        const loop = resume({ id: req.loop_id, actor }, options.cwd);
        return successResponse(
          'resume',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id)],
          [sideEffectUpdate('loop', loop.id)],
          [],
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'close': {
        const loop = closeLoop(
          { id: req.loop_id, final_status: req.status, reason: req.reason, actor },
          options.cwd,
        );
        return successResponse(
          'close',
          { loop, next_expected: null },
          [loopArtifactEntry(loop.id)],
          [sideEffectUpdate('loop', loop.id)],
          [],
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('unauthorized_slot_write')) {
      return errorResponse(req.intent, 'unauthorized_slot_write', message, Date.now() - startMs);
    }
    if (message.startsWith('unknown loop_id')) {
      return errorResponse(req.intent, 'not_found', message, Date.now() - startMs);
    }
    return errorResponse(req.intent, 'verb_error', message, Date.now() - startMs);
  }

  return errorResponse('unknown', 'unreachable', 'unexpected fallthrough', Date.now() - startMs);
}

export type { LoopEvent, LoopThread };
