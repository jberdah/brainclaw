import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  add_artifact,
  advance,
  listLoopEvents,
  openLoop,
} from '../../src/core/loops/index.js';

/**
 * pln#492 phase 2.b — advance() integration with the iteration engine.
 *
 * Covers:
 *  - phase_advance_blocked event + actionable error when a phase's
 *    advance_gate is unmet (default ideation: critique → revision needs
 *    ≥3 critique artifacts).
 *  - normal iteration: end-of-cycle loops back to first cycle phase,
 *    iteration_count bumps, artifacts in new iteration are tracked.
 *  - max_iterations: at the cap, advance() emits max_iterations_reached
 *    BEFORE phase_advanced (causal order in the journal) and jumps to
 *    the post-cycle phase (synthesis).
 *  - exit_when=no_new_critique_artifacts: iteration that produced no
 *    critiques exits the cycle to synthesis without bumping further.
 */

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loops-iter-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function openIdeation(cwd: string) {
  return openLoop(
    {
      kind: 'ideation',
      title: 'phase 2.b integration',
      created_by: 'agt_test',
      slots: [{ role: 'champion', agent: 'claude-code', agent_id: 'agt_c' }],
    },
    cwd,
  );
}

describe('advance() — phase_advance_blocked on unmet gate (pln#492 phase 2.b)', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('critique → revision blocked when zero critique artifacts produced', () => {
    const loop = openIdeation(cwd);
    // Walk proposal → critique. Proposal has no advance_gate, so this is fine.
    advance({ id: loop.id, actor: 'agt_test' }, cwd);
    // Now at critique with iteration_count=0 and zero critique artifacts.
    // The default ideation gate requires ≥3 critique artifacts in current
    // phase → advance() should refuse + emit phase_advance_blocked.
    assert.throws(
      () => advance({ id: loop.id, actor: 'agt_test' }, cwd),
      /phase_advance_blocked on "critique"/,
    );
    const events = listLoopEvents(loop.id, cwd);
    const blocked = events.filter((e) => e.kind === 'phase_advance_blocked');
    assert.equal(blocked.length, 1, 'one phase_advance_blocked event recorded');
    if (blocked[0].kind === 'phase_advance_blocked') {
      assert.equal(blocked[0].phase, 'critique');
      assert.match(blocked[0].gate_reason, /count of type "critique" = 0 < n=3/);
    }
  });

  it('critique → revision allowed when ≥3 critique artifacts present', () => {
    const loop = openIdeation(cwd);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → critique
    for (let i = 0; i < 3; i++) {
      add_artifact(
        {
          id: loop.id,
          actor: 'agt_test',
          artifact: { phase: 'critique', type: 'critique', body: `critique content ${i}` },
        },
        cwd,
      );
    }
    const result = advance({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(result.loop.current_phase, 'revision');
    assert.equal(result.loop.iteration_count, 0);
  });

  it('force=true bypasses the gate', () => {
    const loop = openIdeation(cwd);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → critique
    // No artifacts; force should let us through.
    const result = advance({ id: loop.id, actor: 'agt_test', force: true }, cwd);
    assert.equal(result.loop.current_phase, 'revision');
  });
});

describe('advance() — iteration cycle (pln#492 phase 2.b)', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('end-of-cycle revision loops back to critique, iteration_count++', () => {
    const loop = openIdeation(cwd);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → critique
    for (let i = 0; i < 3; i++) {
      add_artifact(
        { id: loop.id, actor: 'agt_test', artifact: { phase: 'critique', type: 'critique', body: `critique content ${i}` } },
        cwd,
      );
    }
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → revision
    // From revision (end of cycle): iterate back to critique.
    const result = advance({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(result.loop.current_phase, 'critique');
    assert.equal(result.loop.iteration_count, 1);
  });

  it('artifacts produced after iterate carry the new iteration number', () => {
    const loop = openIdeation(cwd);
    advance({ id: loop.id, actor: 'agt_test' }, cwd);
    for (let i = 0; i < 3; i++) {
      add_artifact(
        { id: loop.id, actor: 'agt_test', artifact: { phase: 'critique', type: 'critique', body: `critique content ${i}` } },
        cwd,
      );
    }
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → revision
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // iterate → critique, iteration=1
    add_artifact(
      { id: loop.id, actor: 'agt_test', artifact: { phase: 'critique', type: 'critique', body: 'critique content' } },
      cwd,
    );
    const events = listLoopEvents(loop.id, cwd);
    const lastArtifactEvent = [...events].reverse().find((e) => e.kind === 'artifact_added');
    assert.ok(lastArtifactEvent);
    // Read the actual artifact from the thread to check iteration.
    const updated = events; // we don't have getLoop imported; use thread query indirectly
    // Instead: assert the gate refuses advance until 3 critiques in this iteration
    // (the iteration-aware gate proves iteration tracking works).
    assert.throws(
      () => advance({ id: loop.id, actor: 'agt_test' }, cwd),
      /count of type "critique" = 1 < n=3/,
      'iteration-aware gate sees only the 1 critique in iteration=1, not the 3 from iteration=0',
    );
  });
});

describe('advance() — max_iterations event (pln#492 phase 2.b)', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function fillCritique(loopId: string, cwd: string, n: number) {
    for (let i = 0; i < n; i++) {
      add_artifact(
        { id: loopId, actor: 'agt_test', artifact: { phase: 'critique', type: 'critique', body: `critique content ${i}` } },
        cwd,
      );
    }
  }

  it('emits max_iterations_reached then phase_advanced when cap hits', () => {
    const loop = openIdeation(cwd);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → critique iter 0
    fillCritique(loop.id, cwd, 3);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → revision iter 0
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // iterate → critique iter 1
    fillCritique(loop.id, cwd, 3);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → revision iter 1
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // iterate → critique iter 2
    fillCritique(loop.id, cwd, 3);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → revision iter 2
    // From revision iter 2 (end of cycle): iteration_count + 1 = 3 = max → exit_cycle via max_iterations.
    const result = advance({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(result.loop.current_phase, 'synthesis');
    assert.equal(result.loop.iteration_count, 3);

    const events = listLoopEvents(loop.id, cwd);
    const maxEvent = events.find((e) => e.kind === 'max_iterations_reached');
    assert.ok(maxEvent, 'max_iterations_reached event recorded');
    if (maxEvent && maxEvent.kind === 'max_iterations_reached') {
      assert.equal(maxEvent.phase, 'revision');
      assert.equal(maxEvent.iteration, 3);
      assert.equal(maxEvent.max_iterations, 3);
    }

    // Causal order: max_iterations_reached must come before the
    // phase_advanced event from this transition.
    const maxIdx = events.findIndex((e) => e.kind === 'max_iterations_reached');
    const lastAdvanceIdx = events.length -
      1 -
      [...events].reverse().findIndex((e) => e.kind === 'phase_advanced');
    assert.ok(maxIdx < lastAdvanceIdx, 'max_iterations_reached precedes the final phase_advanced');
  });
});

describe('advance() — exit_cycle via no_new_critique_artifacts (pln#492 phase 2.b)', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('iteration with zero new critiques exits the cycle to synthesis', () => {
    const loop = openIdeation(cwd);
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → critique iter 0
    for (let i = 0; i < 3; i++) {
      add_artifact(
        { id: loop.id, actor: 'agt_test', artifact: { phase: 'critique', type: 'critique', body: `critique content ${i}` } },
        cwd,
      );
    }
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → revision iter 0
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // iterate → critique iter 1
    // Iteration 1: produce 3 critiques (gate met) but they are required
    // to leave critique → advance to revision still works.
    for (let i = 0; i < 3; i++) {
      add_artifact(
        { id: loop.id, actor: 'agt_test', artifact: { phase: 'critique', type: 'critique', body: `critique content ${i}` } },
        cwd,
      );
    }
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // → revision iter 1
    // No NEW critiques in iteration 1's revision phase. The exit_when
    // 'no_new_critique_artifacts' check at end of cycle fires on
    // critique-typed artifacts — both iterations had them, so this exit
    // does NOT fire. The cycle iterates again instead.
    // To test the actual exit_when path we need an iteration with ZERO
    // critique artifacts. Hard to set up because the gate refuses to
    // leave critique without 3. Use force=true on the critique→revision
    // step of iteration 2 to bypass the gate so we can exercise exit_when.
    advance({ id: loop.id, actor: 'agt_test' }, cwd); // iterate → critique iter 2
    // No critiques produced in iteration 2.
    // The engine observes saturation BEFORE the quantitative critique gate:
    // requiring a force here made no_new_critique_artifacts unreachable.
    const result = advance({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(result.loop.current_phase, 'synthesis');
  });
});
