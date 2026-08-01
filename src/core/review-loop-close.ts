/**
 * pln#628 Focus 4B — assignment/lane → review-loop close (the missing direction).
 *
 * The review Loop is opened, its reviewer slot created, and the worker spawned
 * automatically by bclaw_coordinate(intent='review', open_loop=true). But after
 * the worker runs, nothing turned its result back into a loop state transition:
 * the worker reports via LANE-RESULT.json, and no code mapped that into
 * complete_turn + advance, so `reviewer_green` was never evaluated and a human
 * had to drive the loop closed by hand (dec_a0d16802).
 *
 * PR1 closed the LGTM path: a harvested lane carrying `review_verdict: approve`
 * records an accepted `verdict` artifact and advances the loop, which auto-closes
 * on `reviewer_green` (verbs.ts:evaluateStopCondition).
 *
 * PR2 makes `request_changes` converge autonomously too (symmetric mode). Instead
 * of stalling, it records the changes-requested verdict, bumps the loop's round
 * counter (advance to the same phase → iteration_count += 1), and — unless the
 * `max_iterations` cap is hit (→ auto-close as `blocked` for a human) — returns a
 * `next_turn` + `keep_claim` so harvest re-dispatches the SAME reviewer slot into
 * the SAME persistent worktree. The reviewer applies the requested fixes and
 * re-reviews; commits accumulate on one branch (no fresh-worktree-per-turn, so the
 * branch-per-scope / refuse-unharvested invariants are never violated). The
 * reverse direction (loop terminal → assignment converge) is the existing Layer B
 * backstop in assignment-reconciler.ts; this is Layer A's complement for review loops.
 *
 * Robustness (Codex review of #87):
 *  - The compound complete_turn + advance runs under `withLoopLock`, so a
 *    concurrent harvest can't interleave the two writes (BLOCKING 3).
 *  - It is CONVERGENT, not fire-once: if a prior pass recorded an accepted
 *    verdict but died before advancing, a later pass resumes the advance instead
 *    of no-op'ing on the already-completed slot (BLOCKING 3).
 *  - The reviewer slot is resolved STRICTLY by assignment_id when slots are
 *    bound (they are, since #87's coordinate-handler fix), so symmetric
 *    (multi-reviewer) loops complete the correct slot — not "any active
 *    reviewer" (BLOCKING 2). Legacy unbound slots fall back to role + agent.
 *
 * Kept in its own core module (like assignment-reconciler.ts) to avoid an import
 * cycle: loops/store → assignments; this → loops + schema; harvest.ts → this.
 */
import type { Assignment, LaneResult } from './schema.js';
import { getLoop } from './loops/store.js';
import { complete_turn, advance } from './loops/verbs.js';
import { withLoopLock } from './loops/lock.js';
import { LOOP_ARTIFACT_BODY_MAX_BYTES } from './loops/types.js';
import type { LoopArtifact, LoopSlot, LoopThread } from './loops/types.js';

/** review-loop:lop_xxx → the loop id (mirrors assignment-reconciler.ts). */
const REVIEW_LOOP_SCOPE_RE = /^review-loop:(lop_[0-9a-z]+)/;
const LOOP_TERMINAL = new Set(['completed', 'cancelled', 'blocked']);

/** Keep the loop-facing verdict valid while the full worker body stays durable in harvest metadata. */
function capVerdictBody(prefix: string, detail: string): string {
  const full = `${prefix}${detail ? `: ${detail}` : ''}`;
  if (Buffer.byteLength(full, 'utf8') <= LOOP_ARTIFACT_BODY_MAX_BYTES) return full;
  const marker = '…[truncated; full body retained in lane harvest event]';
  const room = LOOP_ARTIFACT_BODY_MAX_BYTES - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(': ', 'utf8') - Buffer.byteLength(marker, 'utf8');
  return `${prefix}: ${Buffer.from(detail, 'utf8').subarray(0, Math.max(0, room)).toString('utf8').replace(/�+$/, '')}${marker}`;
}

