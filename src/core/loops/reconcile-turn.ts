import fs from 'node:fs';
import path from 'node:path';

import { getReservation, evidenceMatchesAttempt, currentNonce, findReservationByAssignmentId, findReservationByRunId, launchGrant, resolveTurnId, type TurnReservation } from './attempt-reservation.js';
import { getLoop } from './store.js';
import { completeTurnWithEvidence, addArtifactWithEvidence, complete_turn, advance } from './verbs.js';
import { reducerForKind, type ReducerInput } from './result-reducers.js';
import { loadAgentRun, recordExecutionContractAnomaly, transitionAgentRun } from '../agentruns.js';
import { convergeAssignmentToTerminal, loadAssignment, transitionAssignment } from '../assignments.js';
import { loadClaim, releaseClaim, releaseClaimIfActive } from '../claims.js';
import { createRuntimeEvent } from '../events.js';
import { readCompletionSignals, readContractAck } from '../runtime-signals.js';
import { buildFixCycleTask, type ReviewLoopNextTurn } from '../review-loop-close.js';
import { withLoopLock, LockTimeoutError, LockLostError } from './lock.js';
import { validateWorkerContractAcceptance } from '../execution-contract.js';
import { evidenceDigest } from './evidence.js';
import { executionContractForGeneration, settleActiveAttemptGenerationV2 } from './attempt-authority.js';
import { fenceForGeneration, resolveTurnGenerationChain } from './attempt-generations.js';
import { readLocalAuthorityHome } from './attempt-rollout.js';
import { LaneResultSchema, type AgentRun, type LaneResult } from '../schema.js';

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
  /** ideation only — explicitly typed critique bodies resolved from the attempt result. */
  critiques?: Array<{ body: string; addresses_critique?: string[] }>;
  actor?: string;
  cwd?: string;
}

