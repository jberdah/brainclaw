/**
 * pln#638 PR-5 — the worker reply contract.
 *
 * Proof #1 of pln#638: a critic typed its artifact `coverage_gap` instead of
 * `critique` — schema-valid, invisible to the gate, loop stalled, champion
 * re-registered by hand. The type was known at dispatch; it never travelled.
 *
 * Three layers pinned here, because this session's failure mode is a green test
 * one layer below the surface:
 *
 *   1. derivation — gate → contract, all/any preserved, non-artifact predicates
 *      named instead of dropped;
 *   2. same-source — the prose and the NextAction adapter come off ONE object,
 *      asserted by checking the action's args all appear in the prose;
 *   3. EMISSION — the assembled ideation brief (buildIdeationBrief, the thing
 *      actually delivered to a critic) contains the section, survives memory
 *      truncation, and freezes the dispatch phase.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdeationBrief,
  deriveWorkerReplyContract,
  renderWorkerReplyProse,
  workerReplyNextAction,
  type LoopThread,
} from '../../src/core/loops/index.js';

function makeThread(over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_contract1',
    version: 7,
    mutation_id: 'mut_1',
    kind: 'ideation',
    title: 'contract test',
    status: 'open',
    phases: [
      { name: 'proposal' },
      {
        name: 'critique',
        advance_gate: { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' },
      },
      { name: 'revision' },
    ],
    current_phase: 'critique',
    iteration_count: 0,
    open_questions: [],
    slots: [],
    artifacts: [
      {
        artifact_id: 'art_p', phase: 'proposal', type: 'proposal',
        body: 'the proposal seed', produced_at: '2026-08-02T10:00:00.000Z',
      },
    ],
    created_at: '2026-08-02T10:00:00.000Z',
    updated_at: '2026-08-02T10:00:00.000Z',
    created_by: 'agt_test',
    ...over,
  };
}

/** A memory provider that returns nothing — briefs must work without memory. */
const emptyProvider = { fetch: (): [] => [] };

