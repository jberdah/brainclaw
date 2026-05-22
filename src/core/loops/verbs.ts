import crypto from 'node:crypto';

import { nowISO } from '../ids.js';
import { writeProjectMdSafe } from './hooks/bootstrap-write.js';
import {
  appendEvent,
  closeLoop,
  generateMutationId,
  getLoop,
  listLoopEvents,
  writeThreadFile,
} from './store.js';
import {
  LoopArtifactSchema,
  PAUSE_REASONS,
  type LoopArtifact,
  type LoopEvent,
  type LoopSlot,
  type LoopStatus,
  type LoopThread,
  type OnTimeoutPolicy,
  type OperatorAnswerBody,
  type OperatorQuestionBody,
  type OperatorQuestionOption,
  type PauseReason,
  type PauseScope,
  type ResolvedVia,
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
    case 'min_iterations':
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
    case 'no_open_questions':
      // pln#511 step 1 — bootstrap preset clarify-phase primitive. Mirrors
      // the persisted `thread.open_questions` set (kept in sync by
      // request_input / provide_input — see reconcileOpenQuestions).
      return thread.open_questions.length === 0;
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
    case 'min_iterations':
      return `min_iterations unmet: iteration_count (${thread.iteration_count}) < required (${gate.n})`;
    case 'artifact_produced':
      return `artifact_produced unmet: no artifact of type "${gate.type}" in phase "${gate.phase}"`;
    case 'no_open_questions':
      return `no_open_questions unmet: ${thread.open_questions.length} questions still open`;
    case 'manual':
      return 'manual gate: caller did not signal advance';
    case 'any':
      return `any-of unmet: none of ${gate.conditions.length} sub-conditions held`;
    case 'all': {
      // pln#516 step 2 — `all` composes other gates; the generic "at least
      // one of N failed" tells the operator nothing actionable. Find the
      // first sub-condition that evaluates false and report its reason so
      // the journal records what is actually blocking the advance.
      const failing = gate.conditions.find((c) => !evaluateStopCondition(thread, c));
      if (failing) return describeUnmetGate(thread, failing);
      return `all-of unmet: at least one of ${gate.conditions.length} sub-conditions failed`;
    }
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

  // pln#514 post-validation fix (can_27ebf1a0) — evaluate stop_condition
  // BEFORE decideNextPhase. The iteration engine throws "already at last
  // phase" when current_phase has no successor, which would shadow the
  // pre-advance auto-close branch below. For a loop whose stop_condition is
  // satisfied AT the last phase (the bootstrap preset's converge case after
  // project_md_final lands), the right behavior is auto-close, not throw.
  // Field-observed during pln#514 v1.1 validation (run_79f8443a).
  if (input.to_phase === undefined && evaluateStopCondition(current, current.stop_condition)) {
    const finalStatus: Exclude<LoopStatus, 'open' | 'paused'> = stopHitsMaxIterations(
      current,
      current.stop_condition,
    )
      ? 'blocked'
      : 'completed';
    const closed = commitClosedTransition(current, finalStatus, input.actor, input.reason, cwd);
    return { loop: closed, auto_closed: true };
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
  // pln#514 post-validation fix (can_27ebf1a0, run_79f8443a) — when the
  // auto-close path completes a bootstrap-preset loop, delegate to
  // closeLoop() so its writeProjectMdSafe pre-hook runs. Without this
  // delegation, the FSM auto-close via `advance` would bypass PROJECT.md
  // materialization entirely, defeating pln#512 step 2. The pre-hook
  // re-reads the thread from disk; the caller (advance) has already
  // persisted the latest state via writeThreadFile before reaching here
  // in both the pre- and post-advance auto-close branches.
  //
  // Non-bootstrap loops and non-completed closes (cancelled / blocked /
  // timeout-driven) fall through to the streamlined commit below — the
  // pre-hook is gated on final_status='completed' && preset='bootstrap'
  // in closeLoop, so delegating other cases would be a no-op anyway, but
  // delegation also costs a disk re-read. Avoid it when not needed.
  if (final_status === 'completed' && thread.protocol?.preset === 'bootstrap') {
    return closeLoop({ id: thread.id, final_status, reason, actor }, cwd);
  }

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
    // Schema invariant: pause_reason / pending_file_apply only legal in
    // status='paused'. Closing from a paused state must clear both.
    pause_reason: undefined,
    pending_file_apply: undefined,
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
  /**
   * Freeform reason recorded on the `paused` event. Legacy callers may pass
   * arbitrary strings here; when the value matches a known PauseReason it is
   * additionally coerced onto `thread.pause_reason` (pln#508 step 3 INVARIANT 2).
   */
  reason?: string;
  /**
   * Structured pause reason (preferred for new callers). When set, written
   * directly to `thread.pause_reason`. Takes precedence over coercion from
   * `reason`. pln#508 step 3, Phase 0 spec §5.
   */
  pause_reason?: PauseReason;
  actor: string;
}

/**
 * pln#508 step 3 (Phase 0 spec §5, INVARIANT 2) — coerce a freeform `reason`
 * string into a structured PauseReason when it matches the known enum.
 * Returns undefined for non-matching values so legacy callers still work
 * without populating `thread.pause_reason`.
 */
function coercePauseReason(reason: string | undefined): PauseReason | undefined {
  if (reason === undefined) return undefined;
  return (PAUSE_REASONS as readonly string[]).includes(reason)
    ? (reason as PauseReason)
    : undefined;
}

export function pause(input: PauseResumeInput, cwd?: string): LoopThread {
  const current = loadLoopOrThrow(input.id, cwd);
  if (current.status !== 'open') {
    throw new Error(`pause: loop ${current.id} is ${current.status}, not open`);
  }
  // Resolve effective pause_reason: explicit param wins, else coerce from
  // the freeform reason string when it matches PAUSE_REASONS, else leave
  // undefined for backward compatibility.
  const effectiveReason = input.pause_reason ?? coercePauseReason(input.reason);
  return commitSimpleStatus(
    current,
    'paused',
    'paused',
    input.actor,
    input.reason,
    cwd,
    effectiveReason,
  );
}

export function resume(input: PauseResumeInput, cwd?: string): LoopThread {
  const current = loadLoopOrThrow(input.id, cwd);
  if (current.status !== 'paused') {
    throw new Error(`resume: loop ${current.id} is ${current.status}, not paused`);
  }
  // Clear pause_reason on resume — schema enforces "pause_reason requires
  // status=paused", so leaving it set would fail LoopThreadSchema validation.
  return commitSimpleStatus(current, 'open', 'resumed', input.actor, input.reason, cwd, null);
}

/* ============= pln#508 step 3 — open_questions reconciliation ============== */

/**
 * Phase 0 spec §5 INVARIANT 3 — compute the canonical set of open question
 * ids from `thread.artifacts`. A question is "open" when it has an
 * operator_question artifact and NO matching operator_answer artifact (matched
 * by `body.replies_to === question.question_id`).
 *
 * The persisted `thread.open_questions` SHOULD always equal this computed set
 * after request_input / provide_input. The debug assert in
 * `assertOpenQuestionsInvariant` verifies the equality when
 * `BRAINCLAW_FSM_ASSERTS=1`; in production we log a warning rather than
 * throw so a single drift doesn't take down the engine.
 */
export function reconcileOpenQuestions(thread: LoopThread): string[] {
  const questionIds = new Set<string>();
  const answeredIds = new Set<string>();

  for (const artifact of thread.artifacts) {
    if (!artifact.body) continue;
    if (artifact.type === 'operator_question') {
      try {
        const parsed = JSON.parse(artifact.body) as { question_id?: string };
        if (typeof parsed.question_id === 'string') {
          questionIds.add(parsed.question_id);
        }
      } catch { /* malformed body — skip; LoopArtifactSchema rejects new ones */ }
    } else if (artifact.type === 'operator_answer') {
      try {
        const parsed = JSON.parse(artifact.body) as { replies_to?: string };
        if (typeof parsed.replies_to === 'string') {
          answeredIds.add(parsed.replies_to);
        }
      } catch { /* malformed body — skip */ }
    }
  }

  const open: string[] = [];
  for (const id of questionIds) {
    if (!answeredIds.has(id)) open.push(id);
  }
  return open;
}

function fsmAssertsEnabled(): boolean {
  return process.env.BRAINCLAW_FSM_ASSERTS === '1';
}

function assertOpenQuestionsInvariant(thread: LoopThread, intent: string): void {
  const canonical = new Set(reconcileOpenQuestions(thread));
  const persisted = new Set(thread.open_questions);
  if (canonical.size !== persisted.size || [...canonical].some((id) => !persisted.has(id))) {
    const message =
      `[brainclaw/loops/fsm] ${intent}: open_questions drift on loop ${thread.id} ` +
      `— persisted=${JSON.stringify([...persisted])} canonical=${JSON.stringify([...canonical])}`;
    // Log in prod so drift is visible without taking down the engine.
    // eslint-disable-next-line no-console
    console.warn(message);
    if (fsmAssertsEnabled()) {
      throw new Error(message);
    }
  }
}

/* =============== pln#508 step 2 — request_input / provide_input ============ */

export interface RequestInputInput {
  loop_id: string;
  slot_id: string;
  phase: string;
  question_text: string;
  evidence: string[];
  suggested_default?: string;
  options?: OperatorQuestionOption[];
  pause_scope: PauseScope;
  on_timeout: OnTimeoutPolicy;
  timeout_at?: string;
  actor: string;
}

export interface RequestInputResult {
  thread: LoopThread;
  question_id: string;
  artifact_id: string;
}

/**
 * Atomic operator-question primitive (Phase 0 spec §3).
 *
 * Validates the question body against `OperatorQuestionBodySchema` (via
 * `LoopArtifactSchema.parse` in `add_artifact`-style construction), enforces
 * the protocol's `max_operator_questions` cap, appends the question to the
 * loop's `open_questions`, and pauses either the asking slot
 * (`pause_scope='slot'` → slot.status=waiting_input) or the whole loop
 * (`pause_scope='loop'` → loop.status=paused, pause_reason='awaiting_operator').
 *
 * Refuses on terminal status or when status !== 'open' (no compounding
 * pauses — see Phase 0 spec §5, INVARIANT 1/2).
 */
export function requestInput(input: RequestInputInput, cwd?: string): RequestInputResult {
  const current = loadLoopOrThrow(input.loop_id, cwd);
  assertMutable(current, 'request_input');
  if (current.status !== 'open') {
    throw new Error(
      `request_input: loop ${current.id} is "${current.status}", cannot accept new questions ` +
      `(no compounding pauses — resolve current open_questions first)`,
    );
  }
  if (current.open_questions.length > 0) {
    throw new Error(
      `request_input: loop ${current.id} already has open_questions=${current.open_questions.length}; ` +
      `resolve existing operator question(s) before requesting another`,
    );
  }

  const max = current.protocol?.max_operator_questions;
  if (max !== undefined) {
    const existing = current.artifacts.filter((a) => a.type === 'operator_question').length;
    if (existing >= max) {
      throw new Error(
        `request_input: loop ${current.id} has reached max_operator_questions=${max}; ` +
        `champion must derive remaining answers autonomously`,
      );
    }
  }

  const slot = current.slots.find((s) => s.slot_id === input.slot_id);
  if (!slot) {
    throw new Error(`request_input: slot ${input.slot_id} not found on loop ${current.id}`);
  }
  if (slot.status === 'done' || slot.status === 'failed' || slot.status === 'cancelled') {
    throw new Error(`request_input: slot ${input.slot_id} is terminal (${slot.status})`);
  }

  const question_id = `qst_${crypto.randomBytes(6).toString('hex')}`;
  const questionBody: OperatorQuestionBody = {
    question_id,
    question_text: input.question_text,
    evidence: input.evidence,
    suggested_default: input.suggested_default,
    options: input.options,
    pause_scope: input.pause_scope,
    on_timeout: input.on_timeout,
    timeout_at: input.timeout_at,
    by_slot_id: input.slot_id,
  };

  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;

  // LoopArtifactSchema.parse runs the body schema validation for
  // type='operator_question' via KNOWN_ARTIFACT_BODY_SCHEMAS — so any
  // invariant violation (empty evidence, options size, on_timeout vs
  // suggested_default) surfaces here.
  const newArtifact = LoopArtifactSchema.parse({
    artifact_id: `art_${crypto.randomBytes(6).toString('hex')}`,
    phase: input.phase,
    type: 'operator_question',
    body: JSON.stringify(questionBody),
    produced_by: slot.agent_id ?? slot.agent ?? input.actor,
    produced_at: now,
    iteration: current.iteration_count,
  });

  let nextStatus: LoopStatus = current.status;
  let nextPauseReason = current.pause_reason;
  let nextSlots: LoopSlot[] = current.slots;
  const fromSlotStatus = slot.status;

  if (input.pause_scope === 'loop') {
    nextStatus = 'paused';
    nextPauseReason = 'awaiting_operator';
  } else {
    nextSlots = current.slots.map((s) =>
      s.slot_id === input.slot_id ? { ...s, status: 'waiting_input' as const } : s,
    );
  }

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    artifacts: [...current.artifacts, newArtifact],
    open_questions: [...current.open_questions, question_id],
    status: nextStatus,
    pause_reason: nextPauseReason,
    slots: nextSlots,
    updated_at: now,
  };

  let seq = nextSeq(current.id, cwd);

  appendEvent(
    current.id,
    {
      event_id: crypto.randomUUID(),
      loop_id: current.id,
      seq,
      at: now,
      by: input.actor,
      mutation_id,
      kind: 'input_requested',
      question_id,
      pause_scope: input.pause_scope,
      by_slot_id: input.slot_id,
    },
    cwd,
    // pln#513 phase 4 codex review fix — pass the next thread so the
    // notification hook sees the freshly-added operator_question rather
    // than re-reading the previous on-disk snapshot.
    next,
  );

  if (input.pause_scope === 'slot') {
    seq += 1;
    appendEvent(
      current.id,
      {
        event_id: crypto.randomUUID(),
        loop_id: current.id,
        seq,
        at: now,
        by: input.actor,
        mutation_id,
        kind: 'slot_status_changed',
        slot_id: input.slot_id,
        from_status: fromSlotStatus,
        to_status: 'waiting_input',
      },
      cwd,
    );
  }

  writeThreadFile(next, cwd);
  assertOpenQuestionsInvariant(next, 'request_input');
  return { thread: next, question_id, artifact_id: newArtifact.artifact_id };
}

