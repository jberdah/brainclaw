import crypto from 'node:crypto';

import { nowISO } from '../ids.js';
import {
  appendEvent,
  generateMutationId,
  getLoop,
  listLoopEvents,
  writeThreadFile,
} from './store.js';
import {
  LoopArtifactSchema,
  type LoopArtifact,
  type LoopEvent,
  type LoopSlot,
  type LoopStatus,
  type LoopThread,
  type StopCondition,
} from './types.js';
import {
  decideNextPhase,
  type IterationProtocol,
  type NextPhaseDecision,
} from './iteration-engine.js';

function nextSeq(loopId: string, cwd?: string): number {
  const events = listLoopEvents(loopId, cwd);
  return (events[events.length - 1]?.seq ?? 0) + 1;
}

function assertMutable(thread: LoopThread, intent: string): void {
  if (thread.status === 'completed' || thread.status === 'cancelled' || thread.status === 'blocked') {
    throw new Error(`${intent}: loop ${thread.id} is already ${thread.status}`);
  }
}

function loadLoopOrThrow(id: string, cwd?: string): LoopThread {
  const loop = getLoop(id, cwd);
  if (!loop) throw new Error(`unknown loop_id ${id}`);
  return loop;
}

/* ========================= Stop-condition evaluator ======================= */

function isVerdictAccepted(artifact: LoopArtifact): boolean {
  if (artifact.type !== 'verdict') return false;
  const body = (artifact.body ?? '').trim().toLowerCase();
  return /^accepted(?:\b|[:\s])/.test(body);
}

export function evaluateStopCondition(thread: LoopThread, condition?: StopCondition): boolean {
  if (!condition) return false;
  switch (condition.kind) {
    case 'phase_reached':
      return thread.current_phase === condition.phase;
    case 'reviewer_green':
      return thread.artifacts.some(isVerdictAccepted);
    case 'max_iterations':
      return thread.iteration_count >= condition.n;
    case 'artifact_produced':
      return thread.artifacts.some(
        (artifact) => artifact.phase === condition.phase && artifact.type === condition.type,
      );
    case 'min_artifacts_by_type': {
      // pln#492 — count artifacts of `type` in the requested scope.
      // Phase scope counts artifacts whose phase matches the thread's
      // current_phase. When the thread is iterating (iteration_count > 0
      // OR any artifact carries an iteration field), phase scope is
      // refined to the current iteration window — that's what makes
      // "≥3 critiques in current critique round" work without the
      // previous round leaking in. loop scope counts across all phases
      // and all iterations.
      const matches = thread.artifacts.filter((artifact) => {
        if (artifact.type !== condition.type) return false;
        if (condition.scope === 'phase') {
          if (artifact.phase !== thread.current_phase) return false;
          // pln#492 phase 2.b — iteration-window awareness. If either the
          // thread or the artifact carries iteration info, only count the
          // artifacts produced in the thread's current iteration. Legacy
          // loops without iteration tracking are unaffected (both fields
          // default to 0).
          if (
            thread.iteration_count > 0 ||
            thread.artifacts.some((a) => a.iteration !== undefined)
          ) {
            const artifactIteration = artifact.iteration ?? 0;
            if (artifactIteration !== thread.iteration_count) return false;
          }
          return true;
        }
        return true;
      });
      return matches.length >= condition.n;
    }
    case 'manual':
      return false;
    case 'any':
      return condition.conditions.some((c) => evaluateStopCondition(thread, c));
    case 'all':
      return condition.conditions.every((c) => evaluateStopCondition(thread, c));
    default: {
      const exhaustive: never = condition;
      void exhaustive;
      return false;
    }
  }
}

/**
 * pln#492 — Phase-advance gate evaluator. Used by the iteration engine
 * (phase 2.b) to decide whether the driver may transition out of the
 * current phase.
 *
 * Returns a structured outcome:
 *   - `{ advance: true }` when no gate is set, or the gate evaluates true
 *   - `{ advance: false, gate_reason }` when the gate evaluates false. The
 *     `gate_reason` is a one-line description suitable for emission as
 *     the `phase_advance_blocked` system event payload.
 *
 * The gate uses the same StopCondition shape as `stop_condition` so
 * callers can compose any/all/min_artifacts_by_type/etc. with no new
 * vocabulary to learn.
 *
 * Phase 1 semantics: same artifact-counting as `evaluateStopCondition`
 * (no iteration-window awareness). The phase 2.b driver will refine
 * `min_artifacts_by_type{scope:'phase'}` to count only artifacts from
 * the current iteration of the cycle.
 */
