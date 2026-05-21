import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNextPhase,
  artifactsInIteration,
  noNewCritiqueInIteration,
  hasCriticSignalInIteration,
  type IterationProtocol,
  type LoopArtifact,
  type LoopThread,
} from '../../src/core/loops/index.js';

/**
 * pln#492 phase 2.b — Pure FSM tests for the iteration engine. No store
 * involved. Each test constructs a synthetic LoopThread + protocol and
 * asserts the decision. Phase 2.b advance() integration is covered in
 * loops-verbs.test.ts (existing) plus a phase-2.b-specific case below.
 */

function makeThread(over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_test123',
    version: 1,
    mutation_id: 'mut_1',
    kind: 'ideation',
    title: 'engine test',
    status: 'open',
    phases: [
      { name: 'proposal' },
      { name: 'critique' },
      { name: 'revision' },
      { name: 'synthesis' },
    ],
    current_phase: 'proposal',
    iteration_count: 0,
    open_questions: [],
    slots: [],
    artifacts: [],
    created_at: '2026-05-06T12:00:00.000Z',
    updated_at: '2026-05-06T12:00:00.000Z',
    created_by: 'agt_test',
    ...over,
  };
}

const ideationProtocol: IterationProtocol = {
  phases: [
    { name: 'proposal' },
    { name: 'critique' },
    { name: 'revision' },
    { name: 'synthesis' },
  ],
  iteration: {
    cycle: ['critique', 'revision'],
    max_iterations: 3,
    exit_when: 'no_new_critique_artifacts',
  },
};

function critique(over: Partial<LoopArtifact> = {}): LoopArtifact {
  return {
    artifact_id: `art_${Math.random().toString(36).slice(2, 8)}`,
    phase: 'critique',
    type: 'critique',
    produced_at: '2026-05-06T12:00:00.000Z',
    iteration: 0,
    ...over,
  };
}

