import { LOOP_ARTIFACT_BODY_MAX_BYTES, type LoopKind } from './types.js';
import type { LaneResult } from '../schema.js';
import type { TurnReservation } from './attempt-reservation.js';

/**
 * Cap an artifact body to LOOP_ARTIFACT_BODY_MAX_BYTES (review Finding 3).
 * `review_summary`/`summary` are worker-controlled and unbounded, but
 * LoopArtifactSchema hard-rejects a body over the cap — an un-truncated body
 * would make complete_turn throw and crash reconcileTurn. Byte-aware, drops any
 * partial trailing multibyte char.
 */
function capBody(s: string): string {
  if (Buffer.byteLength(s, 'utf8') <= LOOP_ARTIFACT_BODY_MAX_BYTES) return s;
  const marker = '…[truncated]';
  const room = LOOP_ARTIFACT_BODY_MAX_BYTES - Buffer.byteLength(marker, 'utf8');
  return Buffer.from(s, 'utf8').subarray(0, room).toString('utf8').replace(/�+$/, '') + marker;
}

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
  implementation_verify?: { command: string[]; timeout_ms?: number };
}

export interface ReducerResult {
  artifacts: NewLoopArtifact[];
  slot_outcome: 'done' | 'failed';
  failure_reason?: string;
}

/**
 * Reducer input: the parsed LANE-RESULT for the turn + the phase to stamp +
 * (for ideation) the explicitly typed critique bodies reconcileTurn resolved
 * from the attempt result. reconcileTurn owns evidence/identity
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
  if (phase === 'author_response') {
    if (lane.artifact_type !== 'author_response') {
      return { artifacts: [], slot_outcome: 'failed', failure_reason: "review author_response requires artifact_type 'author_response'" };
    }
    const response = (lane.body ?? '').trim();
    if (!response) {
      return { artifacts: [], slot_outcome: 'failed', failure_reason: 'review author_response produced no body' };
    }
    return {
      artifacts: [{ phase, type: 'author_response', body: capBody(response), produced_by: attempt.agent }],
      slot_outcome: 'done',
    };
  }
  if (phase !== 'findings' && phase !== 'followup_review') {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: `review phase '${phase}' has no worker-result contract` };
  }
  if (!lane.review_verdict) {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: 'review lane completed without a review_verdict — cannot converge the loop' };
  }
  const summary = (lane.review_summary ?? '').trim();
  const body = capBody(lane.review_verdict === 'approve'
    ? `accepted${summary ? `: ${summary}` : ''}`
    : `changes-requested${summary ? `: ${summary}` : ''}`);
  return {
    artifacts: [{ phase, type: 'verdict', body, produced_by: attempt.agent }],
    slot_outcome: 'done',
  };
};

/**
 * ideation reducer (§6). An explicitly typed critique → `critique` artifacts (so
 * `min_artifacts_by_type` can open the next phase). A bare summary with no
 * critique body → slot `failed`, gate stays shut (correct: no fake progress from
 * a lane that produced no critiques).
 */