describe('worker reply contract — derivation', () => {
  it('a min_artifacts_by_type gate yields the requirement with n and scope', () => {
    const c = deriveWorkerReplyContract(makeThread());
    assert.ok(c);
    assert.equal(c.phase, 'critique');
    assert.equal(c.loop_version, 7);
    assert.deepEqual(c.requirements, [{ type: 'critique', n: 3, scope: 'phase' }]);
    assert.equal(c.composition, 'single');
  });

  it('a composite ALL gate keeps every requirement AND names the non-artifact predicate', () => {
    const c = deriveWorkerReplyContract(makeThread({
      phases: [{
        name: 'critique',
        advance_gate: {
          kind: 'all',
          conditions: [
            { kind: 'reviewer_green' },
            { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' },
            { kind: 'min_artifacts_by_type', type: 'verify_report', n: 1, scope: 'phase' },
          ],
        },
      }],
    }));
    assert.ok(c);
    assert.equal(c.composition, 'all');
    assert.deepEqual(c.requirements.map((r) => r.type), ['critique', 'verify_report']);
    assert.deepEqual(c.other_conditions, ['reviewer_green'], 'the predicate a worker cannot satisfy must be NAMED, not dropped');
  });

  it('ANY stays ANY — "all types required" would be wrong for an alternative', () => {
    // The adversarial critique's correction, kept as a test.
    const c = deriveWorkerReplyContract(makeThread({
      phases: [{
        name: 'critique',
        advance_gate: {
          kind: 'any',
          conditions: [
            { kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' },
            { kind: 'artifact_produced', phase: 'critique', type: 'waiver' },
          ],
        },
      }],
    }));
    assert.ok(c);
    assert.equal(c.composition, 'any');
    assert.match(renderWorkerReplyProse(c), /`critique`[^]*OR[^]*`waiver`/);
  });

  it('NESTED composites are walked, not just the top level', () => {
    const c = deriveWorkerReplyContract(makeThread({
      phases: [{
        name: 'critique',
        advance_gate: {
          kind: 'all',
          conditions: [
            { kind: 'no_open_questions' },
            {
              kind: 'any',
              conditions: [
                { kind: 'min_artifacts_by_type', type: 'critique', n: 2, scope: 'phase' },
                { kind: 'artifact_produced', phase: 'critique', type: 'synthesis' },
              ],
            },
          ],
        },
      }],
    }));
    assert.ok(c);
    assert.deepEqual(c.requirements.map((r) => r.type), ['critique', 'synthesis']);
    assert.deepEqual(c.other_conditions, ['no_open_questions']);
  });

  it('no artifact-typed gate → NO contract, no invented obligation', () => {
    assert.equal(deriveWorkerReplyContract(makeThread({
      phases: [{ name: 'critique', advance_gate: { kind: 'manual' } }],
    })), undefined);
    assert.equal(deriveWorkerReplyContract(makeThread({
      phases: [{ name: 'critique' }],
    })), undefined);
  });
});

describe('worker reply contract — prose and action share one source', () => {
  it('every value in the NextAction args appears in the prose', () => {
    const c = deriveWorkerReplyContract(makeThread())!;
    const prose = renderWorkerReplyProse(c);
    const action = workerReplyNextAction(c);

    assert.equal(action.tool, 'bclaw_loop');
    const artifact = (action.args.artifact ?? {}) as Record<string, string>;
    // The single-source assertion: loop id, phase and type from the ACTION must
    // all be present verbatim in the PROSE — if either side drifts, this fails.
    for (const value of [String(action.args.loop_id), artifact.phase, artifact.type]) {
      assert.ok(prose.includes(value), `prose must contain "${value}" from the action args`);
    }
  });

  it('the prose states the pln#639 rules: non-empty body, byte cap, file fallback type', () => {
    const prose = renderWorkerReplyProse(deriveWorkerReplyContract(makeThread())!);
    assert.match(prose, /NON-EMPTY/i, 'an empty artifact no longer counts toward a gate — the worker must know');
    assert.match(prose, /4096 bytes/, 'the inline body cap must be stated');
    assert.match(prose, /"artifact_type":"critique"/, 'the LANE-RESULT fallback must pre-fill the exact type');
    assert.match(prose, /FROZEN for loop version 7/, 'the dispatch version must travel');
    assert.match(prose, /do not re-target a newer phase/, 'late-return guidance mirrors pln#639 BUG-2 attribution');
  });
});

describe('worker reply contract — EMITTED by the assembled brief', () => {
  it('the delivered ideation brief carries the contract section', () => {
    // The seam test. Every earlier failure of this class had the helper green
    // and the surface silent.
    const brief = buildIdeationBrief({ thread: makeThread(), slotRole: 'critic', memoryProvider: emptyProvider });
    assert.match(brief.text, /## Deliverable contract — loop lop_contract1, phase "critique"/);
    assert.match(brief.text, /`critique` \(n≥3, phase scope\)/);
    assert.match(brief.text, /add_artifact/);
  });

  it('the contract survives memory truncation — it is a FIXED part', () => {
    // A brief that keeps its memory bundle but loses its reply contract would
    // recreate proof #1. Starve the budget and the contract must still be there.
    const noisyProvider = {
      fetch: (): Array<{ id: string; category: string; text: string }> =>
        Array.from({ length: 50 }, (_, i) => ({
          id: `trp_${i}`, category: 'traps', text: 'x'.repeat(400),
        })),
    };
    const brief = buildIdeationBrief({
      thread: makeThread(),
      slotRole: 'critic',
      memoryProvider: noisyProvider as never,
      maxChars: 3000,
    });
    assert.match(brief.text, /## Deliverable contract/, 'truncation must never eat the contract');
  });

  it('a phase with no artifact gate emits no contract section', () => {
    const brief = buildIdeationBrief({
      thread: makeThread({ current_phase: 'revision', phases: [{ name: 'revision' }] }),
      slotRole: 'critic',
      memoryProvider: emptyProvider,
    });
    assert.doesNotMatch(brief.text, /## Deliverable contract/);
  });

  it('the frozen phase is the DISPATCH phase, whatever the loop does later', () => {
    // buildIdeationBrief reads current_phase at build time; the prose pins that
    // exact string with the version, so a worker returning late knows where its
    // work lands (pln#639 BUG-2 attribution).
    const thread = makeThread();
    const brief = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: emptyProvider });
    assert.match(brief.text, /phase "critique"/);
    assert.match(brief.text, /loop version 7/);
  });
});