export interface PhaseAdvanceOutcome {
  advance: boolean;
  gate_reason?: string;
}

export function evaluatePhaseAdvanceGate(
  thread: LoopThread,
  gate: StopCondition | undefined,
): PhaseAdvanceOutcome {
  if (!gate) return { advance: true };
  if (evaluateStopCondition(thread, gate)) return { advance: true };
  return {
    advance: false,
    gate_reason: describeUnmetGate(thread, gate),
  };
}

function describeUnmetGate(thread: LoopThread, gate: StopCondition): string {
  switch (gate.kind) {
    case 'min_artifacts_by_type': {
      // Mirror the iteration-aware filter used in evaluateStopCondition so
      // the message's count matches what the evaluator actually saw — the
      // operator should not see "count=4" in an error from a gate that
      // counted only iteration=1 artifacts.
      const iterationAware =
        thread.iteration_count > 0 ||
        thread.artifacts.some((a) => a.iteration !== undefined);
      const matches = thread.artifacts.filter((artifact) => {
        if (artifact.type !== gate.type) return false;
        if (gate.scope === 'phase') {
          if (artifact.phase !== thread.current_phase) return false;
          if (iterationAware) {
            const artifactIteration = artifact.iteration ?? 0;
            if (artifactIteration !== thread.iteration_count) return false;
          }
          return true;
        }
        return true;
      });
      return `min_artifacts_by_type unmet: ${gate.scope}-scope count of type "${gate.type}" = ${matches.length} < n=${gate.n}`;
    }
    case 'phase_reached':
      return `phase_reached unmet: current_phase="${thread.current_phase}" expected="${gate.phase}"`;
    case 'reviewer_green':
      return 'reviewer_green unmet: no accepted verdict artifact yet';
    case 'max_iterations':
      return `max_iterations unmet: iteration_count=${thread.iteration_count} < n=${gate.n}`;
    case 'artifact_produced':
      return `artifact_produced unmet: no artifact of type "${gate.type}" in phase "${gate.phase}"`;
    case 'manual':
      return 'manual gate: caller did not signal advance';
    case 'any':
      return `any-of unmet: none of ${gate.conditions.length} sub-conditions held`;
    case 'all':
      return `all-of unmet: at least one of ${gate.conditions.length} sub-conditions failed`;
    default: {
      const exhaustive: never = gate;
      void exhaustive;
      return 'unknown gate kind';
    }
  }
}

function stopHitsBlock(condition?: StopCondition): boolean {
  if (!condition) return false;
  if (condition.kind === 'max_iterations') return true;
  if (condition.kind === 'any' || condition.kind === 'all') {
    return condition.conditions.some(stopHitsBlock);
  }
  return false;
}

/* ============================== advance =================================== */

export interface AdvanceInput {
  id: string;
  to_phase?: string;
  reason?: string;
  force?: boolean;
  actor: string;
}

export interface AdvanceResult {
  loop: LoopThread;
  auto_closed: boolean;
}