describe('decideNextPhase — outside the cycle (pln#492 phase 2.b)', () => {
  it('proposal → critique (linear advance, iteration unchanged)', () => {
    const thread = makeThread({ current_phase: 'proposal', iteration_count: 0 });
    const decision = decideNextPhase(thread, ideationProtocol);
    assert.deepEqual(decision, {
      kind: 'advance_to',
      target: 'critique',
      iteration: 0,
    });
  });

  it('synthesis → throw (last phase, no successor)', () => {
    const thread = makeThread({ current_phase: 'synthesis' });
    assert.throws(
      () => decideNextPhase(thread, ideationProtocol),
      /already at last phase "synthesis"/,
    );
  });

  it('current_phase not in protocol → throw', () => {
    const thread = makeThread({ current_phase: 'nope' });
    assert.throws(
      () => decideNextPhase(thread, ideationProtocol),
      /current_phase "nope" not in protocol.phases/,
    );
  });

  it('protocol with no iteration block: linear advance only', () => {
    const linear: IterationProtocol = {
      phases: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    };
    const thread = makeThread({
      current_phase: 'a',
      phases: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
    const decision = decideNextPhase(thread, linear);
    assert.deepEqual(decision, { kind: 'advance_to', target: 'b', iteration: 0 });
  });
});

describe('decideNextPhase — within the cycle, not at end', () => {
  it('critique → revision (mid-cycle linear step, iteration unchanged)', () => {
    const thread = makeThread({ current_phase: 'critique', iteration_count: 0 });
    const decision = decideNextPhase(thread, ideationProtocol);
    assert.deepEqual(decision, {
      kind: 'advance_to',
      target: 'revision',
      iteration: 0,
    });
  });
});

describe('decideNextPhase — at cycle end, exit_when satisfied', () => {
  it('revision (end of cycle) + zero new critiques in iteration → exit_cycle', () => {
    const thread = makeThread({
      current_phase: 'revision',
      iteration_count: 1,
      // no critiques in iteration 1; some in iteration 0 (irrelevant)
      artifacts: [critique({ iteration: 0 }), critique({ iteration: 0 })],
    });
    const decision = decideNextPhase(thread, ideationProtocol);
    assert.deepEqual(decision, {
      kind: 'exit_cycle',
      target: 'synthesis',
      iteration: 1,
      reason: 'no_new_critique_artifacts',
    });
  });

  it('revision (end of cycle) + new critiques in iteration → does NOT exit via no_new_critique', () => {
    const thread = makeThread({
      current_phase: 'revision',
      iteration_count: 1,
      artifacts: [critique({ iteration: 1 })], // 1 new critique in current iteration
    });
    const decision = decideNextPhase(thread, ideationProtocol);
    // Should iterate, not exit (max=3, current=1, next=2, < 3)
    assert.equal(decision.kind, 'iterate_to');
    if (decision.kind === 'iterate_to') {
      assert.equal(decision.target, 'critique');
      assert.equal(decision.iteration, 2);
    }
  });

  it('exit_when=critic_signal: cycle ends, signal present in iteration → exit_cycle', () => {
    const proto: IterationProtocol = {
      ...ideationProtocol,
      iteration: { ...ideationProtocol.iteration!, exit_when: 'critic_signal' },
    };
    const thread = makeThread({
      current_phase: 'revision',
      iteration_count: 0,
      artifacts: [
        critique({ iteration: 0 }),
        {
          artifact_id: 'art_signal',
          phase: 'critique',
          type: 'critic_signal',
          produced_at: '2026-05-06T12:00:00.000Z',
          iteration: 0,
        },
      ],
    });
    const decision = decideNextPhase(thread, proto);
    assert.equal(decision.kind, 'exit_cycle');
    if (decision.kind === 'exit_cycle') {
      assert.equal(decision.reason, 'critic_signal');
      assert.equal(decision.target, 'synthesis');
    }
  });
});

describe('decideNextPhase — at cycle end, max_iterations reached', () => {
  it('iteration_count + 1 >= max → max_iterations decision', () => {
    const thread = makeThread({
      current_phase: 'revision',
      iteration_count: 2, // 2 + 1 = 3 = max → cap
      artifacts: [
        critique({ iteration: 2 }),
        critique({ iteration: 2 }),
        critique({ iteration: 2 }),
      ],
    });
    const decision = decideNextPhase(thread, ideationProtocol);
    assert.equal(decision.kind, 'max_iterations');
    if (decision.kind === 'max_iterations') {
      assert.equal(decision.target, 'synthesis');
      assert.equal(decision.iteration, 3);
      assert.equal(decision.max, 3);
    }
  });

  it('max_iterations takes precedence over iterate (we do not loop back at the cap)', () => {
    // Critiques present in current iteration (would normally trigger iterate_to)
    // but cap is hit so we exit instead.
    const thread = makeThread({
      current_phase: 'revision',
      iteration_count: 2,
      artifacts: [critique({ iteration: 2 })],
    });
    const decision = decideNextPhase(thread, ideationProtocol);
    assert.equal(decision.kind, 'max_iterations');
  });
});

describe('decideNextPhase — at cycle end, normal iteration', () => {
  it('iteration_count < max-1 + new critiques → iterate_to first cycle phase, ++iteration', () => {
    const thread = makeThread({
      current_phase: 'revision',
      iteration_count: 0,
      artifacts: [critique({ iteration: 0 }), critique({ iteration: 0 })],
    });
    const decision = decideNextPhase(thread, ideationProtocol);
    assert.deepEqual(decision, {
      kind: 'iterate_to',
      target: 'critique',
      iteration: 1,
    });
  });
});

describe('iteration helpers (pln#492 phase 2.b)', () => {
  it('artifactsInIteration filters by iteration, treating missing as 0', () => {
    const thread = makeThread({
      artifacts: [
        critique({ iteration: 0 }),
        critique({ iteration: 1 }),
        critique({ iteration: 1 }),
        critique({}), // no iteration → treated as 0
      ],
    });
    assert.equal(artifactsInIteration(thread, 0).length, 2);
    assert.equal(artifactsInIteration(thread, 1).length, 2);
    assert.equal(artifactsInIteration(thread, 2).length, 0);
  });

  it('noNewCritiqueInIteration: true when no critique artifacts in window', () => {
    const thread = makeThread({
      artifacts: [
        critique({ iteration: 0 }),
        // iteration 1 only has a non-critique artifact
        {
          artifact_id: 'art_x',
          phase: 'revision',
          type: 'revision_note',
          produced_at: '2026-05-06T12:00:00.000Z',
          iteration: 1,
        },
      ],
    });
    assert.equal(noNewCritiqueInIteration(thread, 0), false);
    assert.equal(noNewCritiqueInIteration(thread, 1), true);
  });

  it('hasCriticSignalInIteration: true only when critic_signal artifact in window', () => {
    const thread = makeThread({
      artifacts: [
        critique({ iteration: 0 }),
        {
          artifact_id: 'art_s',
          phase: 'critique',
          type: 'critic_signal',
          produced_at: '2026-05-06T12:00:00.000Z',
          iteration: 1,
        },
      ],
    });
    assert.equal(hasCriticSignalInIteration(thread, 0), false);
    assert.equal(hasCriticSignalInIteration(thread, 1), true);
  });
});
