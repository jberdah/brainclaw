import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AtomicStopConditionSchema,
  BOOTSTRAP_PRESET,
  evaluateStopCondition,
  type LoopThread,
} from '../../src/core/loops/index.js';

/**
 * pln#511 step 1 — bootstrap preset module + `no_open_questions` StopCondition.
 *
 * Locks in (a) the preset's phase chain / gates / protocol — the coordinate
 * facade in step 2 wires off these exact fields — and (b) the new atomic
 * stop-condition primitive used by the `clarify` phase's `any` gate.
 */

function makeThread(overrides: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_test000000',
    version: 0,
    mutation_id: 'mut_test',
    kind: 'ideation',
    title: 'preset test thread',
    status: 'open',
    phases: [{ name: 'clarify' }],
    current_phase: 'clarify',
    iteration_count: 0,
    slots: [],
    artifacts: [],
    open_questions: [],
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    created_by: 'agt_test',
    ...overrides,
  };
}

describe('BOOTSTRAP_PRESET — phase chain (pln#511 step 1)', () => {
  it('declares five phases in the Phase 0 spec order', () => {
    assert.equal(BOOTSTRAP_PRESET.phases.length, 5);
    assert.deepEqual(
      BOOTSTRAP_PRESET.phases.map((p) => p.name),
      ['survey', 'propose', 'clarify', 'review_draft', 'converge'],
    );
  });

  it('uses curated context_filter on survey + clarify, wildcard on propose/review_draft/converge', () => {
    const [survey, propose, clarify, reviewDraft, converge] = BOOTSTRAP_PRESET.phases;
    assert.deepEqual(survey.context_filter, ['project_vision', 'decisions', 'plans', 'feedback']);
    assert.deepEqual(propose.context_filter, ['*']);
    assert.deepEqual(clarify.context_filter, ['critique_history', 'runtime_notes', 'feedback']);
    assert.deepEqual(reviewDraft.context_filter, ['*']);
    assert.deepEqual(converge.context_filter, ['*']);
  });

  it('survey advance_gate is artifact_produced(survey, signals_report)', () => {
    const gate = BOOTSTRAP_PRESET.phases[0].advance_gate;
    assert.deepEqual(gate, {
      kind: 'artifact_produced',
      phase: 'survey',
      type: 'signals_report',
    });
  });

  it('propose advance_gate is artifact_produced(propose, project_md_draft)', () => {
    const gate = BOOTSTRAP_PRESET.phases[1].advance_gate;
    assert.deepEqual(gate, {
      kind: 'artifact_produced',
      phase: 'propose',
      type: 'project_md_draft',
    });
  });

  it('clarify advance_gate is any[no_open_questions, max_iterations=1]', () => {
    const gate = BOOTSTRAP_PRESET.phases[2].advance_gate;
    assert.deepEqual(gate, {
      kind: 'any',
      conditions: [
        { kind: 'no_open_questions' },
        { kind: 'max_iterations', n: 1 },
      ],
    });
  });

  it('review_draft advance_gate is artifact_produced(review_draft, operator_answer)', () => {
    const gate = BOOTSTRAP_PRESET.phases[3].advance_gate;
    assert.deepEqual(gate, {
      kind: 'artifact_produced',
      phase: 'review_draft',
      type: 'operator_answer',
    });
  });

  it('converge has no advance_gate (terminal phase; loop closes on stop_condition)', () => {
    assert.equal(BOOTSTRAP_PRESET.phases[4].advance_gate, undefined);
  });
});

describe('BOOTSTRAP_PRESET — stop_condition + protocol', () => {
  it('stop_condition is artifact_produced(converge, project_md_final)', () => {
    assert.deepEqual(BOOTSTRAP_PRESET.stop_condition, {
      kind: 'artifact_produced',
      phase: 'converge',
      type: 'project_md_final',
    });
  });

  it('protocol carries the bootstrap preset identifier + safety caps', () => {
    assert.deepEqual(BOOTSTRAP_PRESET.protocol, {
      preset: 'bootstrap',
      max_operator_questions: 3,
      max_pause_duration: 'P7D',
    });
  });
});

describe('AtomicStopConditionSchema — no_open_questions (pln#511 step 1)', () => {
  it('parses the new atomic shape', () => {
    const parsed = AtomicStopConditionSchema.parse({ kind: 'no_open_questions' });
    assert.deepEqual(parsed, { kind: 'no_open_questions' });
  });
});

describe('evaluateStopCondition — no_open_questions', () => {
  it('returns true when the thread has zero open_questions', () => {
    const thread = makeThread({ open_questions: [] });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'no_open_questions' }),
      true,
    );
  });

  it('returns false when at least one question is open', () => {
    const thread = makeThread({ open_questions: ['qst_abc123'] });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'no_open_questions' }),
      false,
    );
  });

  it('returns false when multiple questions are open', () => {
    const thread = makeThread({
      open_questions: ['qst_abc123', 'qst_def456', 'qst_ghi789'],
    });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'no_open_questions' }),
      false,
    );
  });

  it('composes inside the clarify `any` gate: matches when either condition holds', () => {
    const clarifyGate = BOOTSTRAP_PRESET.phases[2].advance_gate!;
    // open_questions empty → no_open_questions branch fires.
    assert.equal(
      evaluateStopCondition(makeThread({ open_questions: [] }), clarifyGate),
      true,
    );
    // Question still open BUT iteration_count >= 1 → max_iterations branch fires.
    assert.equal(
      evaluateStopCondition(
        makeThread({ open_questions: ['qst_abc123'], iteration_count: 1 }),
        clarifyGate,
      ),
      true,
    );
    // Question open AND iteration_count < 1 → neither branch holds.
    assert.equal(
      evaluateStopCondition(
        makeThread({ open_questions: ['qst_abc123'], iteration_count: 0 }),
        clarifyGate,
      ),
      false,
    );
  });
});
