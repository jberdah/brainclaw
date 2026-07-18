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
 * missing complement for review loops whose slots never carried an assignment_id.
 *
 * Kept in its own core module (like assignment-reconciler.ts) to avoid an import
 * cycle: loops/store → assignments; this → loops + schema; harvest.ts → this.
 */
import type { Assignment, LaneResult } from './schema.js';
import { getLoop } from './loops/store.js';
import { complete_turn, advance } from './loops/verbs.js';
import type { LoopSlot, LoopThread } from './loops/types.js';

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

/**
 * Resolve the reviewer slot to complete. Prefers a not-yet-done reviewer slot;
 * disambiguates by agent when a loop has several. Returns undefined when no
 * active reviewer slot remains — the natural idempotency signal (a prior harvest
 * pass already completed the turn).
 */
function resolveReviewerSlot(loop: LoopThread, agent?: string): LoopSlot | undefined {
  const active = loop.slots.filter(
    (s) => s.role === 'reviewer' && s.status !== 'done' && s.status !== 'cancelled' && s.status !== 'failed',
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const byAgent = agent ? active.find((s) => s.agent === agent) : undefined;
  return byAgent ?? active[0];
}

/**
 * Map a harvested review lane onto its loop and close/advance it.
 *
 * Fires ONLY when the assignment scope is a review-loop (`review-loop:lop_…`)
 * AND the lane carries a `review_verdict` — otherwise returns undefined and the
 * caller (harvest) proceeds unchanged. Idempotent and defensive: a terminal
 * loop or an already-completed reviewer slot is a no-op, and any loop-verb error
 * is swallowed into a `noop` result so a loop-close failure never breaks harvest
 * (mirrors convergeSlotAssignmentsForClosedLoop's swallow-and-continue).
 */
export function closeReviewLoopFromLaneResult(
  assignment: Pick<Assignment, 'scope' | 'agent'>,
  lane: Pick<LaneResult, 'review_verdict' | 'review_summary'>,
  actor: string,
  cwd?: string,
): ReviewLoopCloseResult | undefined {
  const scopeMatch = assignment.scope?.match(REVIEW_LOOP_SCOPE_RE);
  if (!scopeMatch) return undefined;
  if (!lane.review_verdict) return undefined;

  const loopId = scopeMatch[1]!;
  const verdict = lane.review_verdict;

  try {
    const loop = getLoop(loopId, cwd);
    if (!loop) {
      return { loop_id: loopId, verdict, action: 'noop', reason: 'loop not found' };
    }
    if (LOOP_TERMINAL.has(loop.status)) {
      return { loop_id: loopId, verdict, action: 'noop', reason: `loop already ${loop.status}`, loop_status: loop.status };
    }

    const slot = resolveReviewerSlot(loop, assignment.agent);
    if (!slot) {
      return {
        loop_id: loopId,
        verdict,
        action: 'noop',
        reason: 'no active reviewer slot (turn already completed on a prior pass)',
        loop_status: loop.status,
      };
    }

    // isVerdictAccepted (verbs.ts) fires reviewer_green ONLY when the verdict
    // body starts with "accepted" — so approve MUST produce an "accepted…" body
    // and request_changes must NOT.
    const summary = (lane.review_summary ?? '').trim();
    const body =
      verdict === 'approve'
        ? `accepted${summary ? `: ${summary}` : ''}`
        : `changes-requested${summary ? `: ${summary}` : ''}`;

    complete_turn(
      {
        id: loopId,
        slot_id: slot.slot_id,
        actor,
        artifact: { phase: loop.current_phase, type: 'verdict', body },
      },
      cwd,
    );

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
  } catch (err) {
    return {
      loop_id: loopId,
      verdict,
      action: 'noop',
      reason: `loop close error (harvest not blocked): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