export interface ProvideInputInput {
  loop_id: string;
  replies_to: string;
  resolved_via: ResolvedVia;
  answer_text?: string;
  chosen_option_id?: string;
  /** Defaults to 'operator'. Engine timeout sweep calls this with 'system'. */
  by?: 'operator' | 'system';
  actor: string;
}

export interface ProvideInputResult {
  thread: LoopThread;
  artifact_id: string;
  /** True when `replies_to` was already resolved before this call (idempotent replay). */
  duplicate: boolean;
}

/**
 * Resolves an open operator_question with an operator (or synthetic
 * timeout-default) answer. Phase 0 spec §3 atomic operation:
 *   1. Resolve `replies_to`:
 *        - In `open_questions` → proceed.
 *        - Else, find existing operator_answer with same `replies_to` →
 *          return the existing artifact (idempotent replay).
 *        - Else → throw `unknown_question`.
 *   2. Materialize `answer_text` / `chosen_option_id` from the source
 *      question's `suggested_default` when `resolved_via='skip'` or
 *      `'timeout_default'` and the caller didn't pass them.
 *   3. Append the operator_answer artifact (validated body).
 *   4. Remove the question_id from `open_questions`.
 *   5. Resume: if source had `pause_scope='slot'`, transition the asking
 *      slot back to 'working'. If `pause_scope='loop'` AND open_questions
 *      now empty AND pause_reason='awaiting_operator', resume the loop.
 *   6. Emit `input_provided` (+ `slot_status_changed` for slot scope).
 */
