import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOP_KINDS,
  LOOP_CONTEXT_CATEGORIES,
  CRITIQUE_ARTIFACT_SUBTYPES,
  LoopPhaseSchema,
  LoopIterationSchema,
  LoopProtocolConfigSchema,
  AtomicStopConditionSchema,
  StopConditionSchema,
  LoopEventSchema,
  DEFAULT_PROTOCOLS,
} from '../../src/core/loops/types.js';

/**
 * pln#492 phase 1 — schema foundations for ideation_loop. These tests
 * cover the new shapes added in this commit so a future driver/gate-engine
 * change cannot accidentally widen them without a corresponding test
 * update.
 *
 * Behaviour (driver, gate, brief assembly) is intentionally out of scope
 * here — phase 2+ in pln#492.
 */

describe('LoopPhaseSchema.context_filter (pln#492)', () => {
  it('accepts a single concrete category', () => {
    const parsed = LoopPhaseSchema.parse({
      name: 'critique',
      context_filter: ['traps'],
    });
    assert.deepEqual(parsed.context_filter, ['traps']);
  });

  it('accepts the wildcard category', () => {
    const parsed = LoopPhaseSchema.parse({
      name: 'revision',
      context_filter: ['*'],
    });
    assert.deepEqual(parsed.context_filter, ['*']);
  });

  it('accepts a multi-category bundle including loop-internal categories', () => {
    const parsed = LoopPhaseSchema.parse({
      name: 'critique',
      context_filter: ['traps', 'feedback', 'runtime_notes', 'critique_history'],
    });
    assert.equal(parsed.context_filter?.length, 4);
  });

  it('is optional — phases without context_filter parse cleanly', () => {
    const parsed = LoopPhaseSchema.parse({ name: 'change_summary' });
    assert.equal(parsed.context_filter, undefined);
  });

  it('rejects an unknown category (closed enum)', () => {
    assert.throws(() =>
      LoopPhaseSchema.parse({
        name: 'critique',
        // 'positive_context' was considered then dropped; if it reappears
        // the closed enum should reject it until intentionally added.
        context_filter: ['positive_context'],
      }),
    );
  });

  it('rejects an empty context_filter array (would silently mean "no context")', () => {
    assert.throws(() =>
      LoopPhaseSchema.parse({ name: 'critique', context_filter: [] }),
    );
  });
});

describe('LoopIterationSchema (pln#492)', () => {
  it('parses a typical ideation iteration block', () => {
    const parsed = LoopIterationSchema.parse({
      cycle: ['critique', 'revision'],
      max_iterations: 3,
      exit_when: 'no_new_critique_artifacts',
    });
    assert.deepEqual(parsed.cycle, ['critique', 'revision']);
  });

  it('accepts the alternate exit_when (critic_signal)', () => {
    const parsed = LoopIterationSchema.parse({
      cycle: ['critique'],
      max_iterations: 5,
      exit_when: 'critic_signal',
    });
    assert.equal(parsed.exit_when, 'critic_signal');
  });

  it('rejects max_iterations <= 0', () => {
    assert.throws(() =>
      LoopIterationSchema.parse({
        cycle: ['critique', 'revision'],
        max_iterations: 0,
        exit_when: 'no_new_critique_artifacts',
      }),
    );
  });

  it('rejects an empty cycle array', () => {
    assert.throws(() =>
      LoopIterationSchema.parse({
        cycle: [],
        max_iterations: 3,
        exit_when: 'no_new_critique_artifacts',
      }),
    );
  });

  it('rejects an unknown exit_when', () => {
    assert.throws(() =>
      LoopIterationSchema.parse({
        cycle: ['critique'],
        max_iterations: 3,
        exit_when: 'whenever_we_feel_done',
      }),
    );
  });
});

