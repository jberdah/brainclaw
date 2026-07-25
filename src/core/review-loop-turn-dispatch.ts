/**
 * pln#628 Focus 4B PR2 — reusable "dispatch one review-loop turn".
 *
 * PR1 wired the harvest→loop direction (a reviewer verdict advances/closes the
 * loop). PR2 makes the request_changes→fix→re-review cycle autonomous, which
 * means the harvest close path must be able to SPAWN the next turn's worker
 * (the author to apply fixes, then the reviewer to re-review). The full spawn
 * chain — coordinator claim + assignment + slot binding + brief + queued inbox
 * message + CLI spawn — used to live only as closures inside the
 * bclaw_coordinate review handler (mcp-write-coordination.ts). This module
 * lifts that chain into a standalone, closure-free function the harvest path
 * can call.
 *
 * Layering (mirrors review-loop-close.ts's cycle-avoidance note): this is a
 * core module that imports the heavy dispatch primitives (execution, dispatcher,
 * claims, messaging, assignments). review-loop-close.ts stays PURE (loops +
 * schema only) and merely RETURNS a `NextTurn` descriptor; harvest.ts is the
 * command-level orchestrator that owns both and calls this to spawn. Nothing
 * here imports harvest or review-loop-close, so no import cycle is introduced.
 */
import { createCoordinatorClaim, attachAssignmentMessageToClaim, linkClaimToAssignment } from './claims.js';
import { createAssignment, transitionAssignment, generateAssignmentId, patchAssignmentMessageId, loadAssignment } from './assignments.js';
import { turn } from './loops/verbs.js';
import { getLoop } from './loops/store.js';
import { generateDispatchBrief } from './dispatcher.js';
import { sendMessage } from './messaging.js';
import { buildInvokeCommand, resolveModel } from './agent-capability.js';
import { attemptExecution } from './execution.js';
import type { TurnEcho } from './execution-adapters.js';
import { createAgentRun, loadAgentRun, transitionAgentRun } from './agentruns.js';
import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, launchGrant,
  deriveTurnId, deriveChildIds, ReservationStateError, LaunchFenceError,
} from './loops/attempt-reservation.js';
import type { LoopSlot } from './loops/types.js';

/**
 * pln#630 PR2c-b — opt-in flag gating the turn-owned (exactly-once) review
 * dispatch path. DEFAULT OFF; must stay off through PR2c-b + PR3 and be flipped
 * only in PR4 after the §9 conformance harness proves it (a turn-owned run that
 * genuinely completes stays `created` until reconcileTurn/PR3 finalizes it — so
 * enabling this before PR3 would stall successful turns). Flag-off is a
 * byte-identical no-op: the legacy dispatch below runs unchanged.
 */
export function turnOwnedReviewEnabled(): boolean {
  return process.env.BRAINCLAW_TURN_OWNED_REVIEW === '1';
}

/** Dispatch lease budget for a turn-owned attempt (reserve + launch grant). Long
 *  enough that reserve→arm→consume→spawn→run-`running` never expires a genuinely
 *  launching worker under the PR2c-lease pre-run reconciler; a live `running` run
 *  is out of that reconciler's scope so this only bounds the pre-spawn window. */
const TURN_OWNED_LEASE_MS = 10 * 60_000;

/**
 * The outcome of preparing a turn-owned attempt (dec#144). `legacy` = fail-open
 * BEFORE identity was reserved → the caller runs the unchanged legacy path.
 * `denied` = the exactly-once fence said this dispatch is NOT the spawner
 * (adopted / crossed / revoked / lease-expired) → the caller MUST NOT spawn and
 * MUST NOT fall back to legacy (that would double-spawn beside the live
 * reservation). `won` = this dispatch crossed the fence → spawn with `turnEcho`.
 */
type TurnOwnedPrep =
  | { kind: 'legacy' }
  | { kind: 'denied'; reason: string }
  | { kind: 'won'; assignmentId: string; runId: string; turnId: string; nonce: string };

export interface PrepareTurnOwnedReviewInput {
  loopId: string;
  slotId: string;
  agent: string;
  agentId?: string;
  phase: string;
  task: string;
  description: string;
  scope: string;
  claimId: string;
  worktreePath?: string;
  dispatcherAgent: string;
  dispatcherAgentId?: string;
  sessionId?: string;
  isReviewer: boolean;
  cwd: string;
}

