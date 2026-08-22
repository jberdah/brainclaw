import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewReducer, ideationReducer, implementationReducer, researchReducer, debugReducer,
  defaultReducer, reducerForKind,
  type ReducerInput,
} from '../../src/core/loops/result-reducers.js';
import type { LaneResult } from '../../src/core/schema.js';
import type { TurnReservation } from '../../src/core/loops/attempt-reservation.js';

// pln#630 §6 — per-kind reducers map a validated turn result → loop artifacts +
// slot outcome. Pure functions: reconcileTurn validates identity/evidence first.

// The exact predicate verbs.isVerdictAccepted uses for reviewer_green.
const REVIEWER_GREEN_RE = /^accepted(?:\b|[:\s])/;
const attempt = { agent: 'codex' } as TurnReservation;

function lane(over: Partial<LaneResult>): LaneResult {
  return { assignment_id: 'asgn_x', status: 'completed', summary: 's', ...over };
}
const input = (over: Partial<ReducerInput>): ReducerInput => ({ lane: lane({}), phase: 'findings', ...over });

describe('reviewReducer §6', () => {
  it('approve → a `verdict` artifact whose body fires reviewer_green', () => {
    const r = reviewReducer(input({ lane: lane({ review_verdict: 'approve', review_summary: 'LGTM' }) }), attempt);
    assert.equal(r.slot_outcome, 'done');
    assert.equal(r.artifacts.length, 1);
    assert.equal(r.artifacts[0]!.type, 'verdict');
    assert.equal(r.artifacts[0]!.body, 'accepted: LGTM');
    assert.match(r.artifacts[0]!.body!.toLowerCase(), REVIEWER_GREEN_RE, 'body must fire reviewer_green');
    assert.equal(r.artifacts[0]!.produced_by, 'codex');
  });
  it('approve with no summary → bare `accepted`, still fires reviewer_green', () => {
    const r = reviewReducer(input({ lane: lane({ review_verdict: 'approve' }) }), attempt);
    assert.equal(r.artifacts[0]!.body, 'accepted');
    assert.match(r.artifacts[0]!.body!.toLowerCase(), REVIEWER_GREEN_RE);
  });
  it('request_changes → `changes-requested` verdict that does NOT fire reviewer_green (fix cycle continues)', () => {
    const r = reviewReducer(input({ lane: lane({ review_verdict: 'request_changes', review_summary: 'fix X' }) }), attempt);
    assert.equal(r.slot_outcome, 'done');
    assert.equal(r.artifacts[0]!.type, 'verdict');
    assert.equal(r.artifacts[0]!.body, 'changes-requested: fix X');
    assert.doesNotMatch(r.artifacts[0]!.body!.toLowerCase(), REVIEWER_GREEN_RE);
  });
  it('completed lane with NO verdict → slot failed (no fake green)', () => {
    const r = reviewReducer(input({ lane: lane({}) }), attempt);
    assert.equal(r.slot_outcome, 'failed');
    assert.equal(r.artifacts.length, 0);
    assert.match(r.failure_reason!, /without a review_verdict/i);
  });
  it('non-completed lane → slot failed', () => {
    const r = reviewReducer(input({ lane: lane({ status: 'blocked', review_verdict: 'approve' }) }), attempt);
    assert.equal(r.slot_outcome, 'failed');
    assert.match(r.failure_reason!, /blocked/);
  });
  it('author_response requires a typed body instead of a reviewer verdict', () => {
    const r = reviewReducer(input({ phase: 'author_response', lane: lane({ artifact_type: 'author_response', body: 'fixed X; tests green' }) }), attempt);
    assert.equal(r.slot_outcome, 'done');
    assert.equal(r.artifacts[0]?.type, 'author_response');
  });
});

describe('ideationReducer §6', () => {
  it('typed critique evidence → N `critique` artifacts (opens min_artifacts_by_type)', () => {
    const r = ideationReducer(input({ phase: 'critique', lane: lane({ artifact_type: 'critique', body: 'c1' }), critiques: [{ body: 'c1' }, { body: 'c2', addresses_critique: ['x'] }] }), attempt);
    assert.equal(r.slot_outcome, 'done');
    assert.equal(r.artifacts.length, 2);
    assert.ok(r.artifacts.every((a) => a.type === 'critique'));
    assert.deepEqual(r.artifacts[1]!.addresses_critique, ['x']);
  });
  it('bare summary, no critiques → slot failed, gate stays shut', () => {
    const r = ideationReducer(input({ phase: 'critique', lane: lane({ artifact_type: 'critique' }), critiques: [] }), attempt);
    assert.equal(r.slot_outcome, 'failed');
    assert.equal(r.artifacts.length, 0);
    assert.match(r.failure_reason!, /no critiques/i);
  });
});

describe('defaultReducer + reducerForKind', () => {
  it('default: completed → one lane_result artifact', () => {
    const r = defaultReducer(input({ lane: lane({ summary: 'did the thing' }) }), attempt);
    assert.equal(r.slot_outcome, 'done');
    assert.equal(r.artifacts[0]!.type, 'lane_result');
    assert.equal(r.artifacts[0]!.body, 'did the thing');
  });
  it('default: non-completed → failed', () => {
    const r = defaultReducer(input({ lane: lane({ status: 'failed' }) }), attempt);
    assert.equal(r.slot_outcome, 'failed');
  });
  it('reducerForKind is exhaustive and never silently routes a shipped kind to default', () => {
    assert.equal(reducerForKind('review'), reviewReducer);
    assert.equal(reducerForKind('ideation'), ideationReducer);
    assert.equal(reducerForKind('implementation'), implementationReducer);
    assert.equal(reducerForKind('research'), researchReducer);
    assert.equal(reducerForKind('debug'), debugReducer);
  });
});