describe('LoopProtocolConfigSchema with iteration (pln#492)', () => {
  it('parses both review_mode and iteration together', () => {
    const parsed = LoopProtocolConfigSchema.parse({
      review_mode: 'symmetric',
      iteration: {
        cycle: ['critique', 'revision'],
        max_iterations: 3,
        exit_when: 'no_new_critique_artifacts',
      },
    });
    assert.equal(parsed.review_mode, 'symmetric');
    assert.equal(parsed.iteration?.max_iterations, 3);
  });

  it('iteration is optional', () => {
    const parsed = LoopProtocolConfigSchema.parse({});
    assert.equal(parsed.iteration, undefined);
  });
});

describe('StopCondition: min_artifacts_by_type (pln#492)', () => {
  it('parses the phase-scoped form', () => {
    const parsed = AtomicStopConditionSchema.parse({
      kind: 'min_artifacts_by_type',
      type: 'memory_conflict',
      n: 3,
      scope: 'phase',
    });
    assert.equal(parsed.kind, 'min_artifacts_by_type');
    if (parsed.kind === 'min_artifacts_by_type') {
      assert.equal(parsed.scope, 'phase');
    }
  });

  it('parses the loop-scoped form', () => {
    const parsed = AtomicStopConditionSchema.parse({
      kind: 'min_artifacts_by_type',
      type: 'plan_draft',
      n: 1,
      scope: 'loop',
    });
    assert.equal(parsed.kind, 'min_artifacts_by_type');
  });

  it('composes inside any/all stop conditions (recursive type)', () => {
    const parsed = StopConditionSchema.parse({
      kind: 'any',
      conditions: [
        { kind: 'min_artifacts_by_type', type: 'memory_conflict', n: 3, scope: 'phase' },
        { kind: 'max_iterations', n: 3 },
      ],
    });
    assert.equal(parsed.kind, 'any');
  });

  it('rejects scope outside the closed enum', () => {
    assert.throws(() =>
      AtomicStopConditionSchema.parse({
        kind: 'min_artifacts_by_type',
        type: 'memory_conflict',
        n: 3,
        scope: 'session',
      }),
    );
  });

  it('rejects n <= 0', () => {
    assert.throws(() =>
      AtomicStopConditionSchema.parse({
        kind: 'min_artifacts_by_type',
        type: 'memory_conflict',
        n: 0,
        scope: 'phase',
      }),
    );
  });
});

describe('LoopEvent: phase_advance_blocked / max_iterations_reached (pln#492)', () => {
  const baseShape = {
    event_id: 'evt_1',
    loop_id: 'lop_abc123',
    seq: 1,
    at: '2026-05-06T12:00:00.000Z',
    mutation_id: 'mut_1',
  };

  it('parses phase_advance_blocked with a gate_reason', () => {
    const parsed = LoopEventSchema.parse({
      ...baseShape,
      kind: 'phase_advance_blocked',
      phase: 'critique',
      gate_reason: 'min_artifacts_by_type unmet: memory_conflict count=1 < n=3',
    });
    assert.equal(parsed.kind, 'phase_advance_blocked');
  });

  it('parses max_iterations_reached', () => {
    const parsed = LoopEventSchema.parse({
      ...baseShape,
      seq: 2,
      kind: 'max_iterations_reached',
      phase: 'critique',
      iteration: 3,
      max_iterations: 3,
    });
    assert.equal(parsed.kind, 'max_iterations_reached');
  });

  it('phase_advance_blocked requires gate_reason (no silent failure)', () => {
    assert.throws(() =>
      LoopEventSchema.parse({
        ...baseShape,
        kind: 'phase_advance_blocked',
        phase: 'critique',
      }),
    );
  });
});

