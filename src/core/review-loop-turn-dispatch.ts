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
import { createAssignment, transitionAssignment, generateAssignmentId, patchAssignmentMessageId } from './assignments.js';
import { turn } from './loops/verbs.js';
import { generateDispatchBrief } from './dispatcher.js';
import { sendMessage } from './messaging.js';
import { buildInvokeCommand, resolveModel } from './agent-capability.js';
import { attemptExecution } from './execution.js';
import type { LoopSlot } from './loops/types.js';

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
    });
    result.execution_status = execResult.execution_status;
    result.command = execResult.command;
    result.shell = execResult.shell;
    if (execResult.error && !result.error) result.error = execResult.error;

    return result;
  } catch (err) {
    result.error = `review-loop turn dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
}
