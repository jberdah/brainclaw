/**
 * pln#639 — gate integrity. Two defects found by the pln#638 1a/1b ideation.
 *
 * BUG-1 — an artifact with NO usable content satisfied a gate. `body` is optional
 * in both the input schema and `LoopArtifactSchema`, so `{phase, type}` alone is
 * schema-valid and used to count toward `min_artifacts_by_type`. A phase gate —
 * whose entire job is to prove the phase produced real work — could therefore be
 * opened by producing nothing.
 *
 * The invariant already existed one layer too low: `ideationReducer` states
 * "a bare summary with no critique body → slot failed, gate stays shut". That
 * guard covers only the LANE-RESULT reducer path; a direct `add_artifact` /
 * `complete_turn` MCP call bypassed it. These tests pin it in the evaluator, which
 * every entry path goes through.
 *
 * BUG-2 — see loops-late-return-phase.test.ts.
 *
 * NOTE ON THE PRE-EXISTING SUITE: `loops-phase-advance-gate.test.ts` built its
 * fixtures WITHOUT a body, so it asserted that empty artifacts open a gate — the
 * tests encoded the bug. Those fixtures now carry content (their intent was
 * always counting), and the empty case lives here, stated on purpose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePhaseAdvanceGate,
  evaluateStopCondition,
  type LoopThread,
  type StopCondition,
} from '../../src/core/loops/index.js';

function makeThread(over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_content1',
    version: 1,
    mutation_id: 'mut_1',
    kind: 'ideation',
    title: 'gate content integrity',
    status: 'open',
    phases: [{ name: 'critique' }, { name: 'revision' }],
    current_phase: 'critique',
    iteration_count: 0,
    open_questions: [],
    slots: [],
    artifacts: [],
    created_at: '2026-08-01T12:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    created_by: 'agt_test',
    ...over,
  };
}

function artifact(
  id: string,
  extra: Partial<LoopThread['artifacts'][number]> = {},
): LoopThread['artifacts'][number] {
  return {
    artifact_id: id,
    phase: 'critique',
    type: 'critique',
    produced_at: '2026-08-01T12:00:00.000Z',
    ...extra,
  };
}

const GATE: StopCondition = { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' };

describe('pln#639 BUG-1 — a content-less artifact never satisfies a gate', () => {
  it('three EMPTY artifacts do not open a gate of n=3', () => {
    // The headline defect. Before the fix this advanced.
    const thread = makeThread({ artifacts: [artifact('a1'), artifact('a2'), artifact('a3')] });
    assert.equal(evaluateStopCondition(thread, GATE), false);
    assert.equal(evaluatePhaseAdvanceGate(thread, GATE).advance, false);
  });

  it('three artifacts WITH bodies open it', () => {
    const thread = makeThread({
      artifacts: [
        artifact('a1', { body: 'real critique one' }),
        artifact('a2', { body: 'real critique two' }),
        artifact('a3', { body: 'real critique three' }),
      ],
    });
    assert.equal(evaluatePhaseAdvanceGate(thread, GATE).advance, true);
  });

  it('a REF-based artifact counts — it carries no inline body by design', () => {
    // The rule is "no usable content", NOT "body required": a ref-based artifact's
    // payload lives in the referenced entity. Getting this wrong would break every
    // ref artifact rather than only the empty ones.
    const thread = makeThread({
      artifacts: [
        artifact('a1', { ref: { kind: 'candidate', id: 'cnd_abc' } }),
        artifact('a2', { ref: { kind: 'candidate', id: 'cnd_def' } }),
        artifact('a3', { ref: { kind: 'candidate', id: 'cnd_ghi' } }),
      ],
    });
    assert.equal(evaluatePhaseAdvanceGate(thread, GATE).advance, true);
  });

  it('a whitespace-only body is not content', () => {
    const thread = makeThread({
      artifacts: [
        artifact('a1', { body: '   \n\t ' }),
        artifact('a2', { body: 'real' }),
        artifact('a3', { body: 'real' }),
      ],
    });
    assert.equal(evaluatePhaseAdvanceGate(thread, GATE).advance, false);
  });

  it('mixed: only the content-carrying ones count toward n', () => {
    const thread = makeThread({
      artifacts: [
        artifact('a1', { body: 'real' }),
        artifact('a2'),                       // empty — ignored
        artifact('a3', { body: 'real' }),
      ],
    });
    assert.equal(evaluateStopCondition(thread, GATE), false, '2 usable < n=3');
  });

  it('the unmet-gate message NAMES the discarded empties', () => {
    // Otherwise "count = 0 < n = 3" is baffling to an operator who can see three
    // artifacts of the right type sitting in the thread.
    const thread = makeThread({ artifacts: [artifact('a1'), artifact('a2'), artifact('a3')] });
    const reason = evaluatePhaseAdvanceGate(thread, GATE).gate_reason ?? '';
    assert.match(reason, /count of type "critique" = 0/);
    assert.match(reason, /3 artifact\(s\) of this type carry no usable content/);
  });

  it('says nothing about empties when there are none', () => {
    const thread = makeThread({ artifacts: [artifact('a1', { body: 'real' })] });
    const reason = evaluatePhaseAdvanceGate(thread, GATE).gate_reason ?? '';
    assert.doesNotMatch(reason, /no usable content/);
  });

  it('loop-scope gates apply the same content filter', () => {
    const loopGate: StopCondition = { kind: 'min_artifacts_by_type', type: 'critique', n: 2, scope: 'loop' };
    const empty = makeThread({
      artifacts: [artifact('a1', { phase: 'revision' }), artifact('a2', { phase: 'synthesis' })],
    });
    assert.equal(evaluateStopCondition(empty, loopGate), false, 'empties must not count at loop scope either');

    const withBodies = makeThread({
      artifacts: [
        artifact('a1', { phase: 'revision', body: 'x' }),
        artifact('a2', { phase: 'synthesis', body: 'y' }),
      ],
    });
    assert.equal(evaluateStopCondition(withBodies, loopGate), true);
  });

  it('ACCEPTANCE: the real loop corpus contains no content-less artifact', () => {
    // Safety check on live data before this fix could ever stall a running loop.
    // Measured when the fix landed: 219 loops, 321 artifacts, 0 content-less.
    // If this ever fails, a loop in the store now depends on an empty artifact and
    // the migration question is real rather than theoretical.
    const dir = path.join(process.cwd(), '.brainclaw', 'loops');
    if (!fs.existsSync(dir)) return; // not running against a real store

    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walk(dir).filter((f) => f.endsWith('.json'))) {
      let loop: { id?: string; status?: string; artifacts?: Array<Record<string, unknown>> };
      try { loop = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; }
      for (const a of loop.artifacts ?? []) {
        scanned += 1;
        const usable = String(a.body ?? '').trim().length > 0 || a.ref !== undefined;
        if (!usable && (loop.status === 'open' || loop.status === 'active')) {
          offenders.push(`${loop.id} phase=${String(a.phase)} type=${String(a.type)}`);
        }
      }
    }
    assert.ok(scanned > 0, 'expected a real corpus');
    assert.deepEqual(offenders, [], `live loops depend on content-less artifacts:\n${offenders.join('\n')}`);
  });
});