export const ideationReducer: ResultReducer = (input, attempt) => {
  const { lane, phase, critiques } = input;
  if (lane.status !== 'completed') {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: `ideation lane status is ${lane.status}, not completed` };
  }
  if (phase !== 'critique') {
    const artifactType = phase === 'proposal' ? 'proposal' : phase === 'revision' ? 'revision' : phase === 'synthesis' ? 'plan_draft' : undefined;
    if (!artifactType) {
      return { artifacts: [], slot_outcome: 'failed', failure_reason: `ideation phase '${phase}' has no result contract` };
    }
    if (lane.artifact_type !== artifactType) {
      return { artifacts: [], slot_outcome: 'failed', failure_reason: `ideation phase '${phase}' expected artifact_type '${artifactType}', got '${lane.artifact_type}'` };
    }
    const body = (lane.body ?? lane.summary).trim();
    if (!body) return { artifacts: [], slot_outcome: 'failed', failure_reason: `ideation ${phase} produced no body` };
    if (artifactType === 'plan_draft') {
      const addresses = [
        ...(lane.artifacts ?? []).filter((id) => /^art_[0-9a-z]+$/.test(id)),
        ...(critiques ?? []).flatMap((c) => c.addresses_critique ?? []),
      ];
      const uniqueAddresses = [...new Set(addresses)];
      if (uniqueAddresses.length === 0) {
        return { artifacts: [], slot_outcome: 'failed', failure_reason: 'ideation synthesis must cite critique artifact ids in lane.artifacts' };
      }
      if (!lane.implementation_verify) {
        return {
          artifacts: [],
          slot_outcome: 'failed',
          failure_reason: 'ideation synthesis must declare implementation_verify for deterministic downstream verification',
        };
      }
      return {
        artifacts: [{
          phase,
          type: artifactType,
          body: capBody(body),
          produced_by: attempt.agent,
          addresses_critique: uniqueAddresses,
          implementation_verify: lane.implementation_verify,
        }],
        slot_outcome: 'done',
      };
    }
    return { artifacts: [{ phase, type: artifactType, body: capBody(body), produced_by: attempt.agent }], slot_outcome: 'done' };
  }
  if (lane.artifact_type !== 'critique') {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: "ideation critique requires artifact_type 'critique'" };
  }
  if (!critiques || critiques.length === 0) {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: 'ideation critique lane produced no critiques (bare summary) — gate stays shut' };
  }
  return {
    artifacts: critiques.map((c) => ({
      phase, type: 'critique', body: capBody(c.body), produced_by: attempt.agent,
      ...(c.addresses_critique ? { addresses_critique: c.addresses_critique } : {}),
    })),
    slot_outcome: 'done',
  };
};

/**
 * Explicit legacy helper retained for callers/tests that intentionally want a
 * generic lane_result. The exhaustive LoopKind registry below never falls back
 * to it: every shipped kind has a phase-aware reducer.
 */
export const defaultReducer: ResultReducer = (input, attempt) => {
  const { lane, phase } = input;
  if (lane.status !== 'completed') {
    return { artifacts: [], slot_outcome: 'failed', failure_reason: `lane status is ${lane.status}, not completed` };
  }
  return {
    artifacts: [{ phase, type: 'lane_result', body: capBody(lane.summary), produced_by: attempt.agent }],
    slot_outcome: 'done',
  };
};

function typedPhaseReducer(
  kind: Exclude<LoopKind, 'review' | 'ideation'>,
  artifactByPhase: Readonly<Record<string, string>>,
): ResultReducer {
  return (input, attempt) => {
    const { lane, phase } = input;
    if (lane.status !== 'completed') {
      return { artifacts: [], slot_outcome: 'failed', failure_reason: `${kind} lane status is ${lane.status}, not completed` };
    }
    const expectedType = artifactByPhase[phase];
    if (!expectedType) {
      return { artifacts: [], slot_outcome: 'failed', failure_reason: `${kind} phase '${phase}' has no worker-result contract` };
    }
    if (lane.artifact_type !== expectedType) {
      return {
        artifacts: [],
        slot_outcome: 'failed',
        failure_reason: `${kind} phase '${phase}' expected artifact_type '${expectedType}', got '${lane.artifact_type}'`,
      };
    }
    // Every worker artifact is explicitly attested. In particular a narrative
    // summary can never masquerade as a gate-driving repro or verify report.
    const body = (lane.body ?? lane.summary).trim();
    if (!body) {
      return { artifacts: [], slot_outcome: 'failed', failure_reason: `${kind} phase '${phase}' produced no artifact body` };
    }
    return {
      artifacts: [{ phase, type: expectedType, body: capBody(body), produced_by: attempt.agent }],
      slot_outcome: 'done',
    };
  };
}

export const implementationReducer = typedPhaseReducer('implementation', {
  execute: 'execute_report',
});

export const researchReducer = typedPhaseReducer('research', {
  investigate: 'finding',
  synthesize: 'synthesis',
});

export const debugReducer = typedPhaseReducer('debug', {
  reproduce: 'repro',
  hypothesize: 'hypothesis',
  isolate: 'isolation_report',
  fix: 'verify_report',
});

export const RESULT_REDUCERS: Record<LoopKind, ResultReducer> = {
  review: reviewReducer,
  ideation: ideationReducer,
  implementation: implementationReducer,
  research: researchReducer,
  debug: debugReducer,
};

/** The reducer for a loop kind. Exhaustive by construction: no silent fallback. */
export function reducerForKind(kind: LoopKind): ResultReducer {
  return RESULT_REDUCERS[kind];
}
