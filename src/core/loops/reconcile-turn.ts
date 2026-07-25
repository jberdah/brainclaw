import path from 'node:path';

import { getReservation, evidenceMatchesAttempt, currentNonce, deriveTurnId, type TurnReservation } from './attempt-reservation.js';
import { getLoop } from './store.js';
import { complete_turn, add_artifact, advance } from './verbs.js';
import { reducerForKind, type ReducerInput } from './result-reducers.js';
import { loadAgentRun, transitionAgentRun } from '../agentruns.js';
import { loadAssignment, transitionAssignment } from '../assignments.js';
import { loadClaim, releaseClaim } from '../claims.js';
import { createRuntimeEvent } from '../events.js';
import { readCompletionSignals } from '../runtime-signals.js';
import { buildFixCycleTask, type ReviewLoopNextTurn } from '../review-loop-close.js';
import { withLoopLock, LockTimeoutError, LockLostError } from './lock.js';
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
  /**
   * pln#630 PR3b — a symmetric request_changes turn that did not terminate the loop
   * bumps the round and hands harvest the next fix-cycle turn to re-dispatch (mirrors the
   * legacy closeReviewLoopFromLaneResult.next_turn). Present iff the claim was RETAINED.
   */
  next_turn?: ReviewLoopNextTurn;
}

// The terminal loop statuses (LOOP_STATUSES = open|paused|completed|blocked|cancelled).
// 'blocked' is LOAD-BEARING (pln#630 PR3b): the iteration cap closes a fix cycle to
// `blocked`, and a blocked loop must be treated as terminal both by the idempotent
// early-return below and by the fix-cycle already-bumped branch. (The legacy 'closed'/
// 'abandoned' entries are not real loop statuses — kept as harmless historical aliases.)
const LOOP_TERMINAL = new Set(['closed', 'cancelled', 'completed', 'abandoned', 'blocked']);

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

/** Complete this turn's assignment (idempotent, best-effort). The re-dispatch of a fix
 *  cycle mints a FRESH assignment, so completing the old one is always correct. */
function settleAssignment(assignmentId: string, actor: string, cwd?: string): void {
  try {
    const asg = loadAssignment(assignmentId, cwd);
    if (asg && asg.status !== 'completed' && asg.status !== 'cancelled') {
      try { transitionAssignment(assignmentId, 'completed', { actor }, cwd); } catch { /* transition may be illegal from current state — best-effort */ }
    }
  } catch { /* best-effort */ }
}

/**
 * Release the coordinator claim (idempotent, best-effort). pln#630 PR3b: DEFERRED until
 * after the advance decision and skipped when the fix cycle retains the claim/worktree. The
 * caller passes the AUTHORITATIVE claim the slot/assignment is bound to (dec#149 #3) — NOT
 * reservation.claim_id, which is the dead first-reserver claim in the recovery-winner path.
 */
function releaseCoordinatorClaim(claimId: string | undefined, cwd?: string): void {
  if (!claimId) return;
  try {
    const claim = loadClaim(claimId, cwd);
    if (claim && claim.status === 'active') releaseClaim(claimId, cwd);
  } catch { /* best-effort */ }
}

