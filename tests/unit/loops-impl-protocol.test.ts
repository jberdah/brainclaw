import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNextPhase,
  evaluateGateCondition,
  hasPassingVerifyReportInIteration,
  type LoopArtifact,
  type LoopThread,
} from '../../src/core/loops/index.js';
import { DEFAULT_PROTOCOLS, KNOWN_ARTIFACT_BODY_SCHEMAS, VerifyReportBodySchema } from '../../src/core/loops/types.js';

// pln#609 Increment 1 — enriched implementation protocol + command_green
// iteration exit (PURE; no command execution — that's Increment 2).

const impl = { phases: DEFAULT_PROTOCOLS.implementation.phases, iteration: DEFAULT_PROTOCOLS.implementation.iteration };

function makeThread(over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1, id: 'lop_impl1', version: 1, mutation_id: 'mut_1',
    kind: 'implementation', title: 'impl test', status: 'open',
    phases: DEFAULT_PROTOCOLS.implementation.phases,
    current_phase: 'verify', iteration_count: 0,
    open_questions: [], slots: [], artifacts: [],
    created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-24T00:00:00.000Z',
    created_by: 'agt_test',
    ...over,
  };
}

function verifyReport(passed: boolean, iteration: number): LoopArtifact {
  return {
    artifact_id: `art_${passed}_${iteration}_${Math.random().toString(36).slice(2, 8)}`,
    phase: 'verify', type: 'verify_report',
    body: JSON.stringify({ command: 'npm test', exit_code: passed ? 0 : 1, passed }),
    iteration,
    produced_at: '2026-07-24T00:00:00.000Z', produced_by: 'agt_worker',
  } as LoopArtifact;
}

function laneVerifyReport(lane: string): LoopArtifact {
  const report = verifyReport(true, 0);
  return { ...report, body: JSON.stringify({ command: 'npm test', exit_code: 0, passed: true, lane }) };
}

describe('pln#609 — enriched implementation protocol literal', () => {
  it('has the bind→execute↔verify→handoff_ready shape with a command_green cycle', () => {
    const p = DEFAULT_PROTOCOLS.implementation;
    assert.deepEqual(p.phases.map((ph) => ph.name), ['bind', 'execute', 'verify', 'handoff_ready']);
    assert.deepEqual(p.iteration?.cycle, ['execute', 'verify']);
    assert.equal(p.iteration?.max_iterations, 3);
    assert.equal(p.iteration?.exit_when, 'command_green');
    const verify = p.phases.find((ph) => ph.name === 'verify')!;
    assert.equal(verify.advance_gate?.kind, 'min_artifacts_by_type');
    assert.equal((verify.advance_gate as { type?: string }).type, 'verify_report');
    // stop_condition: completed on handoff, blocked on cap exhaustion.
    assert.equal(p.stop_condition?.kind, 'any');
  });
});

describe('pln#609 — verify_report body schema', () => {
  it('is registered and validates a well-formed report', () => {
    assert.equal(KNOWN_ARTIFACT_BODY_SCHEMAS.verify_report, VerifyReportBodySchema);
    assert.ok(VerifyReportBodySchema.safeParse({ command: 'npm test', exit_code: 0, passed: true }).success);
    assert.ok(!VerifyReportBodySchema.safeParse({ command: 'npm test', exit_code: 0 }).success, 'passed is required');
  });
});

describe('pln#609 — command_green iteration exit (pure)', () => {
  it('exits the cycle to handoff_ready when a passing verify_report exists THIS iteration', () => {
    const thread = makeThread({ iteration_count: 0, artifacts: [verifyReport(true, 0)] });
    const d = decideNextPhase(thread, impl);
    assert.equal(d.kind, 'exit_cycle');
    assert.equal((d as { reason?: string }).reason, 'command_green');
    assert.equal(d.target, 'handoff_ready');
  });

  it('iterates back to execute on a red report while budget remains', () => {
    const thread = makeThread({ iteration_count: 0, artifacts: [verifyReport(false, 0)] });
    const d = decideNextPhase(thread, impl);
    assert.equal(d.kind, 'iterate_to');
    assert.equal(d.target, 'execute');
    assert.equal(d.iteration, 1);
  });

  it('exits via max_iterations (→ blocked) on red at the cap', () => {
    const thread = makeThread({ iteration_count: 2, artifacts: [verifyReport(false, 2)] });
    const d = decideNextPhase(thread, impl);
    assert.equal(d.kind, 'max_iterations');
    assert.equal(d.target, 'handoff_ready');
  });

  it('a STALE green from a prior iteration does NOT satisfy the current one', () => {
    // green in iteration 0, now in iteration 1 with a red report → must iterate/cap, not exit green.
    const thread = makeThread({ iteration_count: 1, artifacts: [verifyReport(true, 0), verifyReport(false, 1)] });
    assert.equal(hasPassingVerifyReportInIteration(thread, 1), false, 'iteration-1 has no passing report');
    assert.equal(hasPassingVerifyReportInIteration(thread, 0), true);
    const d = decideNextPhase(thread, impl);
    assert.notEqual((d as { reason?: string }).reason, 'command_green');
  });

  it('absence of any verify_report reads as not-green (never default-open)', () => {
    const thread = makeThread({ iteration_count: 0, artifacts: [] });
    assert.equal(hasPassingVerifyReportInIteration(thread, 0), false);
    assert.notEqual((decideNextPhase(thread, impl) as { reason?: string }).reason, 'command_green');
  });

  it('requires a green report from every bound implementation lane', () => {
    const slots = [
      { slot_id: 'lsl_a', role: 'implementer', status: 'done' as const, lane: 'api' },
      { slot_id: 'lsl_b', role: 'implementer', status: 'done' as const, lane: 'ui' },
    ];
    const partial = makeThread({ slots, artifacts: [laneVerifyReport('api')] });
    assert.equal(hasPassingVerifyReportInIteration(partial, 0), false);
    const complete = makeThread({ slots, artifacts: [laneVerifyReport('api'), laneVerifyReport('ui')] });
    assert.equal(hasPassingVerifyReportInIteration(complete, 0), true);
    const gate = DEFAULT_PROTOCOLS.implementation.phases.find((phase) => phase.name === 'verify')!.advance_gate!;
    assert.equal(evaluateGateCondition(partial, gate).passed, false, 'verify phase waits for every lane report');
    assert.equal(evaluateGateCondition(complete, gate).passed, true);
  });
});