export function provideInput(input: ProvideInputInput, cwd?: string): ProvideInputResult {
  const current = loadLoopOrThrow(input.loop_id, cwd);
  // assertMutable allows paused loops (we need to resume them); only
  // refuse terminal status.
  if (current.status === 'completed' || current.status === 'cancelled' || current.status === 'blocked') {
    throw new Error(`provide_input: loop ${current.id} is already ${current.status}`);
  }

  const isOpen = current.open_questions.includes(input.replies_to);

  if (!isOpen) {
    // Idempotent-replay path: look for an existing operator_answer with
    // matching replies_to in the artifact list.
    const existing = current.artifacts.find((a) => {
      if (a.type !== 'operator_answer' || !a.body) return false;
      try {
        const parsed = JSON.parse(a.body) as { replies_to?: string };
        return parsed.replies_to === input.replies_to;
      } catch {
        return false;
      }
    });
    if (existing) {
      return { thread: current, artifact_id: existing.artifact_id, duplicate: true };
    }
    throw new Error(
      `provide_input: unknown_question — replies_to "${input.replies_to}" is not in ` +
      `open_questions and no existing operator_answer artifact references it`,
    );
  }

  // Locate the source question to determine pause_scope and by_slot_id.
  const sourceQuestion = current.artifacts.find((a) => {
    if (a.type !== 'operator_question' || !a.body) return false;
    try {
      const parsed = JSON.parse(a.body) as { question_id?: string };
      return parsed.question_id === input.replies_to;
    } catch {
      return false;
    }
  });

  if (!sourceQuestion || !sourceQuestion.body) {
    throw new Error(
      `provide_input: question ${input.replies_to} is in open_questions but its artifact ` +
      `was not found on the loop — state corruption`,
    );
  }
  const sourceBody = JSON.parse(sourceQuestion.body) as OperatorQuestionBody;

  // Materialize default values for skip / timeout_default resolutions.
  let answerText = input.answer_text;
  let chosenOptionId = input.chosen_option_id;
  if (
    (input.resolved_via === 'skip' || input.resolved_via === 'timeout_default') &&
    answerText === undefined &&
    chosenOptionId === undefined
  ) {
    if (sourceBody.suggested_default === undefined) {
      throw new Error(
        `provide_input: resolved_via="${input.resolved_via}" without an explicit ` +
        `answer requires the source question to have suggested_default set`,
      );
    }
    if (sourceBody.options) {
      chosenOptionId = sourceBody.suggested_default;
    } else {
      answerText = sourceBody.suggested_default;
    }
  }

  const by = input.by ?? 'operator';
  const synthetic = by === 'system';
  const answerBody: OperatorAnswerBody = {
    replies_to: input.replies_to,
    resolved_via: input.resolved_via,
    answer_text: answerText,
    chosen_option_id: chosenOptionId,
    by,
    synthetic: synthetic ? true : undefined,
  };

  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;

  const newArtifact = LoopArtifactSchema.parse({
    artifact_id: `art_${crypto.randomBytes(6).toString('hex')}`,
    phase: sourceQuestion.phase,
    type: 'operator_answer',
    body: JSON.stringify(answerBody),
    produced_by: by === 'system' ? 'engine' : input.actor,
    produced_at: now,
    iteration: current.iteration_count,
  });

  const nextOpenQuestions = current.open_questions.filter((q) => q !== input.replies_to);

  // Widen to LoopStatus — the assertMutable check above narrowed current.status
  // to 'open' | 'paused', but the file_apply post-hook below can transition
  // directly to 'completed' (pln#512 step 2).
  let nextStatus: LoopStatus = current.status;
  let nextPauseReason = current.pause_reason;
  let nextSlots = current.slots;
  let nextPendingFileApply = current.pending_file_apply;
  let nextClosedAt = current.closed_at;
  let resumedSlotId: string | undefined;
  let resumedSlotFromStatus: LoopSlot['status'] | undefined;

  // pln#512 step 2 — file_overwrite_approval resolution path. When the loop
  // is paused on a file_apply question (set by the closeLoop bootstrap
  // pre-hook), the answer carries the operator's approve/reject decision.
  // Approve → write PROJECT.md atomically; reject → leave target untouched.
  // Either way, the loop transitions directly to status='completed' so the
  // caller's original `closeLoop(final_status='completed')` intent is
  // honoured without requiring a second close round-trip.
  let fileApplyResolution: { approved: boolean; artifact_id: string } | undefined;
  if (
    sourceBody.pause_scope === 'loop' &&
    nextOpenQuestions.length === 0 &&
    current.pause_reason === 'awaiting_file_apply' &&
    current.pending_file_apply !== undefined
  ) {
    const approved = chosenOptionId === 'approve';
    if (approved) {
      // Idempotent on the source artifact: writeProjectMdSafe re-reads
      // project_md_final and atomic-writes the target. Failure here propagates
      // — we don't want to mark the loop completed if the write failed.
      writeProjectMdSafe(current, cwd, { approved: true });
    }
    fileApplyResolution = {
      approved,
      artifact_id: current.pending_file_apply.artifact_id,
    };
    nextStatus = 'completed';
    nextPauseReason = undefined;
    nextPendingFileApply = undefined;
    nextClosedAt = now;
  } else if (sourceBody.pause_scope === 'slot') {
    const slotId = sourceBody.by_slot_id;
    if (slotId) {
      const slot = current.slots.find((s) => s.slot_id === slotId);
      if (slot && slot.status === 'waiting_input') {
        resumedSlotId = slotId;
        resumedSlotFromStatus = slot.status;
        nextSlots = current.slots.map((s) =>
          s.slot_id === slotId ? { ...s, status: 'working' as const } : s,
        );
      }
    }
  } else if (
    sourceBody.pause_scope === 'loop' &&
    nextOpenQuestions.length === 0 &&
    current.pause_reason === 'awaiting_operator'
  ) {
    nextStatus = 'open';
    nextPauseReason = undefined;
  }

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    artifacts: [...current.artifacts, newArtifact],
    open_questions: nextOpenQuestions,
    status: nextStatus,
    pause_reason: nextPauseReason,
    pending_file_apply: nextPendingFileApply,
    closed_at: nextClosedAt,
    slots: nextSlots,
    updated_at: now,
  };

  let seq = nextSeq(current.id, cwd);

  appendEvent(
    current.id,
    {
      event_id: crypto.randomUUID(),
      loop_id: current.id,
      seq,
      at: now,
      by: input.actor,
      mutation_id,
      kind: 'input_provided',
      question_id: input.replies_to,
      resolved_via: input.resolved_via,
      answered_by: by,
      synthetic,
    },
    cwd,
  );

  if (resumedSlotId && resumedSlotFromStatus) {
    seq += 1;
    appendEvent(
      current.id,
      {
        event_id: crypto.randomUUID(),
        loop_id: current.id,
        seq,
        at: now,
        by: input.actor,
        mutation_id,
        kind: 'slot_status_changed',
        slot_id: resumedSlotId,
        from_status: resumedSlotFromStatus,
        to_status: 'working',
      },
      cwd,
    );
  }

  // pln#512 step 2 — file_apply close-out events. The file_apply_resolved
  // event must precede the closed event so the journal reads in causal
  // order (resolve → close), mirroring the absent/empty branch in
  // closeLoop.
  if (fileApplyResolution !== undefined) {
    seq += 1;
    appendEvent(
      current.id,
      {
        event_id: crypto.randomUUID(),
        loop_id: current.id,
        seq,
        at: now,
        by: input.actor,
        mutation_id,
        kind: 'file_apply_resolved',
        artifact_id: fileApplyResolution.artifact_id,
        approved: fileApplyResolution.approved,
      },
      cwd,
    );
    seq += 1;
    appendEvent(
      current.id,
      {
        event_id: crypto.randomUUID(),
        loop_id: current.id,
        seq,
        at: now,
        by: input.actor,
        mutation_id,
        kind: 'closed',
        final_status: 'completed',
        reason: fileApplyResolution.approved
          ? 'file_overwrite_approved'
          : 'file_overwrite_rejected',
      },
      cwd,
    );
  }

  writeThreadFile(next, cwd);
  assertOpenQuestionsInvariant(next, 'provide_input');
  return { thread: next, artifact_id: newArtifact.artifact_id, duplicate: false };
}