/**
 * pln#628 Focus 4B PR2 — the next turn the coordinator should dispatch to keep
 * the review loop converging autonomously. Emitted on a `request_changes` that
 * did NOT hit the iteration cap: the same reviewer slot takes another turn in
 * the SAME (persistent) worktree, applying the requested fixes and re-reviewing.
 * Symmetric mode only in v1 (a single agent both fixes and reviews); the reused
 * worktree keeps commits accumulating on one branch, sidestepping the
 * branch-per-scope / refuse-unharvested-commits worktree invariants that a
 * fresh-worktree-per-turn design would violate (can_2e282880).
 */
export interface ReviewLoopNextTurn {
  slot_id: string;
  role: string;
  agent: string;
  agent_id?: string;
  phase: string;
  /** Round index (loop.iteration_count) this turn belongs to, for observability. */
  iteration: number;
  /** Brief body for the re-dispatched fix+re-review turn (findings-aware). */
  task: string;
}

/** Build the fix+re-review brief for a request_changes cycle turn (symmetric).
 *  Exported so the turn-owned reconcile path (pln#630 PR3b) reuses the identical
 *  wording — the reviewer contract must not drift between the legacy and turn-owned
 *  fix cycles. */
export function buildFixCycleTask(summary: string, iteration: number): string {
  return (
    `The reviewer requested changes (fix cycle round ${iteration}). `
    + 'Apply the requested changes DIRECTLY in this worktree (it is the same '
    + 'checkout, kept across turns so your commits accumulate), then RE-REVIEW '
    + 'the result. Set review_verdict="approve" once the change is correct and '
    + 'complete, or "request_changes" to take another pass.'
    + (summary ? `\n\nRequested changes: ${summary}` : '')
  );
}

export interface ReviewLoopCloseResult {
  loop_id: string;
  verdict: 'approve' | 'request_changes';
  /** What the callback did: closed the loop, advanced a phase, or no-op'd. */
  action: 'closed' | 'advanced' | 'noop';
  reason: string;
  /** Loop status after the call (for observability / tests). */
  loop_status?: string;
  /**
   * PR2: when true, the coordinator (harvest) must NOT release the claim /
   * tear down the worktree — the fix cycle reuses it for `next_turn`. When
   * false/absent, harvest tears down as usual (approve close, or blocked cap).
   */
  keep_claim?: boolean;
  /** PR2: the turn to re-dispatch into the kept worktree (present iff keep_claim). */
  next_turn?: ReviewLoopNextTurn;
}

/** Mirrors verbs.ts:isVerdictAccepted — reviewer_green fires only on a `verdict`
 * artifact whose body starts with "accepted". */
function isAcceptedVerdict(artifact: LoopArtifact): boolean {
  if (artifact.type !== 'verdict') return false;
  return /^accepted(?:\b|[:\s])/.test((artifact.body ?? '').trim().toLowerCase());
}

/**
 * Resolve the reviewer slot to complete. STRICT binding first: the active slot
 * whose assignment_id matches this lane's assignment (the #87 coordinate fix
 * stamps it), so symmetric loops target the right reviewer. If OTHER slots are
 * bound but none matches ours, refuse (never complete someone else's slot).
 * Falls back to a single active reviewer / agent match only for legacy unbound
 * slots. Returns undefined when no active reviewer slot is ours — the caller
 * then checks the resume path.
 */
function resolveReviewerSlot(loop: LoopThread, assignment: Pick<Assignment, 'id' | 'agent'>): LoopSlot | undefined {
  const active = loop.slots.filter(
    (s) => s.role === 'reviewer' && s.status !== 'done' && s.status !== 'cancelled' && s.status !== 'failed',
  );
  if (active.length === 0) return undefined;
  if (assignment.id) {
    const bound = active.find((s) => s.assignment_id === assignment.id);
    if (bound) return bound;
    // Some active slots are bound to OTHER assignments — do not guess/steal.
    if (active.some((s) => s.assignment_id !== undefined)) return undefined;
  }
  // Legacy unbound slots: single reviewer, else disambiguate by agent.
  if (active.length === 1) return active[0];
  const byAgent = assignment.agent ? active.find((s) => s.agent === assignment.agent) : undefined;
  return byAgent ?? active[0];
}

