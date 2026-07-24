import type { LaneResult } from '../schema.js';
import type { TurnReservation } from './attempt-reservation.js';

/**
 * Per-loop-kind result reducers (pln#630 §6).
 *
 * An expected file produced by a worker is NOT a loop artifact. Each loop kind
 * registers a reducer that maps the validated turn result → the loop artifacts
 * that drive convergence, plus the slot outcome. This is the ONE write path for
 * turn-produced artifacts (reconcileTurn calls it; nothing else fabricates them),
 * closing the double-artifact hole where complete_turn wrote its own.
 */

/** An artifact the reducer wants recorded on the loop (shape consumed by complete_turn). */
export interface NewLoopArtifact {
  phase: string;
  type: string;
  body?: string;
  produced_by?: string;
  /** ideation synthesis provenance — critique ids a plan_draft addresses (unused by review). */
  addresses_critique?: string[];
}

export interface ReducerResult {
  artifacts: NewLoopArtifact[];
  slot_outcome: 'done' | 'failed';
  failure_reason?: string;
}

/**
 * Reducer input: the parsed LANE-RESULT for the turn + the phase to stamp +
 * (for ideation) the critique bodies reconcileTurn resolved from the attempt's
 * `critique_batch` expected artifact. reconcileTurn owns evidence/identity
 * validation BEFORE calling a reducer — reducers are pure and assume the lane is
 * already proven to belong to this attempt.
 */
export interface ReducerInput {
  lane: LaneResult;
  phase: string;
  critiques?: Array<{ body: string; addresses_critique?: string[] }>;
}

export type ResultReducer = (input: ReducerInput, attempt: TurnReservation) => ReducerResult;

/**
 * review reducer (§6). `approve` → one `verdict` artifact whose body begins
 * `accepted…` — EXACTLY what `isVerdictAccepted`/`reviewer_green` matches
 * (verbs.ts) so the loop auto-closes; `request_changes` → a `changes-requested`
 * verdict that does NOT fire reviewer_green (the symmetric fix cycle continues).
 * A lane that did not complete, or completed with no verdict, fails the slot
 * (no fake green).
 */
export const reviewReducer: ResultReducer = (input, attempt) => {
  const { lane, phase } = input;
  if (lane.status !== 'completed') {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: `review lane status is ${lane.status}, not completed` };
  }
  if (!lane.review_verdict) {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: 'review lane completed without a review_verdict — cannot converge the loop' };
  }
  const summary = (lane.review_summary ?? '').trim();
  const body = lane.review_verdict === 'approve'
    ? `accepted${summary ? `: ${summary}` : ''}`
    : `changes-requested${summary ? `: ${summary}` : ''}`;
  return {
    artifacts: [{ phase, type: 'verdict', body, produced_by: attempt.agent }],
    slot_outcome: 'done',
  };
};

/**
 * ideation reducer (§6). A `critique_batch` → N `critique` artifacts (so
 * `min_artifacts_by_type` can open the next phase). A bare summary with no
 * critique body → slot `failed`, gate stays shut (correct: no fake progress from
 * a lane that produced no critiques).
 */
export const ideationReducer: ResultReducer = (input, attempt) => {
  const { lane, phase, critiques } = input;
  if (lane.status !== 'completed') {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: `ideation lane status is ${lane.status}, not completed` };
  }
  if (!critiques || critiques.length === 0) {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: 'ideation lane produced no critiques (bare summary) — gate stays shut' };
  }
  return {
    artifacts: critiques.map((c) => ({
      phase, type: 'critique', body: c.body, produced_by: attempt.agent,
      ...(c.addresses_critique ? { addresses_critique: c.addresses_critique } : {}),
    })),
    slot_outcome: 'done',
  };
};

/**
 * Default reducer for loop kinds without a specialized one (implementation /
 * research / debug / bootstrap): a completed lane → one generic `lane_result`
 * artifact carrying the summary; a non-completed lane → slot failed. Keeps
 * convergence sensible without fabricating structured artifacts a kind never
 * declared.
 */
export const defaultReducer: ResultReducer = (input, attempt) => {
  const { lane, phase } = input;
  if (lane.status !== 'completed') {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: `lane status is ${lane.status}, not completed` };
  }
  return {
    artifacts: [{ phase, type: 'lane_result', body: lane.summary, produced_by: attempt.agent }],
    slot_outcome: 'done',
  };
};

const RESULT_REDUCERS: Record<string, ResultReducer> = {
  review: reviewReducer,
  ideation: ideationReducer,
};

/** The reducer for a loop kind — a specialized one when registered, else the default. */
export function reducerForKind(kind: string): ResultReducer {
  return RESULT_REDUCERS[kind] ?? defaultReducer;
}