/* =========================== /pln#508 step 2 ============================== */

/**
 * Commit a simple open ↔ paused transition.
 *
 * `pauseReasonOverride` semantics (pln#508 step 3):
 *   - undefined → leave `thread.pause_reason` as-is (pass-through via spread).
 *   - PauseReason value → write that value to `thread.pause_reason`.
 *   - null → explicitly clear `thread.pause_reason` (used by resume() to
 *     satisfy the LoopThreadSchema invariant "pause_reason requires
 *     status=paused").
 */
function commitSimpleStatus(
  current: LoopThread,
  newStatus: 'open' | 'paused',
  eventKind: 'paused' | 'resumed',
  actor: string,
  reason: string | undefined,
  cwd: string | undefined,
  pauseReasonOverride?: PauseReason | null,
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
    pause_reason:
      pauseReasonOverride === null
        ? undefined
        : pauseReasonOverride ?? current.pause_reason,
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

/* ================ pln#508 step 3 — pause-timeout machinery ================ */

/**
 * Phase 0 spec §6 — sweep the loop's `open_questions` for any whose deadline
 * has passed. For each timed-out question, apply the policy recorded on its
 * source artifact:
 *
 *   - `use_default`         → synthesize an `operator_answer` via
 *                              `provideInput(by='system', resolved_via='timeout_default')`.
 *   - `cancel_loop`         → close the loop with `final_status='cancelled'`
 *                              and `reason='operator_timeout'`.
 *   - `continue_incomplete` → drop the question_id from `open_questions`
 *                              WITHOUT creating an answer; resume the slot
 *                              or loop per the source `pause_scope`.
 *
 * Each timeout firing also appends a `pause_timeout` system event so the
 * journal records the action taken.
 *
 * Idempotent + safe to call repeatedly: questions no longer in `open_questions`
 * are skipped; terminal loops short-circuit immediately.
 */
export interface SweepPauseTimeoutsResult {
  loop_id: string;
  fired: Array<{ question_id: string; action_taken: OnTimeoutPolicy }>;
}

export function sweepPauseTimeouts(
  loop_id: string,
  now?: Date,
  cwd?: string,
): SweepPauseTimeoutsResult {
  const nowMs = (now ?? new Date()).getTime();
  let current = getLoop(loop_id, cwd);
  if (!current) {
    return { loop_id, fired: [] };
  }
  // Terminal loops never get swept (Phase 0 spec §6).
  if (
    current.status === 'completed' ||
    current.status === 'cancelled' ||
    current.status === 'blocked'
  ) {
    return { loop_id, fired: [] };
  }
  if (current.open_questions.length === 0) {
    return { loop_id, fired: [] };
  }

  const fired: Array<{ question_id: string; action_taken: OnTimeoutPolicy }> = [];
  // Snapshot question_ids: we mutate state inside the loop and want a stable
  // iteration set even if e.g. provideInput's cascade clears multiple.
  const candidates = [...current.open_questions];

  for (const question_id of candidates) {
    // Reload between iterations — provideInput / continue_incomplete /
    // commitClosedTransition all rewrite the thread, and a previous iteration
    // may have already taken the loop terminal.
    const reloaded = getLoop(loop_id, cwd);
    if (!reloaded) break;
    current = reloaded;
    if (
      current.status === 'completed' ||
      current.status === 'cancelled' ||
      current.status === 'blocked'
    ) {
      break;
    }
    if (!current.open_questions.includes(question_id)) continue;

    const source = findOperatorQuestion(current, question_id);
    if (!source) continue;

    const deadlineMs = resolveDeadlineMs(current, source);
    if (deadlineMs === undefined) continue;
    if (nowMs <= deadlineMs) continue;

    const policy = source.body.on_timeout;
    if (policy === 'use_default') {
      try {
        provideInput(
          {
            loop_id,
            replies_to: question_id,
            resolved_via: 'timeout_default',
            by: 'system',
            actor: 'engine',
          },
          cwd,
        );
      } catch {
        // If provideInput rejects (e.g. missing suggested_default that should
        // have been caught at request_input time), fall through so we still
        // record an audit event marking the attempted sweep.
        continue;
      }
      emitPauseTimeoutEvent(loop_id, question_id, 'use_default', cwd);
      fired.push({ question_id, action_taken: 'use_default' });
    } else if (policy === 'cancel_loop') {
      // Re-read after we know we're firing — cancel transitions the loop
      // to terminal and persists.
      const beforeCancel = getLoop(loop_id, cwd);
      if (!beforeCancel) break;
      commitClosedTransition(beforeCancel, 'cancelled', 'engine', 'operator_timeout', cwd);
      emitPauseTimeoutEvent(loop_id, question_id, 'cancel_loop', cwd);
      fired.push({ question_id, action_taken: 'cancel_loop' });
      // Subsequent candidates can't fire on a terminal loop.
      break;
    } else if (policy === 'continue_incomplete') {
      applyContinueIncomplete(current, question_id, source.body, cwd);
      emitPauseTimeoutEvent(loop_id, question_id, 'continue_incomplete', cwd);
      fired.push({ question_id, action_taken: 'continue_incomplete' });
    }
  }

  return { loop_id, fired };
}

function emitPauseTimeoutEvent(
  loop_id: string,
  question_id: string,
  action_taken: OnTimeoutPolicy,
  cwd: string | undefined,
): void {
  appendEvent(
    loop_id,
    {
      event_id: crypto.randomUUID(),
      loop_id,
      seq: nextSeq(loop_id, cwd),
      at: nowISO(),
      by: 'engine',
      mutation_id: generateMutationId(),
      kind: 'pause_timeout',
      question_id,
      action_taken,
    },
    cwd,
  );
}

interface SourceQuestion {
  artifact: LoopArtifact;
  body: OperatorQuestionBody;
}

function findOperatorQuestion(thread: LoopThread, question_id: string): SourceQuestion | undefined {
  for (const artifact of thread.artifacts) {
    if (artifact.type !== 'operator_question' || !artifact.body) continue;
    try {
      const body = JSON.parse(artifact.body) as OperatorQuestionBody;
      if (body.question_id === question_id) {
        return { artifact, body };
      }
    } catch { /* skip malformed */ }
  }
  return undefined;
}

/**
 * Compute the deadline (ms since epoch) for a question. Prefers the
 * artifact's explicit `timeout_at`. Falls back to `produced_at +
 * protocol.max_pause_duration` (ISO-8601 duration). Returns undefined when
 * neither source yields a usable value.
 */
function resolveDeadlineMs(thread: LoopThread, source: SourceQuestion): number | undefined {
  if (source.body.timeout_at) {
    const parsed = Date.parse(source.body.timeout_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const max = thread.protocol?.max_pause_duration;
  if (!max) return undefined;
  const startMs = Date.parse(source.artifact.produced_at);
  if (Number.isNaN(startMs)) return undefined;
  const durationMs = parseIso8601DurationMs(max);
  if (durationMs === undefined) return undefined;
  return startMs + durationMs;
}

/**
 * Minimal ISO-8601 duration parser. Supports the subset needed by the
 * bootstrap preset: P[n]D[ T[n]H[n]M[n]S ]. Returns the total duration in
 * milliseconds, or undefined when the input is not a recognised duration.
 * Note: months/years are intentionally NOT supported — they have no
 * fixed millisecond length and the preset only needs days/hours/minutes.
 *
 * Bound (can_45f6a7fb): output is rejected when ms is non-finite, ≤0,
 * or exceeds MAX_PAUSE_DURATION_MS (365 days). Without this bound, inputs
 * like `P99999999999999D` parse to `Infinity` or unsafe integers, and
 * `now > timeout_at` evaluates falsy ⇒ the deadline never fires ⇒
 * paused loops hang forever with no recovery path.
 */
const MAX_PAUSE_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

function parseIso8601DurationMs(input: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(input);
  if (!match) return undefined;
  const [, daysStr, hoursStr, minutesStr, secondsStr] = match;
  // If everything is missing the regex still matches "P" — guard against
  // returning 0 for a meaningless string.
  if (!daysStr && !hoursStr && !minutesStr && !secondsStr) return undefined;
  const days = daysStr ? Number(daysStr) : 0;
  const hours = hoursStr ? Number(hoursStr) : 0;
  const minutes = minutesStr ? Number(minutesStr) : 0;
  const seconds = secondsStr ? Number(secondsStr) : 0;
  const ms = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_PAUSE_DURATION_MS) {
    return undefined;
  }
  return ms;
}

/**
 * Apply the `continue_incomplete` timeout policy: drop the question_id from
 * `open_questions` without creating an answer artifact, and resume the slot
 * or loop per the source `pause_scope`. Atomic: one version bump, no
 * `input_provided` event (continue_incomplete is explicitly "no answer").
 */
function applyContinueIncomplete(
  current: LoopThread,
  question_id: string,
  body: OperatorQuestionBody,
  cwd: string | undefined,
): LoopThread {
  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  const nextOpenQuestions = current.open_questions.filter((q) => q !== question_id);

  let nextStatus: LoopStatus = current.status;
  let nextPauseReason = current.pause_reason;
  let nextSlots: LoopSlot[] = current.slots;
  let resumedSlotId: string | undefined;
  let resumedSlotFromStatus: LoopSlot['status'] | undefined;

  if (body.pause_scope === 'slot' && body.by_slot_id) {
    const slot = current.slots.find((s) => s.slot_id === body.by_slot_id);
    if (slot && slot.status === 'waiting_input') {
      resumedSlotId = slot.slot_id;
      resumedSlotFromStatus = slot.status;
      nextSlots = current.slots.map((s) =>
        s.slot_id === slot.slot_id ? { ...s, status: 'working' as const } : s,
      );
    }
  } else if (
    body.pause_scope === 'loop' &&
    nextOpenQuestions.length === 0 &&
    current.pause_reason === 'awaiting_operator'
  ) {
    nextStatus = 'open';
    nextPauseReason = undefined;
  }

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    open_questions: nextOpenQuestions,
    status: nextStatus,
    pause_reason: nextPauseReason,
    slots: nextSlots,
    updated_at: now,
  };

  if (resumedSlotId && resumedSlotFromStatus) {
    appendEvent(
      current.id,
      {
        event_id: crypto.randomUUID(),
        loop_id: current.id,
        seq: nextSeq(current.id, cwd),
        at: now,
        by: 'engine',
        mutation_id,
        kind: 'slot_status_changed',
        slot_id: resumedSlotId,
        from_status: resumedSlotFromStatus,
        to_status: 'working',
      },
      cwd,
    );
  }

  writeThreadFile(next, cwd);
  return next;
}
