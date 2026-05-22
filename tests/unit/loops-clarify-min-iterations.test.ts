import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AtomicStopConditionSchema,
  BOOTSTRAP_PRESET,
  advance,
  evaluateStopCondition,
  getLoop,
  listLoopEvents,
  openLoop,
  writeThreadFile,
  type LoopThread,
} from '../../src/core/loops/index.js';

/**
 * pln#516 step 2 — `min_iterations` StopCondition kind + clarify gate floor.
 *
 * The bootstrap preset's clarify phase advance_gate was `any [no_open_questions,
 * max_iterations: 1]`. `no_open_questions` is trivially true at clarify-entry
 * (open_questions only fills once the champion calls requestInput), so advance()
 * walked propose → clarify → review_draft in a single step (can_d5a41770,
 * run_4b0500c6). The fix: wrap the original `any` exit inside an `all` with a
 * `min_iterations >= 1` floor. The new `min_iterations` atomic kind is the
 * primitive that makes that gate expressible.
 */

function makeThread(over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_minitr00000',
    version: 1,
    mutation_id: 'mut_1',
    kind: 'ideation',
    title: 'min_iterations evaluator test',
    status: 'open',
    phases: [{ name: 'clarify' }],
    current_phase: 'clarify',
    iteration_count: 0,
    open_questions: [],
    slots: [],
    artifacts: [],
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    created_by: 'agt_test',
    ...over,
  };
}

describe('evaluateStopCondition — min_iterations (pln#516 step 2)', () => {
  it('iteration_count=0, n=1 → false (floor not reached)', () => {
    const thread = makeThread({ iteration_count: 0 });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'min_iterations', n: 1 }),
      false,
    );
  });

  it('iteration_count=1, n=1 → true (floor reached)', () => {
    const thread = makeThread({ iteration_count: 1 });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'min_iterations', n: 1 }),
      true,
    );
  });

  it('iteration_count=5, n=3 → true (floor exceeded)', () => {
    const thread = makeThread({ iteration_count: 5 });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'min_iterations', n: 3 }),
      true,
    );
  });
});

describe('AtomicStopConditionSchema — min_iterations (pln#516 step 2)', () => {
  it('accepts { kind: "min_iterations", n: 1 }', () => {
    const parsed = AtomicStopConditionSchema.parse({ kind: 'min_iterations', n: 1 });
    assert.deepEqual(parsed, { kind: 'min_iterations', n: 1 });
  });

  it('rejects { kind: "min_iterations", n: 0 } (n must be positive)', () => {
    const result = AtomicStopConditionSchema.safeParse({ kind: 'min_iterations', n: 0 });
    assert.equal(result.success, false);
  });

  it('rejects { kind: "min_iterations", n: -1 }', () => {
    const result = AtomicStopConditionSchema.safeParse({ kind: 'min_iterations', n: -1 });
    assert.equal(result.success, false);
  });

  it('rejects { kind: "min_iterations" } with no n', () => {
    const result = AtomicStopConditionSchema.safeParse({ kind: 'min_iterations' });
    assert.equal(result.success, false);
  });
});

describe('advance() — clarify gate blocks at iteration_count=0 (pln#516 step 2)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-clarify-mini-'));
    fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function openBootstrap(): LoopThread {
    return openLoop(
      {
        kind: 'ideation',
        title: 'clarify min_iterations test',
        phases: BOOTSTRAP_PRESET.phases,
        stop_condition: BOOTSTRAP_PRESET.stop_condition,
        protocol: BOOTSTRAP_PRESET.protocol,
        slots: [{ role: 'champion', agent: 'claude-code', agent_id: 'agt_champion' }],
        created_by: 'agt_test',
      },
      cwd,
    );
  }

  it('propose → clarify lands at clarify (does not skip into review_draft)', () => {
    const loop = openBootstrap();
    // Force through survey + propose without satisfying their artifact gates;
    // the goal is to land at clarify, not exercise the upstream phases here.
    advance({ id: loop.id, actor: 'agt_test', force: true }, cwd); // survey → propose
    const result = advance({ id: loop.id, actor: 'agt_test', force: true }, cwd); // propose → clarify
    assert.equal(result.loop.current_phase, 'clarify');
    assert.equal(result.loop.iteration_count, 0);
  });

  it('clarify with iteration_count=0 throws phase_advance_blocked: min_iterations unmet', () => {
    const loop = openBootstrap();
    advance({ id: loop.id, actor: 'agt_test', force: true }, cwd);
    advance({ id: loop.id, actor: 'agt_test', force: true }, cwd); // → clarify
    assert.throws(
      () => advance({ id: loop.id, actor: 'agt_test' }, cwd),
      /phase_advance_blocked on "clarify".*min_iterations unmet/s,
    );
    const events = listLoopEvents(loop.id, cwd);
    const blocked = events.filter((e) => e.kind === 'phase_advance_blocked');
    assert.equal(blocked.length, 1);
    if (blocked[0].kind === 'phase_advance_blocked') {
      assert.equal(blocked[0].phase, 'clarify');
      assert.match(
        blocked[0].gate_reason,
        /min_iterations unmet: iteration_count \(0\) < required \(1\)/,
      );
    }
  });

  it('after bumping iteration_count to 1, advance from clarify succeeds (no_open_questions branch fires)', () => {
    const loop = openBootstrap();
    advance({ id: loop.id, actor: 'agt_test', force: true }, cwd);
    advance({ id: loop.id, actor: 'agt_test', force: true }, cwd); // → clarify
    // Programmatically bump iteration_count to 1 to simulate one clarify tick
    // having elapsed (in real flow the champion would have called requestInput
    // and then provideInput, advancing the iteration). open_questions stays []
    // so the inner `any` branch fires via no_open_questions.
    const atClarify = getLoop(loop.id, cwd);
    assert.ok(atClarify);
    writeThreadFile(
      { ...atClarify, iteration_count: 1, version: atClarify.version + 1 },
      cwd,
    );

    const result = advance({ id: loop.id, actor: 'agt_test' }, cwd);
    assert.equal(result.loop.current_phase, 'review_draft');
  });
});
