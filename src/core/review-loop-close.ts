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
 * This module closes that gap for the LGTM path (PR1): given a harvested review
 * lane carrying a `review_verdict`, it records a loop `verdict` artifact on the
 * reviewer slot and advances the loop — which auto-closes on `reviewer_green`
 * (verbs.ts:evaluateStopCondition). `request_changes` records the verdict and
 * advances to `author_response` but does NOT auto-close (the re-review cycle is
 * PR2). The reverse direction (loop terminal → assignment converge) is the
 * existing Layer B backstop in assignment-reconciler.ts; this is Layer A's
 * missing complement for review loops.
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
import type { LoopArtifact, LoopSlot, LoopThread } from './loops/types.js';

/** review-loop:lop_xxx → the loop id (mirrors assignment-reconciler.ts). */
const REVIEW_LOOP_SCOPE_RE = /^review-loop:(lop_[0-9a-z]+)/;
const LOOP_TERMINAL = new Set(['completed', 'cancelled', 'blocked']);

export interface ReviewLoopCloseResult {
  loop_id: string;
  verdict: 'approve' | 'request_changes';
  /** What the callback did: closed the loop, advanced a phase, or no-op'd. */
  action: 'closed' | 'advanced' | 'noop';
  reason: string;
  /** Loop status after the call (for observability / tests). */
  loop_status?: string;
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
export function closeReviewLoopFromLaneResult(
  assignment: Pick<Assignment, 'id' | 'scope' | 'agent'>,
  lane: Pick<LaneResult, 'review_verdict' | 'review_summary'>,
  actor: string,
  cwd?: string,
): ReviewLoopCloseResult | undefined {
  const scopeMatch = assignment.scope?.match(REVIEW_LOOP_SCOPE_RE);
  if (!scopeMatch) return undefined;
  if (!lane.review_verdict) return undefined;

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

        if (slot) {
          // Active reviewer slot → record the verdict on it. isVerdictAccepted
          // fires reviewer_green ONLY on an "accepted…" body, so approve MUST
          // start with "accepted" and request_changes must NOT.
          const summary = (lane.review_summary ?? '').trim();
          const body =
            verdict === 'approve'
              ? `accepted${summary ? `: ${summary}` : ''}`
              : `changes-requested${summary ? `: ${summary}` : ''}`;
          complete_turn(
            { id: loopId, slot_id: slot.slot_id, actor, artifact: { phase: loop.current_phase, type: 'verdict', body } },
            cwd,
          );
        } else if (!(verdict === 'approve' && acceptedVerdictExists)) {
          // No reviewer slot is ours to complete. Resume ONLY the approve→close
          // case: a prior pass recorded an accepted verdict but died before
          // advancing. For request_changes (or no accepted verdict), the single
          // advance already happened on the first pass — do not re-advance.
          return noop('already processed (no active reviewer slot to (re)advance)', loop.status);
        }

        // Advance: closes on reviewer_green (approve), else moves one phase.
        // Convergent — safe whether we just recorded the verdict or are resuming
        // an interrupted approve.
        const advanced = advance({ id: loopId, actor }, cwd);
        return {
          loop_id: loopId,
          verdict,
          action: advanced.auto_closed ? 'closed' : 'advanced',
          reason: advanced.auto_closed
            ? `reviewer_green → loop ${advanced.loop.status}`
            : `verdict recorded → advanced to phase "${advanced.loop.current_phase}" (awaiting fix cycle — PR2)`,
          loop_status: advanced.loop.status,
        };
      },
    });
  } catch (err) {
    return noop(`loop close error (harvest not blocked): ${err instanceof Error ? err.message : String(err)}`);
  }
}