export function advance(input: AdvanceInput, cwd?: string): AdvanceResult {
  const current = loadLoopOrThrow(input.id, cwd);
  assertMutable(current, 'advance');
  if (current.status === 'paused') {
    throw new Error(`advance: loop ${current.id} is paused; resume before advancing`);
  }

  const phaseNames = current.phases.map((p) => p.name);
  const currentIndex = phaseNames.indexOf(current.current_phase);
  if (currentIndex < 0) {
    throw new Error(`advance: current_phase "${current.current_phase}" is not in phases`);
  }

  // pln#492 phase 2.b — phase-advance gate check. Skipped when the caller
  // is forcing an explicit to_phase or passing { force: true }. On block,
  // emit a `phase_advance_blocked` system event into the journal and throw
  // an actionable error (not a silent hang — mitigates trp#160 wiring class).
  if (input.to_phase === undefined && input.force !== true) {
    const currentPhaseDef = current.phases[currentIndex];
    const gate = currentPhaseDef?.advance_gate;
    const gateOutcome = evaluatePhaseAdvanceGate(current, gate);
    if (!gateOutcome.advance) {
      const blockSeq = nextSeq(current.id, cwd);
      const blockMutation = generateMutationId();
      appendEvent(
        current.id,
        {
          event_id: crypto.randomUUID(),
          loop_id: current.id,
          seq: blockSeq,
          at: nowISO(),
          by: input.actor,
          mutation_id: blockMutation,
          kind: 'phase_advance_blocked',
          phase: current.current_phase,
          gate_reason: gateOutcome.gate_reason ?? 'gate evaluation returned no reason',
        },
        cwd,
      );
      throw new Error(
        `advance: phase_advance_blocked on "${current.current_phase}" — ${gateOutcome.gate_reason}`,
      );
    }
  }

  // Decide the next state. If the caller specified a to_phase, honour it
  // verbatim (used by `force`-style overrides and explicit jumps). Otherwise
  // consult the iteration engine, which knows about the cycle, exit_when,
  // and the iteration cap.
  let to_phase: string;
  let iteration_count = current.iteration_count;
  let iterationDecision: NextPhaseDecision | undefined;

  if (input.to_phase !== undefined) {
    if (!phaseNames.includes(input.to_phase)) {
      throw new Error(`advance: to_phase "${input.to_phase}" is not in phases`);
    }
    to_phase = input.to_phase;
    const toIndex = phaseNames.indexOf(to_phase);
    const iteratingBackward = toIndex <= currentIndex;
    // Going backward via explicit to_phase is allowed (it bumps the
    // iteration counter so callers can hand-roll their own iteration when
    // they don't have an iteration block defined). The forward-direction
    // restriction only applies when no to_phase is given.
    if (iteratingBackward) iteration_count = current.iteration_count + 1;
  } else {
    const protocol: IterationProtocol = {
      phases: current.phases,
      iteration: current.protocol?.iteration,
    };
    iterationDecision = decideNextPhase(current, protocol);
    to_phase = iterationDecision.target;
    iteration_count = iterationDecision.iteration;
  }

  if (evaluateStopCondition(current, current.stop_condition)) {
    const finalStatus: Exclude<LoopStatus, 'open' | 'paused'> = stopHitsMaxIterations(
      current,
      current.stop_condition,
    )
      ? 'blocked'
      : 'completed';
    const closed = commitClosedTransition(current, finalStatus, input.actor, input.reason, cwd);
    return { loop: closed, auto_closed: true };
  }

  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  let seq = nextSeq(current.id, cwd);

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    current_phase: to_phase,
    iteration_count,
    updated_at: now,
  };

  // pln#492 phase 2.b — when the iteration engine forces the cycle out
  // because the cap was hit, emit `max_iterations_reached` BEFORE the
  // phase_advanced event so the journal reads in causal order.
  if (iterationDecision?.kind === 'max_iterations') {
    appendEvent(
      current.id,
      {
        event_id: crypto.randomUUID(),
        loop_id: current.id,
        seq,
        at: now,
        by: input.actor,
        mutation_id,
        kind: 'max_iterations_reached',
        phase: current.current_phase,
        iteration: iterationDecision.iteration,
        max_iterations: iterationDecision.max,
      },
      cwd,
    );
    seq = nextSeq(current.id, cwd);
  }

  appendEvent(
    current.id,
    {
      event_id: crypto.randomUUID(),
      loop_id: current.id,
      seq,
      at: now,
      by: input.actor,
      mutation_id,
      kind: 'phase_advanced',
      from_phase: current.current_phase,
      to_phase,
      iteration: iteration_count,
      reason: input.reason,
    },
    cwd,
  );
  writeThreadFile(next, cwd);

  const postAdvance = evaluateStopCondition(next, next.stop_condition);
  if (postAdvance) {
    const finalStatus: Exclude<LoopStatus, 'open' | 'paused'> = stopHitsMaxIterations(
      next,
      next.stop_condition,
    )
      ? 'blocked'
      : 'completed';
    const closed = commitClosedTransition(next, finalStatus, input.actor, input.reason, cwd);
    return { loop: closed, auto_closed: true };
  }

  return { loop: next, auto_closed: false };
}

function stopHitsMaxIterations(thread: LoopThread, condition?: StopCondition): boolean {
  if (!condition) return false;
  if (!stopHitsBlock(condition)) return false;
  if (condition.kind === 'max_iterations') {
    return thread.iteration_count >= condition.n;
  }
  if (condition.kind === 'any' || condition.kind === 'all') {
    return condition.conditions.some((c) => stopHitsMaxIterations(thread, c));
  }
  return false;
}