/**
 * Map a harvested review lane onto its loop and close/advance it.
 *
 * Fires ONLY when the assignment scope is a review-loop (`review-loop:lop_…`)
 * AND the lane carries a `review_verdict` — otherwise returns undefined and the
 * caller (harvest) proceeds unchanged. Idempotent, convergent, and defensive:
 * a terminal loop is a no-op, a partial prior pass is resumed, and any
 * loop-verb / lock error is swallowed into a `noop` result so a loop-close
 * failure never breaks harvest (mirrors convergeSlotAssignmentsForClosedLoop).
 */
export interface CloseReviewLoopOptions {
  /**
   * PR2: whether a `request_changes` verdict may advance the round counter and
   * emit a `next_turn` for the fix cycle. Only the `--integrate` path sets this
   * true — it is the one that can both re-dispatch the next turn AND keep the
   * claim/worktree alive. The report-only path passes false so it never advances
   * a request_changes cycle it cannot follow through on (which would strand the
   * loop mid-round with the claim released). Approve-close fires on both paths.
   * Default true (safe for the primary integrate caller).
   */
  cycleOnRequestChanges?: boolean;
}

export function closeReviewLoopFromLaneResult(
  assignment: Pick<Assignment, 'id' | 'scope' | 'agent'>,
  lane: Pick<LaneResult, 'review_verdict' | 'review_summary'>,
  actor: string,
  cwd?: string,
  options?: CloseReviewLoopOptions,
): ReviewLoopCloseResult | undefined {
  const scopeMatch = assignment.scope?.match(REVIEW_LOOP_SCOPE_RE);
  if (!scopeMatch) return undefined;
  if (!lane.review_verdict) return undefined;
  const cycleOnRequestChanges = options?.cycleOnRequestChanges ?? true;

  const loopId = scopeMatch[1]!;
  const verdict = lane.review_verdict;

  const noop = (reason: string, loop_status?: string): ReviewLoopCloseResult => ({
    loop_id: loopId, verdict, action: 'noop', reason, loop_status,
  });

  try {
    // Lock the loop so the compound complete_turn + advance can't interleave
    // with a concurrent harvest (BLOCKING 3). All state is re-read inside.
    return withLoopLock<ReviewLoopCloseResult>({
      cwd,
      intent: 'review-harvest-close',
      agentId: actor,
      scope: { kind: 'loop', loopId },
      work: () => {
        const loop = getLoop(loopId, cwd);
        if (!loop) return noop('loop not found');
        if (LOOP_TERMINAL.has(loop.status)) return noop(`loop already ${loop.status}`, loop.status);

        const slot = resolveReviewerSlot(loop, assignment);
        const acceptedVerdictExists = loop.artifacts.some(isAcceptedVerdict);
        const detail = ((lane as Pick<LaneResult, 'body'>).body ?? lane.review_summary ?? '').trim();

        // ── approve → close on reviewer_green ───────────────────────────────
        if (verdict === 'approve') {
          if (slot) {
            // isVerdictAccepted fires reviewer_green ONLY on an "accepted…" body.
            complete_turn(
              {
                id: loopId, slot_id: slot.slot_id, actor,
                artifact: { phase: loop.current_phase, type: 'verdict', body: capVerdictBody('accepted', detail) },
              },
              cwd,
            );
          } else if (!acceptedVerdictExists) {
            // No slot to complete and no accepted verdict recorded → a prior pass
            // already processed this (idempotent no-op).
            return noop('already processed (no active reviewer slot; no accepted verdict to resume)', loop.status);
          }
          // Advance: closes on reviewer_green. Convergent — safe whether we just
          // recorded the verdict or are resuming an interrupted approve.
          const advanced = advance({ id: loopId, actor }, cwd);
          return {
            loop_id: loopId,
            verdict,
            action: advanced.auto_closed ? 'closed' : 'advanced',
            reason: advanced.auto_closed
              ? `reviewer_green → loop ${advanced.loop.status}`
              : `accepted verdict recorded → advanced to "${advanced.loop.current_phase}"`,
            loop_status: advanced.loop.status,
          };
        }

        // ── request_changes → autonomous fix cycle (PR2) ────────────────────
        if (!slot) {
          // The cycle already advanced + re-dispatched on the first pass (the
          // re-dispatched slot is now bound to a NEWER assignment, so
          // resolveReviewerSlot returned undefined here → idempotent no-op).
          return noop('already processed (no active reviewer slot to cycle)', loop.status);
        }
        if (!cycleOnRequestChanges) {
          // Report-only path: never advance a cycle it can't follow through on
          // (no re-dispatch, no claim retention). Defer to `harvest --integrate`.
          return noop('request_changes deferred to --integrate (report path does not cycle)', loop.status);
        }

        // Codex review P1 — the autonomous fix cycle is SYMMETRIC-only in v1: it
        // asks the SAME reviewer slot to modify AND re-review in the reused
        // worktree, which is only sound when both roles are the same coding agent
        // (mode='symmetric'). Review loops DEFAULT to asymmetric, where the
        // reviewer must NOT self-fix. For asymmetric, fall back to the PR1
        // behavior: record the verdict, advance linearly to `author_response`,
        // and DO NOT keep the claim / emit a next_turn — the author-fix dispatch
        // is a planned follow-up, so a human drives it. (No re-dispatch means no
        // worktree reuse, so the claim is released by harvest as usual.)
        const symmetric = loop.protocol?.review_mode === 'symmetric';
        complete_turn(
          {
            id: loopId, slot_id: slot.slot_id, actor,
            artifact: { phase: loop.current_phase, type: 'verdict', body: capVerdictBody('changes-requested', detail) },
          },
          cwd,
        );
        if (!symmetric) {
          const advancedAsym = advance({ id: loopId, actor }, cwd);
          return {
            loop_id: loopId,
            verdict,
            action: advancedAsym.auto_closed ? 'closed' : 'advanced',
            reason: advancedAsym.auto_closed
              ? `request_changes → loop ${advancedAsym.loop.status}`
              : `request_changes (asymmetric) → advanced to "${advancedAsym.loop.current_phase}"; author-fix dispatch is a follow-up (drive manually)`,
            loop_status: advancedAsym.loop.status,
          };
        }
        // Symmetric: bump the round counter by advancing to the SAME phase
        // (advance treats to_phase <= current as a backward iteration →
        // iteration_count += 1). The post-advance stop_condition (max_iterations
        // n=3) auto-closes the loop as `blocked` once the cap is hit; otherwise
        // the loop stays open and we hand harvest a `next_turn` to re-dispatch
        // into the SAME (kept) worktree so fixes accumulate on one branch.
        const advanced = advance({ id: loopId, to_phase: loop.current_phase, actor }, cwd);
        if (advanced.auto_closed) {
          return {
            loop_id: loopId,
            verdict,
            action: 'closed',
            reason: `request_changes hit iteration cap → loop ${advanced.loop.status} (needs human)`,
            loop_status: advanced.loop.status,
          };
        }
        return {
          loop_id: loopId,
          verdict,
          action: 'advanced',
          reason: `request_changes (round ${advanced.loop.iteration_count}) → re-dispatch same reviewer into kept worktree`,
          loop_status: advanced.loop.status,
          keep_claim: true,
          next_turn: {
            slot_id: slot.slot_id,
            role: slot.role,
            agent: slot.agent ?? '',
            agent_id: slot.agent_id,
            phase: advanced.loop.current_phase,
            iteration: advanced.loop.iteration_count,
            task: buildFixCycleTask(detail, advanced.loop.iteration_count),
          },
        };
      },
    });
  } catch (err) {
    return noop(`loop close error (harvest not blocked): ${err instanceof Error ? err.message : String(err)}`);
  }
}
