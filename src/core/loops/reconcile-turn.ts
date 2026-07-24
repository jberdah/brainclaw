import { getReservation, evidenceMatchesAttempt, currentNonce, type TurnReservation } from './attempt-reservation.js';
import { getLoop } from './store.js';
import { complete_turn, add_artifact, advance } from './verbs.js';
import { reducerForKind, type ReducerInput } from './result-reducers.js';
import { loadAgentRun, transitionAgentRun } from '../agentruns.js';
import { loadAssignment, transitionAssignment } from '../assignments.js';
import { loadClaim, releaseClaim } from '../claims.js';
import { createRuntimeEvent } from '../events.js';
import { readCompletionSignals } from '../runtime-signals.js';
import type { LaneResult } from '../schema.js';

/**
 * reconcileTurn (pln#630 §8) — the ONE mutating convergence action for a
 * turn-owned dispatch. GET stays observational (never calls this); autonomous
 * convergence is triggered by the wrapper completion signal, harvest, an explicit
 * reconcile, or session-end. It validates attempt identity + evidence (§2), runs
 * the per-kind reducer (§6), records the loop artifact + completes the turn, and
 * auto-advances/closes ONLY on a deterministic stop (reviewer_green / gate). All
 * mutations are idempotent so any trigger can fire it repeatedly without
 * duplicating state.
 *
 * Evidence rule (read-strict, §2/R3): the LANE result MUST be turn-keyed to THIS
 * attempt's current launch generation (turn_id + run_id + nonce match). A stale
 * prior-generation or mismatched result is rejected — never converges the loop on
 * the wrong attempt's output. A completed+failed sentinel CONTRADICTION (§13 R4)
 * withholds the auto-stop and journals a conflict rather than silently accepting.
 */

export interface ReconcileTurnInput {
  turn_id: string;
  /** The authoritative turn result (LANE-RESULT). Must carry turn_id/run_id/nonce matching the attempt. */
  lane: LaneResult;
  /** ideation only — critique bodies resolved from the attempt's critique_batch artifact. */
  critiques?: Array<{ body: string; addresses_critique?: string[] }>;
  actor?: string;
  cwd?: string;
}

export interface ReconcileTurnResult {
  reconciled: boolean;
  reason: string;
  /** True when a completed+failed contradiction withheld convergence (§13 R4). */
  conflict?: boolean;
  slot_outcome?: 'done' | 'failed';
  artifacts_added?: number;
  auto_closed?: boolean;
  loop_status?: string;
}

const LOOP_TERMINAL = new Set(['closed', 'cancelled', 'completed', 'abandoned']);

/** Move a turn-owned run to `completed` via `running` if it never got there. Best-effort. */
function settleRunCompleted(runId: string, actor: string, cwd?: string): void {
  try {
    const run = loadAgentRun(runId, cwd);
    if (!run || run.status === 'completed') return;
    // created/launching/waiting_input/blocked can't go straight to completed —
    // route through running first (matrix allows created→running, running→completed).
    if (run.status !== 'running') {
      try { transitionAgentRun(runId, 'running', { actor, status_reason: 'reconcileTurn: settling for completion' }, cwd); }
      catch { /* already past running, or terminal — fall through */ }
    }
    const after = loadAgentRun(runId, cwd);
    if (after && after.status === 'running') {
      transitionAgentRun(runId, 'completed', { actor, status_reason: 'reconcileTurn: turn-keyed completion accepted' }, cwd);
    }
  } catch { /* best-effort — loop convergence does not depend on run status */ }
}

function settleAssignmentAndClaim(assignmentId: string, claimId: string | undefined, actor: string, cwd?: string): void {
  try {
    const asg = loadAssignment(assignmentId, cwd);
    if (asg && asg.status !== 'completed' && asg.status !== 'cancelled') {
      try { transitionAssignment(assignmentId, 'completed', { actor }, cwd); } catch { /* transition may be illegal from current state — best-effort */ }
    }
  } catch { /* best-effort */ }
  if (claimId) {
    try {
      const claim = loadClaim(claimId, cwd);
      if (claim && claim.status === 'active') releaseClaim(claimId, cwd);
    } catch { /* best-effort */ }
  }
}