describe('DEFAULT_PROTOCOLS invariants (pln#492 stp_42b30c86)', () => {
  it('keys are 1:1 with LOOP_KINDS', () => {
    const protocolKeys = Object.keys(DEFAULT_PROTOCOLS).sort();
    const expected = [...LOOP_KINDS].sort();
    assert.deepEqual(protocolKeys, expected);
  });

  it('every protocol has at least one phase with a non-empty name', () => {
    for (const kind of LOOP_KINDS) {
      const proto = DEFAULT_PROTOCOLS[kind];
      assert.ok(proto.phases.length > 0, `${kind} has no phases`);
      for (const phase of proto.phases) {
        assert.ok(phase.name && phase.name.length > 0, `${kind} has an empty phase name`);
      }
    }
  });

  it('every phase name is unique within its protocol', () => {
    for (const kind of LOOP_KINDS) {
      const names = DEFAULT_PROTOCOLS[kind].phases.map((p) => p.name);
      const unique = new Set(names);
      assert.equal(unique.size, names.length, `${kind} has duplicate phase names`);
    }
  });

  it('every phase.context_filter (if set) only uses values from LOOP_CONTEXT_CATEGORIES', () => {
    const allowed = new Set<string>(LOOP_CONTEXT_CATEGORIES);
    for (const kind of LOOP_KINDS) {
      for (const phase of DEFAULT_PROTOCOLS[kind].phases) {
        for (const cat of phase.context_filter ?? []) {
          assert.ok(
            allowed.has(cat),
            `${kind}.${phase.name} references unknown context category "${cat}"`,
          );
        }
      }
    }
  });

  it('iteration.cycle (if set) references existing phase names within the same protocol', () => {
    for (const kind of LOOP_KINDS) {
      const proto = DEFAULT_PROTOCOLS[kind];
      if (!proto.iteration) continue;
      const phaseNames = new Set(proto.phases.map((p) => p.name));
      for (const cycleStep of proto.iteration.cycle) {
        assert.ok(
          phaseNames.has(cycleStep),
          `${kind}.iteration.cycle references missing phase "${cycleStep}"`,
        );
      }
    }
  });
});

describe('DEFAULT_PROTOCOLS.ideation specifics (pln#492)', () => {
  it('exposes 4 phases in the canonical order', () => {
    const names = DEFAULT_PROTOCOLS.ideation.phases.map((p) => p.name);
    assert.deepEqual(names, ['proposal', 'critique', 'revision', 'synthesis']);
  });

  it('critique phase context_filter is adversarial-only (no positive context)', () => {
    const critique = DEFAULT_PROTOCOLS.ideation.phases.find((p) => p.name === 'critique');
    assert.ok(critique?.context_filter, 'critique must have a context_filter');
    const positiveLeaks = (critique.context_filter ?? []).filter((c) =>
      ['decisions', 'plans', 'project_vision'].includes(c),
    );
    assert.equal(
      positiveLeaks.length,
      0,
      `critique should not see positive context, got: ${positiveLeaks.join(',')}`,
    );
  });

  it('revision and synthesis see everything (wildcard)', () => {
    for (const phaseName of ['revision', 'synthesis']) {
      const phase = DEFAULT_PROTOCOLS.ideation.phases.find((p) => p.name === phaseName);
      assert.deepEqual(phase?.context_filter, ['*'], `${phaseName} should be ['*']`);
    }
  });

  it('iteration cycle is critique→revision with max 3 and saturation exit', () => {
    const iter = DEFAULT_PROTOCOLS.ideation.iteration;
    assert.ok(iter, 'ideation must have an iteration block');
    assert.deepEqual(iter.cycle, ['critique', 'revision']);
    assert.equal(iter.max_iterations, 3);
    assert.equal(iter.exit_when, 'no_new_critique_artifacts');
  });

  it('stop_condition halts on synthesis plan_draft', () => {
    const stop = DEFAULT_PROTOCOLS.ideation.stop_condition;
    assert.equal(stop.kind, 'artifact_produced');
    if (stop.kind === 'artifact_produced') {
      assert.equal(stop.phase, 'synthesis');
      assert.equal(stop.type, 'plan_draft');
    }
  });
});

describe('CRITIQUE_ARTIFACT_SUBTYPES (pln#492)', () => {
  it('exposes exactly 3 subtypes (collapsed from 6 per reframer findings)', () => {
    assert.equal(CRITIQUE_ARTIFACT_SUBTYPES.length, 3);
    assert.deepEqual([...CRITIQUE_ARTIFACT_SUBTYPES].sort(), [
      'coverage_gap',
      'memory_conflict',
      'scope_creep',
    ]);
  });
});