function commitClosedTransition(
  thread: LoopThread,
  final_status: Exclude<LoopStatus, 'open' | 'paused'>,
  actor: string,
  reason: string | undefined,
  cwd: string | undefined,
): LoopThread {
  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = thread.version + 1;
  const seq = nextSeq(thread.id, cwd);
  const next: LoopThread = {
    ...thread,
    version,
    mutation_id,
    status: final_status,
    updated_at: now,
    closed_at: now,
  };
  appendEvent(
    thread.id,
    {
      event_id: crypto.randomUUID(),
      loop_id: thread.id,
      seq,
      at: now,
      by: actor,
      mutation_id,
      kind: 'closed',
      final_status,
      reason,
    },
    cwd,
  );
  writeThreadFile(next, cwd);
  return next;
}

/* ================================ turn ==================================== */

export interface TurnInput {
  id: string;
  slot_id?: string;
  role?: string;
  input?: string;
  dispatch?: boolean;
  assignment_id?: string;
  actor: string;
}

function resolveTurnSlot(thread: LoopThread, input: TurnInput): LoopSlot {
  if (input.slot_id) {
    const match = thread.slots.find((s) => s.slot_id === input.slot_id);
    if (!match) throw new Error(`turn: slot_id "${input.slot_id}" not in loop`);
    return match;
  }
  if (input.role) {
    const match = thread.slots.find((s) => s.role === input.role && s.status !== 'done');
    if (!match) throw new Error(`turn: no active slot with role "${input.role}"`);
    return match;
  }
  throw new Error(`turn: either slot_id or role must be supplied`);
}

export function turn(input: TurnInput, cwd?: string): LoopThread {
  const current = loadLoopOrThrow(input.id, cwd);
  assertMutable(current, 'turn');
  if (current.status === 'paused') throw new Error(`turn: loop ${current.id} is paused`);

  const targetSlot = resolveTurnSlot(current, input);
  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  const seq = nextSeq(current.id, cwd);

  const updatedSlots = current.slots.map((slot) =>
    slot.slot_id === targetSlot.slot_id
      ? {
          ...slot,
          status: 'assigned' as const,
          phase: current.current_phase,
          assignment_id: input.assignment_id ?? slot.assignment_id,
        }
      : slot,
  );

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    slots: updatedSlots,
    updated_at: now,
  };

  appendEvent(
    current.id,
    {
      event_id: crypto.randomUUID(),
      loop_id: current.id,
      seq,
      at: now,
      by: input.actor,
      mutation_id,
      kind: 'turn_assigned',
      slot_id: targetSlot.slot_id,
      phase: current.current_phase,
      assignment_id: input.assignment_id,
      input: input.input,
    },
    cwd,
  );
  writeThreadFile(next, cwd);
  return next;
}

/* ============================ complete_turn =============================== */

export interface CompleteTurnInput {
  id: string;
  slot_id: string;
  outcome?: 'done' | 'failed' | 'cancelled';
  artifact?: Omit<LoopArtifact, 'artifact_id' | 'produced_at' | 'produced_by'>;
  failure_reason?: string;
  actor: string;
  /** Override the slot-owner auth check. Default false. */
  admin_override?: boolean;
  /** For future MCP wiring: the caller's registered agent id. Used to enforce slot ownership. */
  caller_agent_id?: string;
}

export function complete_turn(input: CompleteTurnInput, cwd?: string): LoopThread {
  const current = loadLoopOrThrow(input.id, cwd);
  assertMutable(current, 'complete_turn');

  const slot = current.slots.find((s) => s.slot_id === input.slot_id);
  if (!slot) throw new Error(`complete_turn: slot_id "${input.slot_id}" not in loop`);

  // Slot-bound auth. Only enforced when caller_agent_id is supplied (MCP entry path).
  if (input.caller_agent_id !== undefined && !input.admin_override) {
    const ownerMatches = slot.agent_id !== undefined && slot.agent_id === input.caller_agent_id;
    const creatorMatches = current.created_by === input.caller_agent_id;
    if (!ownerMatches && !creatorMatches) {
      throw new Error('unauthorized_slot_write');
    }
  }

  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  const outcome: 'done' | 'failed' | 'cancelled' = input.outcome ?? 'done';

  let nextArtifacts = current.artifacts;
  let artifactId: string | undefined;
  if (input.artifact) {
    const newArtifact = LoopArtifactSchema.parse({
      ...input.artifact,
      artifact_id: `art_${crypto.randomBytes(6).toString('hex')}`,
      produced_by: slot.slot_id,
      produced_at: now,
    });
    artifactId = newArtifact.artifact_id;
    nextArtifacts = [...nextArtifacts, newArtifact];
  }

  // Map outcome → terminal slot.status so observers reading the thread can
  // distinguish done/failed/cancelled without replaying the event journal.
  const terminalStatus: 'done' | 'failed' | 'cancelled' = outcome;
  const updatedSlots = current.slots.map((s) =>
    s.slot_id === slot.slot_id ? { ...s, status: terminalStatus } : s,
  );

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    slots: updatedSlots,
    artifacts: nextArtifacts,
    updated_at: now,
  };

  const events: LoopEvent[] = [];
  if (artifactId && input.artifact) {
    events.push({
      event_id: crypto.randomUUID(),
      loop_id: current.id,
      seq: nextSeq(current.id, cwd),
      at: now,
      by: input.actor,
      mutation_id,
      kind: 'artifact_added',
      artifact_id: artifactId,
      phase: input.artifact.phase,
      type: input.artifact.type,
      produced_by: slot.slot_id,
    });
  }
  events.push({
    event_id: crypto.randomUUID(),
    loop_id: current.id,
    seq: nextSeq(current.id, cwd) + events.length,
    at: now,
    by: input.actor,
    mutation_id,
    kind: 'turn_completed',
    slot_id: slot.slot_id,
    phase: slot.phase ?? current.current_phase,
    artifact_id: artifactId,
    outcome,
    failure_reason: input.failure_reason,
  });

  for (const event of events) appendEvent(current.id, event, cwd);
  writeThreadFile(next, cwd);
  return next;
}

