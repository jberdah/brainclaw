import { ZodError } from 'zod';
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
} from '../core/loops/index.js';
import {
  BclawLoopRequestSchema,
  BCLAW_LOOP_INTENTS,
  type BclawLoopIntent,
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
type LoopEventSnapshot = Set<string>;
type NextExpectedHint = {
  action: 'turn' | 'complete_turn' | 'advance' | 'close';
  intent: string;
  reason?: string;
  phase?: string;
  slot_id?: string;
  role?: string;
  from_phase?: string;
  to_phase?: string;
  blocking_on: string[];
};

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

function inferIntent(args: unknown): BclawLoopIntent | 'unknown' {
  if (!args || typeof args !== 'object') return 'unknown';
  const candidate = (args as { intent?: unknown }).intent;
  if (typeof candidate !== 'string') return 'unknown';
  return (BCLAW_LOOP_INTENTS as readonly string[]).includes(candidate)
    ? (candidate as BclawLoopIntent)
    : 'unknown';
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

function snapshotLoopEvents(loopId: string, cwd?: string): LoopEventSnapshot {
  return new Set(listLoopEvents(loopId, cwd).map((event) => event.event_id));
}

function findNewLoopEvents(loopId: string, before: LoopEventSnapshot | undefined, cwd?: string): LoopEvent[] {
  const events = listLoopEvents(loopId, cwd);
  if (!before) return events;
  return events.filter((event) => !before.has(event.event_id));
}

function loopEventArtifacts(events: LoopEvent[]): FacadeResponse['artifacts'] {
  return events.map((event) => loopEventArtifactEntry(event.event_id));
}

function loopEventSideEffects(events: LoopEvent[]): FacadeResponse['side_effects'] {
  return events.map((event) => sideEffectCreate('loop_event', event.event_id));
}

function getDeferredFieldWarnings(req: ValidRequest): string[] {
  if (req.intent === 'get' || req.intent === 'list') return [];
  const warnings: string[] = [];
  if ('expected_version' in req && typeof req.expected_version === 'number') {
    warnings.push('expected_version is accepted for RFC compatibility but not enforced until lock/CAS wiring lands.');
  }
  if (typeof req.client_request_id === 'string' && req.client_request_id.length > 0) {
    warnings.push('client_request_id is accepted for RFC compatibility but not enforced until lock/idempotency wiring lands.');
  }
  return warnings;
}

function validateSemanticRequest(req: ValidRequest): string | null {
  if (req.intent === 'turn' && !req.slot_id && !req.role) {
    return 'turn requires slot_id or role';
  }
  return null;
}

/**
 * `NextExpectedHint` — self-describing hint to the caller about the most
 * natural next intent. Kept conservative for the MVP: we look at the loop's
 * status + slot states and pick the smallest correct action.
 */
function computeNextExpected(loop: LoopThread): {
  action: NextExpectedHint['action'];
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
      action: 'complete_turn',
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
  const inferredIntent = inferIntent(options.args);
  const parseResult = BclawLoopRequestSchema.safeParse(options.args);
  if (!parseResult.success) {
    return errorResponse(inferredIntent, 'validation_error', parseResult.error.message, Date.now() - startMs);
  }
  const req: ValidRequest = parseResult.data;
  const semanticError = validateSemanticRequest(req);
  if (semanticError) {
    return errorResponse(req.intent, 'validation_error', semanticError, Date.now() - startMs);
  }
  const { actor, agentId } = resolveActor(req, defaultActor);
  const deferredFieldWarnings = getDeferredFieldWarnings(req);

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
        const newEvents = findNewLoopEvents(loop.id, undefined, options.cwd);
        return successResponse(
          'open',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectCreate('loop', loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
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
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
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
        const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
        return successResponse(
          'turn',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'complete_turn': {
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
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
                  ref: req.artifact.ref,
                }
              : undefined,
            actor,
            caller_agent_id: req.agentId,
          },
          options.cwd,
        );
        const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
        return successResponse(
          'complete_turn',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'advance': {
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
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
        const newEvents = findNewLoopEvents(result.loop.id, beforeEvents, options.cwd);
        return successResponse(
          'advance',
          { loop: result.loop, auto_closed: result.auto_closed, next_expected: computeNextExpected(result.loop) },
          [loopArtifactEntry(result.loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', result.loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
          Date.now() - startMs,
          summarizeLoop(result.loop, result.auto_closed),
        );
      }

      case 'add_artifact': {
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
        const loop = add_artifact(
          {
            id: req.loop_id,
            artifact: {
              phase: req.artifact.phase,
              type: req.artifact.type,
              body: req.artifact.body,
              produced_by: req.artifact.produced_by,
              ref: req.artifact.ref,
            },
            actor,
          },
          options.cwd,
        );
        const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
        return successResponse(
          'add_artifact',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'pause': {
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
        const loop = pause({ id: req.loop_id, reason: req.reason, actor }, options.cwd);
        const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
        return successResponse(
          'pause',
          { loop, next_expected: null },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'resume': {
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
        const loop = resume({ id: req.loop_id, actor }, options.cwd);
        const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
        return successResponse(
          'resume',
          { loop, next_expected: computeNextExpected(loop) },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }

      case 'close': {
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
        const loop = closeLoop(
          { id: req.loop_id, final_status: req.status, reason: req.reason, actor },
          options.cwd,
        );
        const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
        return successResponse(
          'close',
          { loop, next_expected: null },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
          deferredFieldWarnings,
          Date.now() - startMs,
          summarizeLoop(loop),
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return errorResponse(req.intent, 'validation_error', err.message, Date.now() - startMs);
    }
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
