import path from 'node:path';

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

  // ── Containment gate (§8 Q6): the reservation must belong to the store we are
  // operating on. Before any mutation / on-behalf convergence, refuse to reconcile
  // a reservation whose store_root resolves to a DIFFERENT project than `cwd` — a
  // cross-project reconcile must never converge another store's loop/claim. ──
  const operatingRoot = path.resolve(cwd ?? process.cwd());
  if (path.resolve(reservation.store_root) !== operatingRoot) {
    return { reconciled: false, reason: `containment: reservation store_root ${reservation.store_root} != operating store ${operatingRoot}` };
  }

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

  // ── §13 R4 contradiction: a turn-keyed FAILED sentinel present alongside a
  // completed result (the lane or a completed sentinel) → WITHHOLD convergence,
  // journal a conflict (never silently accept). Compared against the LANE's
  // completed status too (review Finding 5): a worker that wrote a completed
  // LANE-RESULT then exited non-zero (turn-keyed failed sentinel) is a conflict,
  // not a clean close. ──
  try {
    const bodies = readCompletionSignals(cwd ?? process.cwd(), reservation.child_ids.assignment_id);
    const matchedCompleted = bodies.completed?.status === 'completed' && evidenceMatchesAttempt(reservation, bodies.completed);
    const matchedFailed = bodies.failed?.status === 'failed' && evidenceMatchesAttempt(reservation, bodies.failed);
    if (matchedFailed && (matchedCompleted || lane.status === 'completed')) {
      try {
        createRuntimeEvent({
          agent: actor,
          event_type: 'run_blocked',
          text: `reconcileTurn: turn ${turn_id} has a completed(lane/sentinel)+failed(sentinel) contradiction — auto-stop WITHHELD (§13 R4), escalating to human`,
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

  // ── Superseded-turn guard (PR4 / review round-2 follow-up). A NEWER turn has
  // taken over this slot when `slot.current_turn_id` is set and points elsewhere
  // (each dispatch's turn() rebinds the slot pointer). A late/duplicate reconcile
  // of the OLD turn must then NOT re-terminalize the slot or advance on a stale
  // outcome — the slot has moved on. No-op. (When current_turn_id is unset — a
  // direct reconcile with no preceding turn() — this does not fire, so the
  // primitive stays testable in isolation.) This is safe against
  // crossed_not_revocable: we never try to revoke the old crossed grant; we just
  // decline to converge a superseded turn. ──
  if (slot.current_turn_id !== undefined && slot.current_turn_id !== turn_id) {
    return { reconciled: false, reason: `turn ${turn_id} superseded by current turn ${slot.current_turn_id} on slot ${slot.slot_id}` };
  }

  // A terminal loop already converged → idempotent no-op (any trigger may fire us).
  if (LOOP_TERMINAL.has(loop.status)) {
    return { reconciled: true, reason: `loop already ${loop.status} (idempotent no-op)`, artifacts_added: 0, loop_status: loop.status };
  }

  // ── Idempotency (review Findings 1+2): a TERMINAL slot durably means this turn's
  // verdict was already recorded — complete_turn sets the slot terminal ATOMICALLY
  // with its artifact via the crash-atomic WAL, so a terminal slot is the
  // recorded-marker (each new turn resets its slot to `assigned` first, so a
  // terminal slot can only be THIS turn's own convergence). Re-running the reducer
  // /complete_turn would double-record (Finding 2). So SKIP recording when
  // terminal — but STILL fall through to advance below (Finding 1: a crash between
  // complete_turn and advance must still close the loop on the next trigger). ──
  const slotTerminal = slot.status === 'done' || slot.status === 'failed' || slot.status === 'cancelled';
  let slot_outcome: 'done' | 'failed';
  let artifacts_added = 0;

  if (slotTerminal) {
    slot_outcome = slot.status === 'done' ? 'done' : 'failed';
  } else {
    // ── §6 reducer: validated result → loop artifacts + slot outcome. ──
    const reducerInput: ReducerInput = { lane, phase: reservation.phase, critiques: input.critiques };
    const reduced = reducerForKind(loop.kind)(reducerInput, reservation);
    artifacts_added = reduced.artifacts.length;
    slot_outcome = reduced.slot_outcome;

    // Record artifacts + complete the turn (crash-atomic WAL via complete_turn).
    // Guarded: a body-cap/schema error becomes a graceful reconciled:false rather
    // than an unhandled throw out of reconcileTurn (review Finding 3 defense).
    try {
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
    } catch (err) {
      return { reconciled: false, reason: `complete_turn failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── Secondary convergence (best-effort + idempotent): run/assignment/claim.
  // Runs on BOTH paths so a crash that recorded the turn but not the settle still
  // converges them on replay. ──
  settleRunCompleted(reservation.child_ids.run_id, actor, cwd);
  settleAssignmentAndClaim(reservation.child_ids.assignment_id, reservation.claim_id, actor, cwd);

  // ── Deterministic stop only: advance closes the loop on reviewer_green / gate.
  // ALWAYS attempted on a `done` outcome (idempotent) so a crash-before-advance
  // still closes on the next trigger (Finding 1). Only the phase-advance-gate-blocked
  // case is expected (fix cycle continues) — any OTHER throw is a real error and is
  // rethrown, never silently swallowed (Finding 6). ──
  let auto_closed = false;
  if (slot_outcome === 'done') {
    try {
      auto_closed = advance({ id: loop.id, actor }, cwd).auto_closed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Benign "cannot advance/close now" outcomes → the loop stays open, awaiting
      // the next turn (e.g. request_changes on a single-phase loop): the phase gate
      // is unsatisfied, or there is no successor phase. Anything else is a REAL
      // error and must propagate, never be silently swallowed (review Finding 6).
      if (!/phase_advance_blocked|already at last phase|no post-cycle successor/.test(msg)) throw err;
    }
  }
  const loop_status = getLoop(loop.id, cwd)?.status ?? loop.status;

  return {
    reconciled: true,
    reason: slotTerminal ? `turn ${turn_id} already recorded; advance re-attempted (${slot_outcome})` : `turn ${turn_id} reconciled (${slot_outcome})`,
    slot_outcome,
    artifacts_added,
    auto_closed,
    loop_status,
  };
}