/* =========================== add_artifact ================================= */

export interface AddArtifactInput {
  id: string;
  artifact: Omit<LoopArtifact, 'artifact_id' | 'produced_at'>;
  actor: string;
}

export function add_artifact(input: AddArtifactInput, cwd?: string): LoopThread {
  const current = loadLoopOrThrow(input.id, cwd);
  assertMutable(current, 'add_artifact');

  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  const seq = nextSeq(current.id, cwd);

  // pln#492 phase 2.b — auto-populate iteration from the thread's current
  // iteration_count when the caller didn't supply one. Iterating loops get
  // accurate per-iteration counts without callers having to track the
  // index; non-iterating loops are unaffected because iteration_count
  // stays at 0.
  const newArtifact = LoopArtifactSchema.parse({
    ...input.artifact,
    artifact_id: `art_${crypto.randomBytes(6).toString('hex')}`,
    produced_at: now,
    iteration: input.artifact.iteration ?? current.iteration_count,
  });

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    artifacts: [...current.artifacts, newArtifact],
    updated_at: now,
  };

  appendEvent(
    current.id,
    {
      event_id: crypto.randomUUID(),
      loop_id: current.id,
      seq,
      at: now,
      by: input.actor,
      mutation_id,
      kind: 'artifact_added',
      artifact_id: newArtifact.artifact_id,
      phase: newArtifact.phase,
      type: newArtifact.type,
      produced_by: newArtifact.produced_by,
    },
    cwd,
  );
  writeThreadFile(next, cwd);
  return next;
}

/* =============================== pause / resume =========================== */

export interface PauseResumeInput {
  id: string;
  reason?: string;
  actor: string;
}

export function pause(input: PauseResumeInput, cwd?: string): LoopThread {
  const current = loadLoopOrThrow(input.id, cwd);
  if (current.status !== 'open') {
    throw new Error(`pause: loop ${current.id} is ${current.status}, not open`);
  }
  return commitSimpleStatus(current, 'paused', 'paused', input.actor, input.reason, cwd);
}

export function resume(input: PauseResumeInput, cwd?: string): LoopThread {
  const current = loadLoopOrThrow(input.id, cwd);
  if (current.status !== 'paused') {
    throw new Error(`resume: loop ${current.id} is ${current.status}, not paused`);
  }
  return commitSimpleStatus(current, 'open', 'resumed', input.actor, input.reason, cwd);
}

function commitSimpleStatus(
  current: LoopThread,
  newStatus: 'open' | 'paused',
  eventKind: 'paused' | 'resumed',
  actor: string,
  reason: string | undefined,
  cwd: string | undefined,
): LoopThread {
  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  const seq = nextSeq(current.id, cwd);
  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    status: newStatus,
    updated_at: now,
  };
  const base = {
    event_id: crypto.randomUUID(),
    loop_id: current.id,
    seq,
    at: now,
    by: actor,
    mutation_id,
  } as const;
  const event: LoopEvent =
    eventKind === 'paused'
      ? { ...base, kind: 'paused', reason }
      : { ...base, kind: 'resumed' };
  appendEvent(current.id, event, cwd);
  writeThreadFile(next, cwd);
  return next;
}
