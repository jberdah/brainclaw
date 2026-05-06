import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePhaseAdvanceGate,
  type LoopThread,
  type StopCondition,
} from '../../src/core/loops/index.js';

/**
 * pln#492 phase 2.a — phase-advance gate evaluator.
 *
 * The gate is what the iteration engine consults before transitioning out
 * of a phase. Phase 1 semantics: counts artifacts across the phase
 * (no iteration window). Phase 2.b will refine `min_artifacts_by_type`
 * with `scope: 'phase'` to count only the current iteration.
 *
 * These tests exercise the evaluator on synthetic threads — no store is
 * involved, since the function is pure.
 */

function makeThread(over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_test123',
    version: 1,
    mutation_id: 'mut_1',
    kind: 'ideation',
    title: 'gate test',
    status: 'open',
    phases: [{ name: 'critique' }, { name: 'revision' }],
    current_phase: 'critique',
    iteration_count: 0,
    slots: [],
    artifacts: [],
    created_at: '2026-05-06T12:00:00.000Z',
    updated_at: '2026-05-06T12:00:00.000Z',
    created_by: 'agt_test',
    ...over,
  };
}

function critiqueArtifact(id: string, phase = 'critique'): LoopThread['artifacts'][number] {
  return {
    artifact_id: id,
    phase,
    type: 'critique',
    produced_at: '2026-05-06T12:00:00.000Z',
  };
}

describe('evaluatePhaseAdvanceGate (pln#492 phase 2.a)', () => {
  it('no gate → advance:true', () => {
    const outcome = evaluatePhaseAdvanceGate(makeThread(), undefined);
    assert.deepEqual(outcome, { advance: true });
  });

  it('min_artifacts_by_type{scope:phase} unmet → advance:false with structured reason', () => {
    const thread = makeThread({
      artifacts: [critiqueArtifact('a1'), critiqueArtifact('a2')],
    });
    const gate: StopCondition = {
      kind: 'min_artifacts_by_type',
      type: 'critique',
      n: 3,
      scope: 'phase',
    };
    const outcome = evaluatePhaseAdvanceGate(thread, gate);
    assert.equal(outcome.advance, false);
    assert.match(outcome.gate_reason ?? '', /min_artifacts_by_type unmet/);
    assert.match(outcome.gate_reason ?? '', /count of type "critique" = 2 < n=3/);
  });

  it('min_artifacts_by_type{scope:phase} met → advance:true', () => {
    const thread = makeThread({
      artifacts: [
        critiqueArtifact('a1'),
        critiqueArtifact('a2'),
        critiqueArtifact('a3'),
      ],
    });
    const gate: StopCondition = {
      kind: 'min_artifacts_by_type',
      type: 'critique',
      n: 3,
      scope: 'phase',
    };
    const outcome = evaluatePhaseAdvanceGate(thread, gate);
    assert.equal(outcome.advance, true);
    assert.equal(outcome.gate_reason, undefined);
  });

  it('min_artifacts_by_type{scope:phase} ignores artifacts in other phases', () => {
    // 5 critique artifacts in 'revision' phase don't count for a phase-scoped
    // gate when current_phase is 'critique'.
    const thread = makeThread({
      current_phase: 'critique',
      artifacts: [
        critiqueArtifact('a1', 'revision'),
        critiqueArtifact('a2', 'revision'),
        critiqueArtifact('a3', 'revision'),
        critiqueArtifact('a4', 'revision'),
        critiqueArtifact('a5', 'revision'),
      ],
    });
    const gate: StopCondition = {
      kind: 'min_artifacts_by_type',
      type: 'critique',
      n: 3,
      scope: 'phase',
    };
    const outcome = evaluatePhaseAdvanceGate(thread, gate);
    assert.equal(outcome.advance, false);
    assert.match(outcome.gate_reason ?? '', /count of type "critique" = 0 < n=3/);
  });

  it('min_artifacts_by_type{scope:loop} counts across all phases', () => {
    const thread = makeThread({
      current_phase: 'critique',
      artifacts: [
        critiqueArtifact('a1', 'revision'),
        critiqueArtifact('a2', 'revision'),
        critiqueArtifact('a3', 'critique'),
      ],
    });
    const gate: StopCondition = {
      kind: 'min_artifacts_by_type',
      type: 'critique',
      n: 3,
      scope: 'loop',
    };
    const outcome = evaluatePhaseAdvanceGate(thread, gate);
    assert.equal(outcome.advance, true);
  });

  it('reviewer_green unmet → structured reason', () => {
    const outcome = evaluatePhaseAdvanceGate(makeThread(), { kind: 'reviewer_green' });
    assert.equal(outcome.advance, false);
    assert.match(outcome.gate_reason ?? '', /no accepted verdict/);
  });

  it('any-of advance_gate: at least one sub-condition met → advance:true', () => {
    const thread = makeThread({
      artifacts: [
        critiqueArtifact('a1'),
        critiqueArtifact('a2'),
        critiqueArtifact('a3'),
      ],
    });
    const gate: StopCondition = {
      kind: 'any',
      conditions: [
        { kind: 'reviewer_green' },
        { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' },
      ],
    };
    const outcome = evaluatePhaseAdvanceGate(thread, gate);
    assert.equal(outcome.advance, true);
  });

  it('any-of advance_gate: no sub-condition met → advance:false', () => {
    const gate: StopCondition = {
      kind: 'any',
      conditions: [
        { kind: 'reviewer_green' },
        { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' },
      ],
    };
    const outcome = evaluatePhaseAdvanceGate(makeThread(), gate);
    assert.equal(outcome.advance, false);
    assert.match(outcome.gate_reason ?? '', /any-of unmet: none of 2/);
  });

  it('all-of advance_gate: every sub-condition met → advance:true', () => {
    const thread = makeThread({
      artifacts: [
        critiqueArtifact('a1'),
        critiqueArtifact('a2'),
        critiqueArtifact('a3'),
        // accepted verdict artifact
        {
          artifact_id: 'art_v',
          phase: 'critique',
          type: 'verdict',
          body: 'accepted: looks good',
          produced_at: '2026-05-06T12:00:00.000Z',
        },
      ],
    });
    const gate: StopCondition = {
      kind: 'all',
      conditions: [
        { kind: 'reviewer_green' },
        { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' },
      ],
    };
    const outcome = evaluatePhaseAdvanceGate(thread, gate);
    assert.equal(outcome.advance, true);
  });

  it('all-of advance_gate: one sub-condition fails → advance:false', () => {
    const thread = makeThread({
      artifacts: [
        critiqueArtifact('a1'),
        critiqueArtifact('a2'),
        critiqueArtifact('a3'),
      ],
    });
    const gate: StopCondition = {
      kind: 'all',
      conditions: [
        { kind: 'reviewer_green' },
        { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' },
      ],
    };
    const outcome = evaluatePhaseAdvanceGate(thread, gate);
    assert.equal(outcome.advance, false);
    assert.match(outcome.gate_reason ?? '', /all-of unmet/);
  });

  it('manual gate is always blocked (caller must signal advance another way)', () => {
    const outcome = evaluatePhaseAdvanceGate(makeThread(), { kind: 'manual' });
    assert.equal(outcome.advance, false);
    assert.match(outcome.gate_reason ?? '', /manual gate/);
  });
});
