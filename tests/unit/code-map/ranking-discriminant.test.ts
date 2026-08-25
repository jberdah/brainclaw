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
import { scoreEntry, isTestPath } from '../../../src/core/code-map/query.js';
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

  it('tiers are preserved and sub-token-only noise scores zero', () => {
    const exact = scoreEntry(entry({ name: 'parseConfig' }), 'parseConfig');
    const prefix = scoreEntry(entry({ name: 'parseConfigFile' }), 'parseConfig');
    const substr = scoreEntry(entry({ name: 'tryParseConfigOnce' }), 'parseConfig');
    // Candidate gathering may share a generic token across languages/projects;
    // without a normalized textual match that candidate is noise, not evidence.
    const floor = scoreEntry(entry({ name: 'unrelatedThing' }), 'parseConfig');
    assert.ok(exact > prefix, `exact ${exact} > prefix ${prefix}`);
    assert.ok(prefix > substr, `prefix ${prefix} > substring ${substr}`);
    assert.ok(substr > floor, `substring ${substr} > floor ${floor}`);
    assert.equal(floor, 0);
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

describe('pln#601 isTestPath — polyglot test-file classification (review F1/F3)', () => {
  it('recognizes directory conventions across languages', () => {
    for (const p of [
      'tests/unit/foo.test.ts',
      'test/foo.py',
      'src/__tests__/foo.ts',
      'spec/models/user_spec.rb',
      'src/__mocks__/handle.ts',
    ]) {
      assert.equal(isTestPath(p), true, `${p} is a test path`);
    }
  });

  it('recognizes filename conventions for the newly-added languages (F1)', () => {
    // These used to be missed — the test-penalty was JS/TS-only, so it silently
    // did nothing for Go/Python/Ruby/C#/Java/Rust projects.
    for (const p of [
      'internal/server/handler_test.go', // Go standard
      'pkg/foo/test_helpers.py', // pytest prefix
      'app/models/user_test.py', // pytest suffix
      'lib/parser_spec.rb', // RSpec/minitest
      'src/Services/OrderTest.cs', // xUnit PascalCase
      'src/Services/OrderTests.cs',
      'src/main/UserServiceTest.java', // JUnit
      'src/lib/parser_test.rs', // Rust convention
      'src/api/handler.spec.ts', // JS/TS (still works)
    ]) {
      assert.equal(isTestPath(p), true, `${p} is a test file`);
    }
  });

  it('does NOT misclassify source files that merely contain "test"/"spec" (F2 direction)', () => {
    for (const p of [
      'src/contest/engine.ts', // "contest" contains "test"
      'src/latest.ts',
      'src/respec.ts',
      'src/Contest.cs', // lowercase "test" inside → not the PascalCase suffix
      'src/mytest.ts', // no separator before "test"
      'src/protocols/handler.go',
    ]) {
      assert.equal(isTestPath(p), false, `${p} is a SOURCE file`);
    }
  });
});