export function reconcileTurn(input: ReconcileTurnInput): ReconcileTurnResult {
  const { turn_id, lane, cwd } = input;
  const actor = input.actor ?? 'reconciler';

  const reservation: TurnReservation | undefined = getReservation(turn_id, cwd);
  if (!reservation) return { reconciled: false, reason: `unknown turn_id ${turn_id}` };

  // ── §2 read-strict evidence gate: the LANE must be turn-keyed to THIS attempt's
  // current launch generation. A stale/mismatched result never converges the loop. ──
  if (!evidenceMatchesAttempt(reservation, { turn_id: lane.turn_id, run_id: lane.run_id, nonce: lane.nonce })) {
    const nonce = currentNonce(reservation);
    return {
      reconciled: false,
      reason: nonce === undefined
        ? 'no live launch generation (revoked/never-armed) — cannot accept evidence'
        : `lane evidence (turn=${lane.turn_id} run=${lane.run_id} nonce=${lane.nonce}) does not match attempt ${turn_id}`,
    };
  }

  // ── §13 R4 contradiction: a turn-keyed completed AND a turn-keyed failed sentinel
  // both present → WITHHOLD convergence, journal a conflict (never silently accept). ──
  try {
    const bodies = readCompletionSignals(cwd ?? process.cwd(), reservation.child_ids.assignment_id);
    const matchedCompleted = bodies.completed?.status === 'completed' && evidenceMatchesAttempt(reservation, bodies.completed);
    const matchedFailed = bodies.failed?.status === 'failed' && evidenceMatchesAttempt(reservation, bodies.failed);
    if (matchedCompleted && matchedFailed) {
      try {
        createRuntimeEvent({
          agent: actor,
          event_type: 'run_blocked',
          text: `reconcileTurn: turn ${turn_id} has a completed+failed contradiction — auto-stop WITHHELD (§13 R4), escalating to human`,
          tags: ['loops', 'reconcile', 'conflict', 'turn-attempt'],
          assignment_id: reservation.child_ids.assignment_id,
          run_id: reservation.child_ids.run_id,
          status_reason: 'turn_evidence_contradiction',
        }, cwd);
      } catch { /* conflict-journal best-effort */ }
      return { reconciled: false, conflict: true, reason: 'completed+failed contradiction — convergence withheld (§13 R4)' };
    }
  } catch { /* signal read best-effort — absence of sentinels is not a contradiction */ }

  const loop = getLoop(reservation.loop_id, cwd);
  if (!loop) return { reconciled: false, reason: `loop ${reservation.loop_id} not found` };

  const slot = loop.slots.find((s) => s.slot_id === reservation.slot_id);
  if (!slot) return { reconciled: false, reason: `slot ${reservation.slot_id} not in loop ${reservation.loop_id}` };

  // ── Idempotency: a prior reconcile of THIS turn already converged the slot, or
  // the loop is already terminal → no-op (any trigger may fire us repeatedly). ──
  if (LOOP_TERMINAL.has(loop.status)) {
    return { reconciled: true, reason: `loop already ${loop.status} (idempotent no-op)`, loop_status: loop.status };
  }
  const slotTerminal = slot.status === 'done' || slot.status === 'failed' || slot.status === 'cancelled';
  if (slotTerminal && slot.current_turn_id === turn_id) {
    return { reconciled: true, reason: 'turn already reconciled (slot terminal)', slot_outcome: slot.status as 'done' | 'failed', loop_status: loop.status };
  }

  // ── §6 reducer: validated result → loop artifacts + slot outcome. ──
  const reducerInput: ReducerInput = { lane, phase: reservation.phase, critiques: input.critiques };
  const reduced = reducerForKind(loop.kind)(reducerInput, reservation);

  // ── Record artifacts + complete the turn (crash-atomic WAL via complete_turn). ──
  // For >1 artifact (ideation), pre-add the extras, then complete_turn with the first.
  const [primary, ...extras] = reduced.artifacts;
  for (const a of extras) {
    try { add_artifact({ id: loop.id, actor, artifact: { phase: a.phase, type: a.type, body: a.body, produced_by: a.produced_by } }, cwd); }
    catch { /* an extra artifact failing must not abort convergence */ }
  }
  complete_turn({
    id: loop.id,
    slot_id: slot.slot_id,
    actor,
    outcome: reduced.slot_outcome,
    failure_reason: reduced.failure_reason,
    ...(primary ? { artifact: { phase: primary.phase, type: primary.type, body: primary.body } } : {}),
  }, cwd);

  // ── Secondary convergence (best-effort): run/assignment/claim. ──
  settleRunCompleted(reservation.child_ids.run_id, actor, cwd);
  settleAssignmentAndClaim(reservation.child_ids.assignment_id, reservation.claim_id, actor, cwd);

  // ── Deterministic stop only: advance closes the loop on reviewer_green / gate.
  // A blocked gate (fix cycle continues) is NOT an error — the loop stays open. ──
  let auto_closed = false;
  if (reduced.slot_outcome === 'done') {
    try {
      auto_closed = advance({ id: loop.id, actor }, cwd).auto_closed;
    } catch {
      // phase_advance_blocked / not-yet-satisfied gate → loop stays open, awaiting
      // the next turn. Convergence of THIS turn still succeeded.
    }
  }
  const loop_status = getLoop(loop.id, cwd)?.status ?? loop.status;

  return {
    reconciled: true,
    reason: `turn ${turn_id} reconciled (${reduced.slot_outcome})`,
    slot_outcome: reduced.slot_outcome,
    artifacts_added: reduced.artifacts.length,
    auto_closed,
    loop_status,
  };
}