export function reconcileTurn(input: ReconcileTurnInput): ReconcileTurnResult {
  const { turn_id, lane, cwd } = input;
  const actor = input.actor ?? 'reconciler';

  const reservation: TurnReservation | undefined = getReservation(turn_id, cwd);
  if (!reservation) return { reconciled: false, reason: `unknown turn_id ${turn_id}` };

  // ── Containment gate (§8 Q6): the reservation must belong to the store we are
  // operating on. Before any mutation / on-behalf convergence, refuse to reconcile
  // a reservation whose store_root resolves to a DIFFERENT project than `cwd` — a
  // cross-project reconcile must never converge another store's loop/claim.
  // Case-folded on win32 (review Finding 2) so a `C:\`-vs-`c:\` casing difference
  // between the reserve-time cwd and the reconcile cwd never false-rejects on the
  // Windows-primary target. ──
  const operatingRoot = path.resolve(cwd ?? process.cwd());
  const reservationRoot = path.resolve(reservation.store_root);
  const sameStore = process.platform === 'win32'
    ? reservationRoot.toLowerCase() === operatingRoot.toLowerCase()
    : reservationRoot === operatingRoot;
  if (!sameStore) {
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

  // pln#630 PR3b (adversarial review Finding 1) — the guard-read + advance + release compound
  // MUST be atomic + serialized. Without a lock two concurrent reconciles of the same turn each
  // pass the iteration-equality bump guard on a STALE snapshot and each advance from a fresh
  // read → i→i+1 and i+1→i+2 → two turn_ids → the launch fence spawns BOTH rounds. Run the
  // mutation under the loop lock (re-reading the loop INSIDE), mirroring the legacy closer's
  // BLOCKING-3 fix. Lock contention → reconciled:false (a later trigger retries); a REAL error
  // still propagates (Finding 6), never silently swallowed.
  try {
    return withLoopLock<ReconcileTurnResult>({
      cwd,
      intent: 'reconcile-turn',
      agentId: actor,
      scope: { kind: 'loop', loopId: reservation.loop_id },
      work: () => convergeLockedTurn(reservation, input, actor, cwd),
    });
  } catch (err) {
    if (err instanceof LockTimeoutError || err instanceof LockLostError) {
      return { reconciled: false, reason: `reconcile deferred (${err.name}); a later trigger retries` };
    }
    throw err;
  }
}

/**
 * The locked convergence body of reconcileTurn (pln#630 PR3b). Runs INSIDE withLoopLock so the
 * iteration-equality bump guard and the advance observe ONE serialized snapshot — the loop is
 * re-read here as the fresh in-lock read. Logic is otherwise identical to the pre-lock inline
 * version (plus the terminal-early-return claim release, review Finding 2).
 */
function convergeLockedTurn(
  reservation: TurnReservation,
  input: ReconcileTurnInput,
  actor: string,
  cwd: string | undefined,
): ReconcileTurnResult {
  const { turn_id, lane } = input;
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

  // A terminal loop already converged → idempotent no-op (any trigger may fire us). Still
  // release the claim (review Finding 2): a cap-blocked loop that crashed AFTER the block
  // transition but BEFORE its own deferred release would otherwise leak the retained claim
  // until the staleness sweep — releaseCoordinatorClaim is idempotent (no-op if not active).
  if (LOOP_TERMINAL.has(loop.status)) {
    releaseCoordinatorClaim(loadAssignment(reservation.child_ids.assignment_id, cwd)?.claim_id ?? reservation.claim_id, cwd);
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
    // ── pln#521 P4 — observability: the turn's artifact was harvested + integrated
    // into the loop. Best-effort (never aborts a successful convergence). ──
    try {
      createRuntimeEvent({
        agent: actor,
        event_type: 'loop_artifact_harvested',
        text: `reconcileTurn: harvested turn ${turn_id} on slot ${slot.slot_id} → loop ${loop.id} (${slot_outcome}, ${artifacts_added} artifact(s), phase ${reservation.phase})`,
        tags: ['loops', 'reconcile', 'harvest', 'turn-attempt'],
        assignment_id: reservation.child_ids.assignment_id,
        run_id: reservation.child_ids.run_id,
        status_reason: `harvested_${slot_outcome}`,
      }, cwd);
    } catch {
      /* observability best-effort — a telemetry failure must not undo the harvest */
    }
  }

  // ── Secondary convergence (best-effort + idempotent): run + assignment. The CLAIM
  // release is DEFERRED to after the advance decision (pln#630 PR3b) so a fix-cycle round
  // can RETAIN the claim/worktree. Run + assignment settle unconditionally on both paths
  // (a crash that recorded the turn but not the settle still converges on replay; the
  // fix-cycle re-dispatch mints a fresh run/assignment, so completing the old is correct). ──
  settleRunCompleted(reservation.child_ids.run_id, actor, cwd);
  settleAssignment(reservation.child_ids.assignment_id, actor, cwd);

  // ── Advance / stop decision. On a `done` outcome we either drive a deterministic stop
  // (reviewer_green / gate → close), continue a symmetric fix cycle (bump the round + retain
  // the claim + emit next_turn), or leave the loop open (asymmetric / no successor). ──
  let auto_closed = false;
  let retainClaim = false;
  let next_turn: ReviewLoopNextTurn | undefined;
  // Build the fix-cycle re-dispatch descriptor for a given round (shared by the bump arm and
  // the strand self-heal below so the reviewer brief + slot binding never drift).
  const mkNextTurn = (phase: string, iteration: number): ReviewLoopNextTurn => ({
    slot_id: slot.slot_id,
    role: slot.role ?? 'reviewer',
    agent: slot.agent ?? '',
    ...(slot.agent_id ? { agent_id: slot.agent_id } : {}),
    phase,
    iteration,
    task: buildFixCycleTask(lane.review_summary ?? lane.summary ?? '', iteration),
  });
  if (slot_outcome === 'done') {
    // symmetricRC detection is INDEPENDENT of the bump guard below (safety race 2): a
    // re-reconcile in the pre-redispatch window must NOT fall into the approve/asymmetric
    // arm, which would advance the phase FORWARD (to author_response) and corrupt the cycle.
    const symmetricRC =
      loop.kind === 'review' &&
      lane.review_verdict === 'request_changes' &&
      loop.protocol?.review_mode === 'symmetric';
    if (symmetricRC) {
      // EXACTLY-ONCE bump (the one non-negotiable safety guard): each bump changes
      // deriveTurnId(loop, slot, iteration), so a DOUBLE bump would mint two turn_ids and
      // the launch fence would spawn BOTH rounds. Bump only when this turn's round is still
      // current; a re-reconcile after the bump takes the else-branch (no re-bump, no re-emit).
      if (loop.iteration_count === reservation.iteration) {
        // Legacy backward-bump (advance to the SAME phase → iteration_count += 1). The
        // post-advance stop check closes to `blocked` when the max_iterations cap is hit.
        const adv = advance({ id: loop.id, to_phase: loop.current_phase, actor }, cwd);
        if (adv.auto_closed || LOOP_TERMINAL.has(adv.loop.status)) {
          auto_closed = true; // iteration cap → blocked/terminal → release the claim below
        } else {
          retainClaim = true; // keep the coordinator claim + worktree for the re-dispatch
          next_turn = mkNextTurn(adv.loop.current_phase, adv.loop.iteration_count);
        }
      } else {
        // Already bumped by a prior pass. Distinguish a benign re-reconcile (the next round
        // WAS dispatched) from a genuine STRAND (pln#630 PR4, closes dec#149 #2/F3): the pass
        // that bumped crashed BEFORE harvest re-dispatched, so the loop sits open with the
        // claim retained and NO worker in flight. Detect it precisely — is there a reservation
        // for the bumped round's deterministic turn_id? If NOT → strand → RE-EMIT next_turn to
        // self-heal (the launch fence dedups, so a benign duplicate is DENIED, never a
        // double-spawn) and journal a recovery event. If a reservation exists → the next round
        // is already in flight → just retain, no re-emit (no churn on benign re-reconciles).
        const cur = getLoop(loop.id, cwd);
        if (cur && !LOOP_TERMINAL.has(cur.status)) {
          retainClaim = true;
          const bumpedTurnId = deriveTurnId(loop.id, slot.slot_id, cur.iteration_count);
          if (!getReservation(bumpedTurnId, cwd)) {
            next_turn = mkNextTurn(cur.current_phase, cur.iteration_count);
            try {
              createRuntimeEvent({
                agent: actor,
                event_type: 'run_blocked',
                text: `reconcileTurn: fix-cycle round ${cur.iteration_count} of loop ${loop.id} was bumped but never dispatched (turn ${turn_id} strand) — re-emitting next_turn to self-heal`,
                tags: ['loops', 'reconcile', 'turn-owned', 'strand-recovery'],
                assignment_id: reservation.child_ids.assignment_id,
                run_id: reservation.child_ids.run_id,
                status_reason: 'fix_cycle_strand_reemit',
              }, cwd);
            } catch { /* observability best-effort */ }
          }
        } else {
          auto_closed = true;
        }
      }
    } else {
      // approve OR asymmetric request_changes — unchanged PR3a / legacy-asymmetric behavior.
      // Benign "cannot advance/close now" → loop stays open awaiting the next turn; any
      // OTHER throw is a REAL error and must propagate, never be silently swallowed (Finding 6).
      try {
        auto_closed = advance({ id: loop.id, actor }, cwd).auto_closed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/phase_advance_blocked|already at last phase|no post-cycle successor/.test(msg)) throw err;
      }
    }
  }

  // Release the coordinator claim now — UNLESS a fix-cycle round retained it. Target the
  // authoritative claim the assignment is bound to, not reservation.claim_id (dec#149 #3).
  if (!retainClaim) {
    const authoritativeClaimId = loadAssignment(reservation.child_ids.assignment_id, cwd)?.claim_id ?? reservation.claim_id;
    releaseCoordinatorClaim(authoritativeClaimId, cwd);
  }

  const loop_status = getLoop(loop.id, cwd)?.status ?? loop.status;

  return {
    reconciled: true,
    reason: next_turn
      ? `turn ${turn_id} → request_changes: bumped to round ${next_turn.iteration}, claim retained for re-dispatch`
      : slotTerminal ? `turn ${turn_id} already recorded; advance re-attempted (${slot_outcome})` : `turn ${turn_id} reconciled (${slot_outcome})`,
    slot_outcome,
    artifacts_added,
    auto_closed,
    loop_status,
    ...(next_turn ? { next_turn } : {}),
  };
}