/**
 * Prepare a turn-owned review dispatch (pln#630 PR2c-b, design dec#144). Runs the
 * exactly-once machine INLINE in the coordinator (which has store access, unlike
 * the sandboxed worktree — trp_26e9634b): deterministic turn_id → reserve/adopt →
 * commit → arm/adopt → consume, spawning ONLY on the winning consume.
 *
 * FAIL-CLOSED after `reserve`: once identity is claimed, any error aborts as
 * `denied` (never legacy) so an ungated legacy worker can never spawn beside a
 * live reservation (the adversarial double-spawn hole, dec#144 MUST-FIX 1). Only
 * a failure BEFORE identity is reserved degrades to `legacy`.
 */
export function prepareTurnOwnedReviewDispatch(input: PrepareTurnOwnedReviewInput): TurnOwnedPrep {
  const { loopId, slotId, claimId, cwd } = input;

  // ── Snapshot the loop BEFORE turn() bumps its version (dec#139 item 3). ──
  let iteration: number;
  let version: number;
  try {
    const thread = getLoop(loopId, cwd);
    if (!thread) return { kind: 'legacy' }; // loop not found — pre-identity, safe to degrade
    iteration = thread.iteration_count;
    version = thread.version;
  } catch {
    return { kind: 'legacy' };
  }

  const turnId = deriveTurnId(loopId, slotId, iteration);
  const { assignment_id: assignmentId, run_id: runId } = deriveChildIds(turnId);
  const lease = new Date(Date.now() + TURN_OWNED_LEASE_MS).toISOString();

  // ── Phase 1: claim identity. Fail-OPEN allowed ONLY here (nothing reserved yet). ──
  try {
    reserve({
      turn_id: turnId,
      loop_id: loopId,
      slot_id: slotId,
      target_slot_generation: iteration, // LoopSlot has no generation field — observational proxy (dec#144 #8)
      loop_version_at_reserve: version,
      agent: input.agent,
      agent_id: input.agentId,
      claim_id: claimId,
      phase: input.phase,
      iteration,
      store_root: cwd,
      cwd,
      lease_deadline: lease,
    }, cwd);
  } catch (err) {
    if (err instanceof ReservationStateError && err.code === 'reservation_exists') {
      // A concurrent dispatch already OWNS this turn_id — adopt it and fall
      // through to the fail-closed consume path (we may still legitimately win
      // the fence if the owner reserved-but-never-crossed; otherwise denied).
    } else {
      // FAIL-CLOSED (review Finding 1): any other reserve outcome is
      // INDETERMINATE — a lock timeout (a live holder mid-critical-section),
      // lock-lost, or unknown error does NOT prove that no identity was claimed.
      // Degrading to `legacy` here would spawn an ungated worker beside a
      // reservation that may well exist — the exact concurrent-dispatch
      // double-spawn MUST-FIX 1 closes. (A definitively pre-identity error is
      // unreachable here: the lease we build is always parseable, and
      // loop-not-found is handled before reserve.)
      return { kind: 'denied', reason: `reserve indeterminate — fail-closed (no legacy fallback): ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── Phase 2: FAIL-CLOSED. Identity is reserved; never legacy-spawn from here. ──
  try {
    commitReservation(turnId, cwd);

    // Arm-or-adopt the launch grant. Only arm when none exists; a concurrent
    // arm surfaces as `already_armed` → adopt the incumbent grant.
    let grant = launchGrant(turnId, cwd);
    if (!grant) {
      try {
        armLaunch(turnId, { epoch: 0, lease_deadline: lease }, cwd);
      } catch (err) {
        if (!(err instanceof LaunchFenceError && err.code === 'already_armed')) {
          // dispatch_lease_expired / lease_invalid / not_committed → do-not-spawn.
          return { kind: 'denied', reason: `arm_refused: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      grant = launchGrant(turnId, cwd);
    }
    // A crossed grant = launch_attempted_unknown (worker already invoked, never
    // re-spawn); revoked = never-launch; absent = arm failed → all do-not-spawn.
    if (!grant || grant.status !== 'armed') {
      return { kind: 'denied', reason: `launch_denied: grant is ${grant?.status ?? 'absent'} (not armed)` };
    }

    // Consume the grant — the atomic exactly-once SPAWN authority.
    let wonTransition: boolean;
    try {
      ({ wonTransition } = consumeLaunchGrant(turnId, grant.token, grant.epoch, cwd));
    } catch (err) {
      return { kind: 'denied', reason: `launch_denied: consume refused (${err instanceof Error ? err.message : String(err)})` };
    }
    if (!wonTransition) {
      // Adopted — another invocation crossed the fence. MUST NOT spawn.
      return { kind: 'denied', reason: 'launch_denied: grant already crossed by a concurrent dispatch' };
    }

    // ── WON: this dispatch is the SOLE spawner. Bind slot + run to MY live claim
    // (claimId), NOT the reservation's first-reserver claim (dec#144 #3) — else a
    // recovery-winner would bind the slot to a dead claim and break complete_turn
    // auth. Mints are idempotent (save overwrites, so guard on load). ──
    if (!loadAssignment(assignmentId, cwd)) {
      createAssignment({
        id: assignmentId,
        short_label: assignmentId,
        claim_id: claimId,
        agent: input.agent,
        dispatcher_agent: input.dispatcherAgent,
        dispatcher_session_id: input.sessionId,
        scope: input.scope,
        description: input.description,
        tags: ['coordinate', 'review', 'loop', 'turn-owned', input.isReviewer ? 're-review' : 'author-fix'],
      }, cwd);
    }
    if (!loadAgentRun(runId, cwd)) {
      createAgentRun({
        id: runId,
        short_label: runId,
        assignment_id: assignmentId,
        claim_id: claimId,
        agent: input.agent,
        agent_id: input.agentId,
        transport: 'cli_spawn',
        status: 'created',
        scope: input.scope,
        description: input.description,
        worktree_path: input.worktreePath,
        tags: ['turn-owned', 'review', 'loop'],
      }, cwd);
    }
    turn({
      id: loopId,
      slot_id: slotId,
      actor: input.dispatcherAgentId ?? input.dispatcherAgent,
      input: input.task,
      turn_id: turnId,
      assignment_id: assignmentId,
      claim_id: claimId,
    }, cwd);

    return { kind: 'won', assignmentId, runId, turnId, nonce: grant.token };
  } catch (err) {
    // FAIL-CLOSED: identity reserved; degrade to denied, NEVER legacy.
    return { kind: 'denied', reason: `turn-owned prep aborted after reserve: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The structured signal a reviewer must emit in LANE-RESULT.json so harvest can
 * map its lane back onto the loop. Shared by the initial dispatch and every
 * re-review turn (identical wording keeps the reviewer contract stable).
 */
export const REVIEW_VERDICT_BRIEF_SUFFIX =
  '\n\n## Review verdict (required — drives autonomous loop convergence)\n'
  + 'In your LANE-RESULT.json set "status":"completed" AND add "review_verdict": '
  + '"approve" (change is good to merge) or "request_changes" (needs fixes), plus '
  + '"review_summary":"<one-line rationale>". The coordinator reads review_verdict '
  + 'to close the review loop on approve, or continue the fix cycle on request_changes.';

export interface DispatchReviewLoopTurnInput {
  loopId: string;
  /** The slot being dispatched (author or reviewer) — already resolved by the caller. */
  slot: Pick<LoopSlot, 'slot_id' | 'role' | 'agent' | 'agent_id'>;
  /** Loop phase this turn runs in (findings | author_response | followup_review …). */
  phase: string;
  /** Human-readable task/brief body (findings to fix, or re-review instructions). */
  task: string;
  /** Coordinator identity performing the dispatch (harvest actor). */
  dispatcherAgent: string;
  dispatcherAgentId?: string;
  sessionId?: string;
  /** Git ref the turn's worktree forks from (the ref currently under review). */
  worktreeBaseRef?: string;
  /** Model override, decoupled from agent identity (resolveModel chain). */
  model?: string;
  cwd?: string;
}

export interface DispatchReviewLoopTurnResult {
  loop_id: string;
  slot_id: string;
  role?: string;
  agent: string;
  phase: string;
  claim_id?: string;
  assignment_id?: string;
  message_id?: string;
  worktree_path?: string;
  execution_status?: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
  /** Manual launch command when the spawn did not auto-start (fallback for the operator). */
  command?: string;
  shell?: string;
  /** Populated when the whole dispatch failed before/at spawn (never thrown to the caller). */
  error?: string;
}

/**
 * Dispatch a single review-loop turn: create the coordinator claim + assignment,
 * bind the slot to them (so harvest resolves the exact slot by assignment_id),
 * build + queue the brief, and spawn the worker CLI.
 *
 * Best-effort and non-throwing: any failure is returned in `.error` so the
 * caller (harvest) can record it as a warning without aborting the harvest —
 * the loop simply stays open awaiting a manual turn. Mirrors the resilience of
 * the initial reviewer dispatch (which pushes a warning and leaves the loop open
 * on failure) rather than the fail-fast style of a user-facing command.
 */
export async function dispatchReviewLoopTurn(
  input: DispatchReviewLoopTurnInput,
): Promise<DispatchReviewLoopTurnResult> {
  const { loopId, slot, phase } = input;
  // createCoordinatorClaim / sendMessage require a concrete cwd; the harvest
  // caller always supplies one — default defensively for direct callers/tests.
  const cwd = input.cwd ?? process.cwd();
  const agent = slot.agent ?? '';
  const scope = `review-loop:${loopId}`;
  const isReviewer = slot.role === 'reviewer';
  const result: DispatchReviewLoopTurnResult = {
    loop_id: loopId,
    slot_id: slot.slot_id,
    role: slot.role,
    agent,
    phase,
  };

  try {
    const description =
      `Review loop turn for ${loopId} slot ${slot.slot_id} phase ${phase}. ${input.task}`;

    const claimResult = createCoordinatorClaim({
      agent,
      scope,
      description,
      dispatcherAgent: input.dispatcherAgent,
      sessionId: input.sessionId,
      cwd,
      worktreeBaseRef: input.worktreeBaseRef,
    });
    result.claim_id = claimResult.claimId;
    result.worktree_path = claimResult.worktreePath;

    let assignmentId: string | undefined;
    let turnEcho: TurnEcho | undefined;
    let runLegacyProjection = true;

    // pln#630 PR2c-b — turn-owned (exactly-once) dispatch, flag-gated (default off)
    // + FAIL-CLOSED after reserve. Flag-off → runLegacyProjection stays true and
    // this branch is a byte-identical no-op (the legacy projection below runs).
    if (turnOwnedReviewEnabled()) {
      const prep = prepareTurnOwnedReviewDispatch({
        loopId,
        slotId: slot.slot_id,
        agent,
        agentId: slot.agent_id,
        phase,
        task: input.task,
        description,
        scope,
        claimId: claimResult.claimId,
        worktreePath: claimResult.worktreePath,
        dispatcherAgent: input.dispatcherAgent,
        dispatcherAgentId: input.dispatcherAgentId,
        sessionId: input.sessionId,
        isReviewer,
        cwd,
      });
      if (prep.kind === 'denied') {
        // The exactly-once fence says this dispatch is NOT the spawner (adopted /
        // crossed / revoked / lease-expired). MUST NOT spawn AND MUST NOT fall back
        // to legacy — a legacy spawn beside the live reservation is the double-spawn
        // hole the fence exists to close (dec#144 MUST-FIX 1).
        //
        // Do NOT release the coordinator claim here (review Finding 2, round 2):
        // createCoordinatorClaim dedups on scope+agent, so a same-turn concurrent
        // dispatch SHARES one claim C1 — and claim-creation order is uncoupled from
        // fence-crossing order (different locks), so the loser can be C1's creator
        // while the WINNER merely reused it and bound its slot/run/assignment to C1.
        // releaseClaim() runs unauthenticated with no active-binding guard, so ANY
        // release in the denied path can flip a claim a live winner depends on to
        // `released` (re-opening the slot.claim_id divergence MUST-FIX 3 closed). A
        // genuine orphan — the rare double-failure where no dispatch wins — is
        // low-harm and reaped by the claim staleness sweep (auto_release_after_hours);
        // sabotaging a live winner is high-harm and not self-healing. So we leave it.
        result.execution_status = 'inbox_only';
        result.error = prep.reason;
        return result;
      }
      if (prep.kind === 'won') {
        // Deterministic assignment mint + slot binding already happened inside
        // prepare; skip the legacy projection and carry the turn-keyed echo so the
        // ack-wrapper writes a turn-keyed completion sentinel.
        assignmentId = prep.assignmentId;
        result.assignment_id = prep.assignmentId;
        turnEcho = { turn_id: prep.turnId, run_id: prep.runId, nonce: prep.nonce };
        runLegacyProjection = false;
      }
      // prep.kind === 'legacy' (fail-open BEFORE identity) → fall through unchanged.
    }

    if (runLegacyProjection) {
      try {
        const preId = generateAssignmentId(cwd);
        const assignment = createAssignment(
          {
            id: preId.id,
            short_label: preId.short_label,
            claim_id: claimResult.claimId,
            agent,
            dispatcher_agent: input.dispatcherAgent,
            dispatcher_session_id: input.sessionId,
            scope,
            description,
            tags: ['coordinate', 'review', 'loop', isReviewer ? 're-review' : 'author-fix'],
          },
          cwd,
        );
        assignmentId = assignment.id;
        result.assignment_id = assignment.id;
      } catch (asgErr) {
        result.error = `assignment creation failed: ${asgErr instanceof Error ? asgErr.message : String(asgErr)}`;
      }

      // Bind the slot to the new claim/assignment (PR1 BLOCKING 2 invariant): a
      // later harvest must resolve THIS slot by assignment_id, not by agent name
      // (which is ambiguous under symmetric multi-reviewer loops). Runs even if
      // assignment creation failed (undefined id → legacy agent-match fallback).
      turn(
        {
          id: loopId,
          slot_id: slot.slot_id,
          actor: input.dispatcherAgentId ?? input.dispatcherAgent,
          input: input.task,
          assignment_id: assignmentId,
          claim_id: claimResult.claimId,
        },
        cwd,
      );
    }

    // Reviewer turns must carry the verdict contract; author-fix turns must not
    // (an author lane has no verdict — it's mapped by scope+slot instead).
    const briefTask = isReviewer ? input.task + REVIEW_VERDICT_BRIEF_SUFFIX : input.task;
    const brief = generateDispatchBrief({
      task: briefTask,
      agent,
      claimId: claimResult.claimId,
      scope,
      worktreePath: claimResult.worktreePath,
      assignmentId,
    });

    const msg = sendMessage(
      {
        from: input.dispatcherAgent,
        to: agent,
        type: 'review',
        text: brief,
        ref: loopId,
        scope,
        requires_ack: true,
        claim_id: claimResult.claimId,
        assignment_id: assignmentId,
        tags: ['coordinate', 'review', 'loop', isReviewer ? 're-review' : 'author-fix'],
        author_id: input.dispatcherAgentId,
        session_id: input.sessionId,
        payload: {
          intent: 'review',
          loop_id: loopId,
          slot_id: slot.slot_id,
          phase,
          scope,
          claim_id: claimResult.claimId,
          ...(assignmentId ? { assignment_id: assignmentId } : {}),
          worktree_path: claimResult.worktreePath,
        },
      },
      cwd,
    );
    result.message_id = msg.id;

    if (assignmentId) {
      try {
        attachAssignmentMessageToClaim(claimResult.claimId, msg.id, cwd);
        linkClaimToAssignment(claimResult.claimId, assignmentId, cwd);
        transitionAssignment(assignmentId, 'offered', { actor: input.dispatcherAgent }, cwd);
        patchAssignmentMessageId(assignmentId, msg.id, cwd);
      } catch (linkErr) {
        result.error = `assignment linkage failed: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`;
      }
    }

    const invoke = buildInvokeCommand(agent, brief, {
      mode: 'worker',
      model: resolveModel(agent, { override: input.model }),
    });

    const execResult = await attemptExecution(invoke, {
      agent,
      autoExecute: true,
      worktreePath: claimResult.worktreePath,
      claimId: claimResult.claimId,
      assignmentId,
      dispatcherAgent: input.dispatcherAgent,
      dispatcherAgentId: input.dispatcherAgentId,
      cwd,
      requireWorktree: true, // never spawn a worker in the integration repo (pln#531)
      turnEcho, // pln#630 PR2c-b — undefined on the legacy path (wrapper unchanged)
    });
    result.execution_status = execResult.execution_status;
    result.command = execResult.command;
    result.shell = execResult.shell;
    if (execResult.error && !result.error) result.error = execResult.error;

    // pln#630 PR2c-b — a turn-owned run was preallocated `created`; once the
    // worker actually spawned, move it to `running` so it leaves the PR2c-lease
    // pre-run lease scope (created/launching) and is governed by the heartbeat
    // reconciler instead. If it did NOT start, leave it `created` → the pre-run
    // reconciler converges it (crossed → launch_attempted_unknown) at lease.
    if (turnEcho && execResult.execution_status === 'delivered_and_started') {
      try {
        transitionAgentRun(turnEcho.run_id, 'running', { actor: input.dispatcherAgent, status_reason: 'turn-owned worker spawned' }, cwd);
      } catch { /* best-effort — the reconciler converges if this races */ }
    }

    return result;
  } catch (err) {
    result.error = `review-loop turn dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
}