export interface ReconcileTurnResult {
  reconciled: boolean;
  reason: string;
  /** True when a completed+failed contradiction withheld convergence (§13 R4). */
  conflict?: boolean;
  /** Contract acceptance mismatch after crossing; this generation must not respawn. */
  contract_anomaly?: boolean;
  respawn?: false;
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

export interface TurnOwnedLaneEvidence {
  reservation: TurnReservation;
  nonce?: string;
  run_id: string;
  attempt_epoch?: number;
  workspace_digest?: string;
  contract_hash?: string;
  capability_snapshot_hash?: string;
}

/** Prefer the current run-scoped runtime channel, with assignment-scoped files
 * retained only as a compatibility fallback for pre-run-keyed dispatches. */
function readAttemptCompletionSignals(root: string, assignmentId: string, runId: string) {
  const scoped = readCompletionSignals(root, assignmentId, runId);
  const legacy = readCompletionSignals(root, assignmentId);
  return {
    completed: scoped.completed ?? legacy.completed,
    failed: scoped.failed ?? legacy.failed,
  };
}

function readAttemptContractAck(root: string, assignmentId: string, runId: string) {
  return readContractAck(root, assignmentId, runId) ?? readContractAck(root, assignmentId);
}

/**
 * Resolve the authoritative generation coordinates for a worker result.
 *
 * A file-fallback LANE-RESULT may omit the mechanical fence fields because the
 * wrapper already wrote them to its completion signal. The worker-controlled
 * fields always win when present, so stale/mismatched evidence is still rejected
 * by reconcileTurn. Missing fields are filled only from the reservation's active
 * generation and its run-keyed completion signal.
 */
export function turnOwnedLaneEvidence(
  lane: LaneResult,
  cwd: string,
  reservationOverride?: TurnReservation,
): TurnOwnedLaneEvidence | undefined {
  const reservation = reservationOverride ?? findReservationByAssignmentId(lane.assignment_id, cwd);
  if (!reservation) return undefined;
  const chain = resolveTurnGenerationChain(cwd, reservation.turn_id);
  const generation = chain?.latest_generation;
  const runId = generation?.run_id ?? reservation.child_ids.run_id;
  const completion = readAttemptCompletionSignals(
    cwd,
    generation?.assignment_id ?? reservation.child_ids.assignment_id,
    runId,
  ).completed;
  const bootstrapAck = readAttemptContractAck(
    cwd,
    generation?.assignment_id ?? reservation.child_ids.assignment_id,
    runId,
  );
  // The pre-exec bootstrap ACK is the first durable, coordinator-authored proof
  // that this exact launch generation crossed into the worker. Real file-fallback
  // workers commonly write LANE-RESULT before the wrapper can emit its terminal
  // sentinel, and they do not echo the mechanical turn/run/nonce tuple. In that
  // window, enrich only from an ACCEPTED run-keyed ACK; reconcileTurn still checks
  // every coordinate against the active generation, so a rejected/foreign/stale
  // ACK cannot authorize convergence and an explicit lane value always wins.
  const acceptedAck = bootstrapAck?.status === 'accepted' ? bootstrapAck : undefined;
  const nonce = lane.nonce ?? completion?.nonce ?? acceptedAck?.nonce;
  if (!nonce && !reservation.execution_contract_ref) return undefined;
  return {
    reservation,
    nonce,
    run_id: runId,
    attempt_epoch: lane.attempt_epoch ?? completion?.attempt_epoch ?? acceptedAck?.attempt_epoch ?? generation?.attempt_epoch,
    workspace_digest: lane.workspace_digest ?? completion?.workspace_digest ?? acceptedAck?.workspace_digest ?? generation?.workspace_digest,
    contract_hash: lane.execution_contract_hash
      ?? completion?.contract_hash
      ?? acceptedAck?.contract_hash
      ?? generation?.contract_hash
      ?? reservation.execution_contract_ref?.hash,
    capability_snapshot_hash: lane.capability_snapshot_hash
      ?? completion?.capability_snapshot_hash
      ?? acceptedAck?.capability_snapshot_hash
      ?? reservation.execution_contract_ref?.snapshot_hash,
  };
}

/** Reconcile one parsed worker result through the single AttemptAuthority path. */
export function reconcileTurnOwnedLane(
  lane: LaneResult,
  cwd: string,
  evidence?: TurnOwnedLaneEvidence,
  actor?: string,
): { reservation: TurnReservation; result: ReconcileTurnResult } | undefined {
  const ev = evidence ?? turnOwnedLaneEvidence(lane, cwd);
  if (!ev) return undefined;
  const { reservation } = ev;
  const enrichedLane: LaneResult = {
    ...lane,
    turn_id: lane.turn_id ?? reservation.turn_id,
    run_id: lane.run_id ?? ev.run_id,
    nonce: lane.nonce ?? ev.nonce,
    attempt_epoch: lane.attempt_epoch ?? ev.attempt_epoch,
    workspace_digest: lane.workspace_digest ?? ev.workspace_digest,
    execution_contract_hash: lane.execution_contract_hash ?? ev.contract_hash,
    capability_snapshot_hash: lane.capability_snapshot_hash ?? ev.capability_snapshot_hash,
  };
  const loop = getLoop(reservation.loop_id, cwd);
  const critiques = loop?.kind === 'ideation'
    && reservation.phase === 'critique'
    && lane.artifact_type === 'critique'
    && (lane.body ?? '').trim().length > 0
    ? [{ body: lane.body!.trim() }]
    : undefined;
  const result = reconcileTurn({ turn_id: reservation.turn_id, lane: enrichedLane, cwd, critiques, actor });
  return { reservation, result };
}

export interface RunLaneResultReconcileResult {
  found: boolean;
  valid: boolean;
  reason: string;
  lane?: LaneResult;
  reservation?: TurnReservation;
  result?: ReconcileTurnResult;
}

/**
 * Lazy read-path bridge: consume the exact LANE-RESULT owned by one AgentRun.
 * Invalid JSON, foreign assignment ids, stale generation workspaces, or missing
 * turn fences are reported without mutating slot/assignment/run/claim state.
 */
export function reconcileLaneResultForRun(
  run: AgentRun,
  cwd: string,
  actor = 'reconciler',
): RunLaneResultReconcileResult {
  if (!run.worktree_path) return { found: false, valid: false, reason: 'run has no worktree_path' };
  const resultPath = path.join(run.worktree_path, 'LANE-RESULT.json');
  if (!fs.existsSync(resultPath)) return { found: false, valid: false, reason: 'LANE-RESULT.json not found' };

  let lane: LaneResult;
  try {
    lane = LaneResultSchema.parse(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
  } catch (err) {
    return { found: true, valid: false, reason: `invalid LANE-RESULT.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (lane.assignment_id !== run.assignment_id) {
    return { found: true, valid: false, lane, reason: `foreign assignment_id ${lane.assignment_id}; expected ${run.assignment_id}` };
  }

  const reservation = findReservationByRunId(run.id, cwd);
  if (!reservation) return { found: true, valid: false, lane, reason: `run ${run.id} has no owning turn reservation` };
  const chain = resolveTurnGenerationChain(cwd, reservation.turn_id);
  const generation = chain?.latest_generation;
  if (generation && generation.run_id !== run.id) {
    return { found: true, valid: false, lane, reservation, reason: `run ${run.id} is not the active generation ${generation.run_id}` };
  }
  if (generation) {
    const actualWorkspace = normalizedWorkspace(run.worktree_path);
    const expectedWorkspace = normalizedWorkspace(generation.workspace_path);
    if (!actualWorkspace || !expectedWorkspace || actualWorkspace !== expectedWorkspace) {
      return { found: true, valid: false, lane, reservation, reason: 'run worktree does not match the active attempt generation workspace' };
    }
  }

  const evidence = turnOwnedLaneEvidence(lane, cwd, reservation);
  if (!evidence) {
    return { found: true, valid: false, lane, reservation, reason: 'LANE-RESULT lacks a run-keyed launch fence and no completion signal supplies one' };
  }
  const reconciled = reconcileTurnOwnedLane(lane, cwd, evidence, actor);
  if (!reconciled) return { found: true, valid: false, lane, reservation, reason: 'turn-owned reconciliation unavailable' };
  return {
    found: true,
    valid: reconciled.result.reconciled,
    lane,
    reservation,
    result: reconciled.result,
    reason: reconciled.result.reason,
  };
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
    if (!asg || asg.status === 'completed' || asg.status === 'cancelled') return;
    if (asg.status === 'expired') {
      try { transitionAssignment(assignmentId, 'completed', { actor }, cwd); } catch { /* concurrent terminal transition */ }
      return;
    }
    if (asg.status === 'created') {
      try { transitionAssignment(assignmentId, 'offered', { actor }, cwd); } catch { /* concurrent transition */ }
    }
    convergeAssignmentToTerminal(
      assignmentId,
      'completed',
      'reconcileTurn: turn-keyed worker result accepted',
      cwd,
    );
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

  const resolvedGeneration = resolveTurnGenerationChain(cwd ?? reservation.store_root, reservation.turn_id);
  const activeGeneration = resolvedGeneration && (resolvedGeneration.status === 'active' || resolvedGeneration.status === 'settled')
    ? resolvedGeneration.latest_generation
    : undefined;
  const activeRunId = activeGeneration?.run_id ?? reservation.child_ids.run_id;
  const activeAssignmentId = activeGeneration?.assignment_id ?? reservation.child_ids.assignment_id;
  const activeContractRef = activeGeneration
    ? executionContractForGeneration(reservation, activeGeneration).ref
    : reservation.execution_contract_ref;
  const activeLaunchStatus = activeGeneration ? 'crossed' as const : reservation.launch?.status;
  const owningRun = loadAgentRun(activeRunId, cwd);
  if (owningRun?.execution_contract_anomaly) {
    return {
      reconciled: false,
      contract_anomaly: true,
      respawn: false,
      reason: `persisted post-crossing execution-contract anomaly (${owningRun.execution_contract_anomaly.source}) — convergence withheld; respawn=false`,
    };
  }

  // ── §2 read-strict evidence gate: the LANE must be turn-keyed to THIS attempt's
  // current launch generation. A stale/mismatched result never converges the loop. ──
  if (!evidenceMatchesAttempt(reservation, {
    assignment_id: lane.assignment_id,
    turn_id: lane.turn_id,
    run_id: lane.run_id,
    nonce: lane.nonce,
    attempt_epoch: lane.attempt_epoch,
    contract_hash: lane.execution_contract_hash,
    workspace_digest: lane.workspace_digest,
  })) {
    const nonce = currentNonce(reservation);
    return {
      reconciled: false,
      reason: nonce === undefined
        ? 'no live launch generation (revoked/never-armed) — cannot accept evidence'
        : `lane evidence (turn=${lane.turn_id} run=${lane.run_id} nonce=${lane.nonce}) does not match attempt ${turn_id}`,
    };
  }

  if (activeContractRef) {
    const completion = readAttemptCompletionSignals(
      cwd ?? process.cwd(),
      activeAssignmentId,
      activeRunId,
    ).completed;
    const bootstrapAck = readAttemptContractAck(
      cwd ?? process.cwd(),
      activeAssignmentId,
      activeRunId,
    );
    const accepted = {
      contract_hash: lane.execution_contract_hash ?? completion?.contract_hash ?? '',
      capability_snapshot_hash: lane.capability_snapshot_hash ?? completion?.capability_snapshot_hash ?? '',
    };
    const bootstrapVerdict = bootstrapAck?.status === 'accepted'
      && bootstrapAck.turn_id === reservation.turn_id
      && bootstrapAck.run_id === activeRunId
      && bootstrapAck.nonce === (activeGeneration?.launch_nonce ?? reservation.launch?.token)
      && (!activeGeneration
        || bootstrapAck.cwd === normalizedWorkspace(activeGeneration.workspace_path))
      && (!activeGeneration || (
        bootstrapAck.attempt_epoch === activeGeneration.attempt_epoch
        && bootstrapAck.workspace_digest === activeGeneration.workspace_digest
      ))
      ? validateWorkerContractAcceptance(
        activeContractRef,
        {
          contract_hash: bootstrapAck.contract_hash,
          capability_snapshot_hash: bootstrapAck.capability_snapshot_hash,
        },
        activeLaunchStatus,
      )
      : undefined;
    const terminalVerdict = validateWorkerContractAcceptance(
        activeContractRef,
      accepted,
      activeLaunchStatus,
    );
    if (bootstrapVerdict?.kind !== 'accepted' || terminalVerdict.kind !== 'accepted') {
      try {
        recordExecutionContractAnomaly(activeRunId, {
          source: bootstrapVerdict?.kind !== 'accepted'
            ? 'bootstrap_ack'
            : lane.execution_contract_hash ? 'lane_result' : 'completion_signal',
          reason: bootstrapVerdict?.kind !== 'accepted'
            ? 'bootstrap did not accept the immutable execution contract'
            : 'terminal evidence did not match the immutable execution contract',
          accepted_contract_hash: bootstrapVerdict?.kind !== 'accepted'
            ? bootstrapAck?.contract_hash
            : accepted.contract_hash,
          accepted_capability_snapshot_hash: bootstrapVerdict?.kind !== 'accepted'
            ? bootstrapAck?.capability_snapshot_hash
            : accepted.capability_snapshot_hash,
        }, cwd);
      } catch { /* ack/sentinel remains a durable fallback fence */ }
      try {
        createRuntimeEvent({
          agent: actor,
          event_type: 'run_blocked',
          text: `reconcileTurn: post-crossing execution-contract acceptance anomaly for ${turn_id}; convergence WITHHELD and respawn=false`,
          tags: ['loops', 'reconcile', 'contract-anomaly', 'turn-attempt'],
          assignment_id: activeAssignmentId,
          run_id: activeRunId,
          status_reason: 'execution_contract_acceptance_mismatch',
        }, cwd);
      } catch { /* anomaly journal best-effort */ }
      return {
        reconciled: false,
        contract_anomaly: true,
        respawn: false,
        reason: 'post-crossing execution-contract acceptance mismatch or missing hash — convergence withheld; respawn=false',
      };
    }
  }

  // ── §13 R4 contradiction: a turn-keyed FAILED sentinel present alongside a
  // completed result (the lane or a completed sentinel) → WITHHOLD convergence,
  // journal a conflict (never silently accept). Compared against the LANE's
  // completed status too (review Finding 5): a worker that wrote a completed
  // LANE-RESULT then exited non-zero (turn-keyed failed sentinel) is a conflict,
  // not a clean close. ──
  try {
    const bodies = readAttemptCompletionSignals(
      cwd ?? process.cwd(),
      activeAssignmentId,
      activeRunId,
    );
    const matchedCompleted = bodies.completed?.status === 'completed' && evidenceMatchesAttempt(reservation, {
      assignment_id: activeAssignmentId,
      ...bodies.completed,
    });
    const matchedFailed = bodies.failed?.status === 'failed' && evidenceMatchesAttempt(reservation, {
      assignment_id: activeAssignmentId,
      ...bodies.failed,
    });
    if (matchedFailed && (matchedCompleted || lane.status === 'completed')) {
      try {
        createRuntimeEvent({
          agent: actor,
          event_type: 'run_blocked',
          text: `reconcileTurn: turn ${turn_id} has a completed(lane/sentinel)+failed(sentinel) contradiction — auto-stop WITHHELD (§13 R4), escalating to human`,
          tags: ['loops', 'reconcile', 'conflict', 'turn-attempt'],
          assignment_id: activeAssignmentId,
          run_id: activeRunId,
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
  const { turn_id } = input;
  let lane = input.lane;
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

  // AttemptAuthority v2 TOCTOU closure: repeat the FULL evidence/fence check
  // while holding the loop lock, then let settlement and takeover contend on
  // the same immutable close(epoch) cell. If takeover won after the optimistic
  // pre-check, settlement observes it here and performs no loop mutation.
  const generationState = resolveTurnGenerationChain(cwd ?? reservation.store_root, reservation.turn_id);
  if (generationState) {
    if (!evidenceMatchesAttempt(reservation, {
      assignment_id: lane.assignment_id,
      turn_id: lane.turn_id,
      run_id: lane.run_id,
      nonce: lane.nonce,
      attempt_epoch: lane.attempt_epoch,
      contract_hash: lane.execution_contract_hash,
      workspace_digest: lane.workspace_digest,
    })) {
      return { reconciled: false, reason: 'attempt generation changed before commit — stale evidence fenced' };
    }
    const generation = generationState.latest_generation;
    const localAuthorityHome = readLocalAuthorityHome(cwd ?? reservation.store_root);
    if (!localAuthorityHome) {
      return { reconciled: false, reason: 'AttemptAuthority v2 settlement requires the activated local authority_home' };
    }
    const settlement = settleActiveAttemptGenerationV2(
      turn_id,
      fenceForGeneration(generation),
      lane as Record<string, unknown>,
      localAuthorityHome,
      actor,
      loop.created_by,
      cwd ?? reservation.store_root,
    );
    if (!settlement || settlement.cell.decision !== 'settled') {
      return {
        reconciled: false,
        reason: `settlement lost close(${generation.attempt_epoch}) to ${settlement?.cell.decision ?? 'unknown'} — evidence is audit-only`,
      };
    }
    lane = LaneResultSchema.parse(settlement.evidence.result);
  }
  const acceptedGeneration = generationState?.latest_generation;
  const acceptedRunId = acceptedGeneration?.run_id ?? reservation.child_ids.run_id;
  const acceptedAssignmentId = acceptedGeneration?.assignment_id ?? reservation.child_ids.assignment_id;
  const acceptedExecutor = acceptedGeneration?.executor ?? {
    agent: reservation.agent,
    agent_id: reservation.agent_id,
    claim_id: reservation.claim_id,
    capability_snapshot: reservation.capability_snapshot,
  };
  const acceptedNonce = acceptedGeneration?.launch_nonce ?? reservation.launch?.token;
  const acceptedEpoch = acceptedGeneration?.attempt_epoch ?? reservation.epoch;
  const acceptedContractHash = acceptedGeneration?.contract_hash
    ?? reservation.execution_contract_ref?.hash
    ?? evidenceDigest({
      version: 'legacy-uncontracted-reservation-v1',
      turn_id: reservation.turn_id,
      run_id: reservation.child_ids.run_id,
      epoch: reservation.epoch,
      phase: reservation.phase,
      iteration: reservation.iteration,
      cwd: reservation.cwd,
    });
  const acceptedWorkspaceDigest = acceptedGeneration?.workspace_digest ?? evidenceDigest({
    workspace_policy: reservation.execution_contract?.workspace_policy,
    cwd: reservation.cwd,
    store_root: reservation.store_root,
  });

  // A terminal loop already converged → idempotent no-op (any trigger may fire us). Still
  // release the claim (review Finding 2): a cap-blocked loop that crashed AFTER the block
  // transition but BEFORE its own deferred release would otherwise leak the retained claim
  // until the staleness sweep — releaseCoordinatorClaim is idempotent (no-op if not active).
  if (LOOP_TERMINAL.has(loop.status)) {
    releaseCoordinatorClaim(loadAssignment(acceptedAssignmentId, cwd)?.claim_id ?? acceptedExecutor.claim_id, cwd);
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
        try {
          addArtifactWithEvidence({
            id: loop.id,
            actor,
            evidence_context: {
              channel: 'reconcile_turn',
              producer_kind: 'slot',
              producer_id: acceptedExecutor.agent,
              agent_id: acceptedExecutor.agent_id,
              slot_id: slot.slot_id,
              slot_role: slot.role,
              turn_id,
              assignment_id: acceptedAssignmentId,
              claim_id: acceptedExecutor.claim_id,
              run_id: acceptedRunId,
              nonce: acceptedNonce,
              attempt_epoch: acceptedEpoch,
              execution_contract_hash: acceptedContractHash,
              workspace_digest: acceptedWorkspaceDigest,
            },
            artifact: {
              phase: a.phase,
              type: a.type,
              body: a.body,
              produced_by: a.produced_by,
              addresses_critique: a.addresses_critique,
              implementation_verify: a.implementation_verify,
            },
          }, cwd);
        }
        catch { /* an extra artifact failing must not abort convergence */ }
      }
      completeTurnWithEvidence({
        id: loop.id,
        slot_id: slot.slot_id,
        actor,
        evidence_context: {
          channel: 'reconcile_turn',
          producer_kind: 'slot',
          producer_id: acceptedExecutor.agent,
          agent_id: acceptedExecutor.agent_id,
          slot_id: slot.slot_id,
          slot_role: slot.role,
          turn_id,
          assignment_id: acceptedAssignmentId,
          claim_id: acceptedExecutor.claim_id,
          run_id: acceptedRunId,
          nonce: acceptedNonce,
          attempt_epoch: acceptedEpoch,
          execution_contract_hash: acceptedContractHash,
          workspace_digest: acceptedWorkspaceDigest,
        },
        outcome: reduced.slot_outcome,
        failure_reason: reduced.failure_reason,
        ...(primary ? {
          artifact: {
            phase: primary.phase,
            type: primary.type,
            body: primary.body,
            addresses_critique: primary.addresses_critique,
            implementation_verify: primary.implementation_verify,
          },
        } : {}),
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
        assignment_id: acceptedAssignmentId,
        run_id: acceptedRunId,
        attempt_epoch: acceptedGeneration?.attempt_epoch,
        workspace_digest: acceptedGeneration?.workspace_digest,
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
  settleRunCompleted(acceptedRunId, actor, cwd);
  settleAssignment(acceptedAssignmentId, actor, cwd);

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
      // resolveTurnId(loop, slot, phase, iteration), so a DOUBLE bump would mint two turn_ids and
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
          // The bumped round is LIVE only if its reservation exists AND its launch grant is
          // armed (dispatch in flight, pre-spawn) or crossed (spawned). A REVOKED grant
          // (reserved_never_launched — crash between arm and consume + the expiry sweep) or an
          // absent reservation is a STRAND (dec#149 R1): re-emit to self-heal. The re-dispatch's
          // prepare re-arms a revoked grant at a higher epoch, so this round can actually relaunch.
          const currentSlot = cur.slots.find((candidate) => candidate.slot_id === slot.slot_id);
          const bumpedTurnId = resolveTurnId({
            loop_id: loop.id,
            slot_id: slot.slot_id,
            phase: cur.current_phase,
            iteration: cur.iteration_count,
            current_turn_id: currentSlot?.current_turn_id,
          }, cwd);
          const bumpedGrant = launchGrant(bumpedTurnId, cwd);
          const bumpedLive =
            getReservation(bumpedTurnId, cwd) !== undefined &&
            (bumpedGrant?.status === 'armed' || bumpedGrant?.status === 'crossed');
          if (!bumpedLive) {
            next_turn = mkNextTurn(cur.current_phase, cur.iteration_count);
            try {
              createRuntimeEvent({
                agent: actor,
                event_type: 'run_blocked',
                text: `reconcileTurn: fix-cycle round ${cur.iteration_count} of loop ${loop.id} was bumped but never dispatched (turn ${turn_id} strand) — re-emitting next_turn to self-heal`,
                tags: ['loops', 'reconcile', 'turn-owned', 'strand-recovery'],
                assignment_id: acceptedAssignmentId,
                run_id: acceptedRunId,
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
    const authoritativeClaimId = loadAssignment(acceptedAssignmentId, cwd)?.claim_id ?? acceptedExecutor.claim_id;
    releaseCoordinatorClaim(authoritativeClaimId, cwd);
  }

  const loop_status = getLoop(loop.id, cwd)?.status ?? loop.status;

  return {
    reconciled: true,
    reason: next_turn
      ? `turn ${turn_id} → request_changes round ${next_turn.iteration}: claim retained, next fix turn emitted for re-dispatch`
      : slotTerminal ? `turn ${turn_id} already recorded; advance re-attempted (${slot_outcome})` : `turn ${turn_id} reconciled (${slot_outcome})`,
    slot_outcome,
    artifacts_added,
    auto_closed,
    loop_status,
    ...(next_turn ? { next_turn } : {}),
  };
}

function normalizedWorkspace(value: string): string | undefined {
  try {
    const resolved = fs.realpathSync.native(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return undefined;
  }
}

// ─── pln#641 (dec#151 option b) — business convergence of a FAILED turn ─────

export interface ReconcileFailedTurnInput {
  /** The reservation owning the dead attempt (resolved by the caller via findReservationByRunId). */
  reservation: TurnReservation;
  /** The run the transport reconciler just moved to failed/cancelled. */
  run: AgentRun;
  /** The transport-level reason, recorded as the turn's failure_reason. */
  reason: string;
  actor?: string;
  cwd?: string;
}

export interface ReconcileFailedTurnResult {
  /** True when the failure is durably recorded on the loop (or nothing was left to record). */
  converged: boolean;
  claim_released: boolean;
  reason: string;
}

/**
 * Converge a TURN-OWNED lane whose worker died at the TRANSPORT level (no lane
 * result will ever arrive). dec#151, operator-decided option (b): the lane's
 * claim is business state owned by its loop, so its release must be a business
 * decision recorded ON the loop — through the same convergence family harvest
 * uses (reconcileTurn) — never a side-effect of a transport verdict. Before
 * this, the trp#433 GC cascade released the claim straight from the transport
 * reconciler, which is exactly what the pln#638 6c effects boundary forbids.
 *
 * What "business decision" means concretely here: complete_turn(outcome:
 * 'failed') writes the failure into the loop journal FIRST (crash-atomic WAL),
 * and only then is the claim released — so a released claim always has a loop
 * record explaining WHY, and a crash between the two converges on the next
 * read-path pass (release is idempotent). Retry lanes are not starved: the
 * release happens in the same lazy pass that inferred the failure, just via
 * the loop's machinery instead of around it.
 *
 * Declines (converged:false — the claim STAYS, a later read-path pass retries):
 *   - containment mismatch (never converge another store's loop/claim);
 *   - lock contention (LockTimeout/LockLost);
 *   - loop missing (a claim should not be stripped on evidence we cannot read).
 * SUPERSEDED is converged:true WITHOUT release: a newer turn owns the slot, and
 * claim REUSE across rounds is real (trp_e824d2af) — releasing the old round's
 * claim would strip the live one.
 */
export function reconcileFailedTurn(input: ReconcileFailedTurnInput): ReconcileFailedTurnResult {
  const { reservation, run, cwd } = input;
  const actor = input.actor ?? 'reconciler';

  // Containment gate — same rule as reconcileTurn (§8 Q6), same win32 case-fold.
  const operatingRoot = path.resolve(cwd ?? process.cwd());
  const reservationRoot = path.resolve(reservation.store_root);
  const sameStore = process.platform === 'win32'
    ? reservationRoot.toLowerCase() === operatingRoot.toLowerCase()
    : reservationRoot === operatingRoot;
  if (!sameStore) {
    return { converged: false, claim_released: false, reason: `containment: reservation store_root ${reservation.store_root} != operating store ${operatingRoot}` };
  }

  try {
    return withLoopLock<ReconcileFailedTurnResult>({
      cwd,
      intent: 'reconcile-failed-turn',
      agentId: actor,
      scope: { kind: 'loop', loopId: reservation.loop_id },
      work: () => convergeFailedLockedTurn(reservation, run, input.reason, actor, cwd),
    });
  } catch (err) {
    if (err instanceof LockTimeoutError || err instanceof LockLostError) {
      return { converged: false, claim_released: false, reason: `deferred (${err.name}); the next read-path pass retries` };
    }
    throw err;
  }
}

function convergeFailedLockedTurn(
  reservation: TurnReservation,
  run: AgentRun,
  transportReason: string,
  actor: string,
  cwd: string | undefined,
): ReconcileFailedTurnResult {
  // Audit-exact release (review PR#166 round-2 P1): the event is emitted only
  // when THIS call performed the active→released transition. The check lives
  // INSIDE the claim store's own mutation (releaseClaimIfActive), so an
  // external bclaw_release_claim landing concurrently can no longer slip
  // between a caller-side check and the write and produce a phantom
  // business-release event.
  const releaseAudited = (claimId: string | undefined, why: string): boolean => {
    if (!claimId) return false;
    try {
      if (!releaseClaimIfActive(claimId, cwd).released) return false;
    } catch { return false; }
    try {
      createRuntimeEvent({
        agent: actor,
        event_type: 'run_failed',
        text: `Released claim ${claimId} as the BUSINESS convergence of failed turn ${reservation.turn_id}: ${why}`,
        tags: ['loops', 'reconcile', 'claim-release', 'effects-boundary'],
        assignment_id: run.assignment_id,
        run_id: run.id,
        claim_id: claimId,
        status_reason: 'turn_failure_business_release',
      }, cwd);
    } catch { /* observability best-effort — never undo the release */ }
    return true;
  };

  const loop = getLoop(reservation.loop_id, cwd);
  if (!loop) {
    // No loop to record on — do NOT strip the claim on evidence we cannot read.
    // A genuinely deleted loop leaves the claim to the staleness sweep.
    return { converged: false, claim_released: false, reason: `loop ${reservation.loop_id} not found — claim retained for the staleness sweep` };
  }

  const authoritativeClaimId = loadAssignment(run.assignment_id, cwd)?.claim_id ?? run.claim_id ?? reservation.claim_id;

  // Terminal loop: the business story is already over — releasing is pure
  // idempotent cleanup, mirroring reconcileTurn's terminal early-return.
  if (LOOP_TERMINAL.has(loop.status)) {
    const released = releaseAudited(authoritativeClaimId, `loop already ${loop.status}`);
    return { converged: true, claim_released: released, reason: `loop already ${loop.status} — release-only cleanup` };
  }

  const slot = loop.slots.find((s) => s.slot_id === reservation.slot_id);
  if (!slot) {
    return { converged: false, claim_released: false, reason: `slot ${reservation.slot_id} not in loop ${reservation.loop_id} — claim retained` };
  }

  // Superseded: a NEWER turn owns this slot. Claim reuse across rounds is real
  // (trp_e824d2af — round 2 rode round 1's claim), so releasing here would strip
  // the LIVE attempt. Nothing to do for the dead round; the live one converges it.
  if (slot.current_turn_id !== undefined && slot.current_turn_id !== reservation.turn_id) {
    return { converged: true, claim_released: false, reason: `turn ${reservation.turn_id} superseded by ${slot.current_turn_id} — claim belongs to the live turn` };
  }

  // Record the business failure on the loop FIRST (crash-atomic WAL), then
  // release. A slot already terminal means a prior pass recorded it — skip the
  // double-record, still release (idempotent).
  const slotTerminal = slot.status === 'done' || slot.status === 'failed' || slot.status === 'cancelled';
  if (!slotTerminal) {
    try {
      complete_turn({
        id: loop.id,
        slot_id: slot.slot_id,
        actor,
        outcome: 'failed',
        failure_reason: transportReason,
      }, cwd);
    } catch (err) {
      return { converged: false, claim_released: false, reason: `complete_turn failed: ${err instanceof Error ? err.message : String(err)} — claim retained, next pass retries` };
    }
  }

  // Assignment is a business projection of the same failed turn. Leaving it
  // offered/started while the run, slot, and claim are terminal recreates the
  // orphaned-state ambiguity this convergence path exists to remove.
  const assignment = loadAssignment(run.assignment_id, cwd);
  if (assignment && !['completed', 'failed', 'blocked', 'timed_out', 'cancelled', 'expired', 'rerouted'].includes(assignment.status)) {
    try {
      transitionAssignment(assignment.id, 'failed', {
        actor,
        syncAgentRun: false,
        status_reason: `turn ${reservation.turn_id} failed: ${transportReason}`,
      }, cwd);
    } catch (err) {
      return {
        converged: false,
        claim_released: false,
        reason: `assignment failure projection failed: ${err instanceof Error ? err.message : String(err)} — claim retained, next pass retries`,
      };
    }
  }

  const released = releaseAudited(authoritativeClaimId, transportReason);
  return {
    converged: true,
    claim_released: released,
    reason: slotTerminal
      ? `turn ${reservation.turn_id} failure already recorded — release re-attempted`
      : `turn ${reservation.turn_id} failure recorded on loop ${loop.id}; claim ${released ? 'released' : 'not active'}`,
  };
}
