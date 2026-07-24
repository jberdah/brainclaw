/**
 * pln#601 — find() ranking DISCRIMINANT (Fable-audit fix).
 *
 * The audit's concrete defect: `find("EntityRegistry")` returned ~20 results ALL
 * at score 1, so the agent could not tell the real target (`ENTITY_REGISTRY`, a
 * snake_case const) from 19 unrelated `*Registry` symbols and fell back to
 * grepping — defeating the "stop grepping blind" value prop. Root cause: the old
 * `scoreEntry` compared raw-lowercased strings, so a Pascal-case query never
 * exact/prefix/substring-matched a snake_case name and dropped to the sub-token
 * floor. The fix normalizes identifiers (separator/case-insensitive) before the
 * tiers, and biases source symbols over test-file symbols of the same name.
 *
 * These are pure unit assertions on the exported `scoreEntry` — the ranking core
 * find() sorts on — so they pin the discriminant without needing an on-disk index.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEntry } from '../../../src/core/code-map/query.js';
import type { SymbolIndexEntry } from '../../../src/core/code-map/types.js';

function entry(over: Partial<SymbolIndexEntry> & { name: string }): SymbolIndexEntry {
  return {
    node_id: `n_${over.name}_${over.path ?? 'p'}`,
    name: over.name,
    kind: 'symbol',
    subtype: over.subtype ?? null,
    path: over.path ?? `src/${over.name}.ts`,
    file_id: 'f'.repeat(64),
    score_hint: over.score_hint ?? 1.0,
  };
}

describe('pln#601 scoreEntry — separator/case-insensitive discriminant', () => {
  it('a Pascal-case query exact-matches a snake_case name (the EntityRegistry defect)', () => {
    // The RIGHT answer, in snake_case, must land in the top exact tier — not the
    // sub-token floor it used to share with every unrelated *Registry symbol.
    const target = scoreEntry(entry({ name: 'ENTITY_REGISTRY' }), 'EntityRegistry');
    const distractor = scoreEntry(entry({ name: 'UserRegistry' }), 'EntityRegistry');
    assert.equal(target, 10, 'snake_case const exact-matches the Pascal query → top tier');
    assert.ok(
      target > distractor + 5,
      `the real target (${target}) must clearly outrank an unrelated *Registry (${distractor})`,
    );
  });

  it('exact score is identical across camel / Pascal / snake / kebab spellings', () => {
    const q = 'EntityRegistry';
    const camel = scoreEntry(entry({ name: 'entityRegistry' }), q);
    const pascal = scoreEntry(entry({ name: 'EntityRegistry' }), q);
    const snake = scoreEntry(entry({ name: 'ENTITY_REGISTRY' }), q);
    const kebab = scoreEntry(entry({ name: 'entity-registry' }), q);
    assert.equal(camel, 10);
    assert.equal(pascal, 10);
    assert.equal(snake, 10);
    assert.equal(kebab, 10);
  });

  it('tiers are preserved: exact > prefix > substring > sub-token floor', () => {
    const exact = scoreEntry(entry({ name: 'parseConfig' }), 'parseConfig');
    const prefix = scoreEntry(entry({ name: 'parseConfigFile' }), 'parseConfig');
    const substr = scoreEntry(entry({ name: 'tryParseConfigOnce' }), 'parseConfig');
    // "registry" shares only the sub-token bucket with a "parseConfig" query in the
    // real gather path; here we assert an unrelated name floors at 1.
    const floor = scoreEntry(entry({ name: 'unrelatedThing' }), 'parseConfig');
    assert.ok(exact > prefix, `exact ${exact} > prefix ${prefix}`);
    assert.ok(prefix > substr, `prefix ${prefix} > substring ${substr}`);
    assert.ok(substr > floor, `substring ${substr} > floor ${floor}`);
  });

  it('exported symbols still outrank internal ones at the same tier', () => {
    const exported = scoreEntry(entry({ name: 'doWork', score_hint: 1.0 }), 'doWork');
    const internal = scoreEntry(entry({ name: 'doWork', score_hint: 0.8 }), 'doWork');
    assert.ok(exported > internal, `exported ${exported} > internal ${internal}`);
  });

  it('a source definition outranks a test-file symbol of the SAME name', () => {
    const source = scoreEntry(entry({ name: 'handleRequest', path: 'src/server/handle.ts' }), 'handleRequest');
    const testHelper = scoreEntry(
      entry({ name: 'handleRequest', path: 'tests/unit/handle.test.ts' }),
      'handleRequest',
    );
    assert.ok(source > testHelper, `source ${source} must outrank test helper ${testHelper}`);
    // Also matches spec/__mocks__/__tests__ conventions.
    const specHelper = scoreEntry(entry({ name: 'handleRequest', path: 'spec/handle_spec.rb' }), 'handleRequest');
    const mock = scoreEntry(entry({ name: 'handleRequest', path: 'src/__mocks__/handle.ts' }), 'handleRequest');
    assert.ok(source > specHelper && source > mock, 'source outranks spec + __mocks__ helpers too');
  });

  it('component/hook boost is still applied on top of the tier', () => {
    const comp = scoreEntry(entry({ name: 'UserCard', subtype: 'component' }), 'UserCard');
    const plain = scoreEntry(entry({ name: 'UserCard' }), 'UserCard');
    assert.ok(comp > plain, `component ${comp} > plain ${plain}`);
  });
});
