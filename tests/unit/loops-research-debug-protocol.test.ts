import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideNextPhase, type LoopArtifact, type LoopThread } from '../../src/core/loops/index.js';
import { DEFAULT_PROTOCOLS } from '../../src/core/loops/types.js';

// pln#628 PART 3 — research + debug protocol enrichment. PURE FSM/schema slice;
// reuses existing machinery (command_green / critic_signal / min_artifacts_by_type).

function proto(kind: 'research' | 'debug') {
  return { phases: DEFAULT_PROTOCOLS[kind].phases, iteration: DEFAULT_PROTOCOLS[kind].iteration };
}

function makeThread(kind: 'research' | 'debug', current_phase: string, over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1, id: `lop_${kind}1`, version: 1, mutation_id: 'mut_1',
    kind, title: `${kind} test`, status: 'open',
    phases: DEFAULT_PROTOCOLS[kind].phases,
    current_phase, iteration_count: 0,
    open_questions: [], slots: [], artifacts: [],
    created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.000Z', created_by: 'agt_test',
    ...over,
  };
}

function artifact(type: string, iteration: number, phase: string, body?: string): LoopArtifact {
  return {
    artifact_id: `art_${type}_${iteration}_${Math.random().toString(36).slice(2, 8)}`,
    phase, type, iteration, produced_at: '2026-07-24T00:00:00.000Z', produced_by: 'agt_w',
    ...(body !== undefined ? { body } : {}),
  } as LoopArtifact;
}
const greenReport = (it: number) => artifact('verify_report', it, 'fix', JSON.stringify({ command: 'repro', exit_code: 0, passed: true }));
const redReport = (it: number) => artifact('verify_report', it, 'fix', JSON.stringify({ command: 'repro', exit_code: 1, passed: false }));
const criticSignal = (it: number) => artifact('critic_signal', it, 'synthesize');

describe('pln#628 PART 3 — research protocol', () => {
  it('is ideation-shaped and ALWAYS delivers (no max_iterations in stop → no blocked)', () => {
    const p = DEFAULT_PROTOCOLS.research;
    assert.deepEqual(p.phases.map((ph) => ph.name), ['investigate', 'synthesize', 'conclude']);
    assert.deepEqual(p.iteration?.cycle, ['investigate', 'synthesize']);
    assert.equal(p.iteration?.exit_when, 'critic_signal');
    assert.equal(p.phases.find((ph) => ph.name === 'investigate')!.advance_gate?.kind, 'min_artifacts_by_type');
    assert.equal(p.stop_condition?.kind, 'artifact_produced');
    assert.equal((p.stop_condition as { type?: string }).type, 'synthesis');
  });

  it('exits to conclude on a critic_signal; iterates otherwise; caps to conclude (never blocked)', () => {
    const green = decideNextPhase(makeThread('research', 'synthesize', { iteration_count: 0, artifacts: [criticSignal(0)] }), proto('research'));
    assert.equal(green.kind, 'exit_cycle');
    assert.equal(green.target, 'conclude');
    const iter = decideNextPhase(makeThread('research', 'synthesize', { iteration_count: 0, artifacts: [] }), proto('research'));
    assert.equal(iter.kind, 'iterate_to');
    assert.equal(iter.target, 'investigate');
    const cap = decideNextPhase(makeThread('research', 'synthesize', { iteration_count: 2, artifacts: [] }), proto('research'));
    assert.equal(cap.kind, 'max_iterations');
    assert.equal(cap.target, 'conclude');
  });
});

describe('pln#628 PART 3 — debug protocol', () => {
  it('is implementation-shaped with a command_green fix cycle', () => {
    const p = DEFAULT_PROTOCOLS.debug;
    assert.deepEqual(p.phases.map((ph) => ph.name), ['reproduce', 'hypothesize', 'isolate', 'fix', 'handoff']);
    assert.deepEqual(p.iteration?.cycle, ['hypothesize', 'isolate', 'fix']);
    assert.equal(p.iteration?.exit_when, 'command_green');
    assert.equal(p.phases.find((ph) => ph.name === 'reproduce')!.advance_gate?.kind, 'artifact_produced');
    assert.equal(p.phases.find((ph) => ph.name === 'fix')!.advance_gate?.kind, 'min_artifacts_by_type');
    assert.equal(p.stop_condition?.kind, 'any');
  });

  it('exits to handoff when the repro is green; iterates on red; caps to handoff (→ blocked)', () => {
    const green = decideNextPhase(makeThread('debug', 'fix', { iteration_count: 0, artifacts: [greenReport(0)] }), proto('debug'));
    assert.equal(green.kind, 'exit_cycle');
    assert.equal((green as { reason?: string }).reason, 'command_green');
    assert.equal(green.target, 'handoff');
    const iter = decideNextPhase(makeThread('debug', 'fix', { iteration_count: 0, artifacts: [redReport(0)] }), proto('debug'));
    assert.equal(iter.kind, 'iterate_to');
    assert.equal(iter.target, 'hypothesize');
    assert.equal(iter.iteration, 1);
    const cap = decideNextPhase(makeThread('debug', 'fix', { iteration_count: 2, artifacts: [redReport(2)] }), proto('debug'));
    assert.equal(cap.kind, 'max_iterations');
    assert.equal(cap.target, 'handoff');
  });

  it('a stale green from a prior iteration does not satisfy the current fix cycle', () => {
    const d = decideNextPhase(makeThread('debug', 'fix', { iteration_count: 1, artifacts: [greenReport(0), redReport(1)] }), proto('debug'));
    assert.notEqual((d as { reason?: string }).reason, 'command_green');
  });
});
