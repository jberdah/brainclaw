/**
 * Code Map P1a — QueryRuntime UNIT tests (spec §7 / Grok #5).
 *
 * Beside the end-to-end provider oracle, these lock the generic runtime's
 * capture→draft mapping on hand-written snippets (definitions, imports,
 * re-exports, local export clauses, multi-declarator ordinals) and prove the
 * compile-once query cache is reused process-wide rather than recompiled per file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWithQueries,
  __resetQueryCache,
  __queryCacheSize,
} from '../../../src/core/code-map/lang/query-runtime.js';
import { typeScriptProvider } from '../../../src/core/code-map/lang/typescript/index.js';
import type { CodeLang } from '../../../src/core/code-map/types.js';

const TAGS = typeScriptProvider.queries.tags;
const IMPORTS = typeScriptProvider.queries.imports;
const ENCLOSING = typeScriptProvider.queries.enclosingStatementNodeTypes;

/** Drive the runtime over a TS snippet (typescript grammar by default). */
async function run(source: string, lang: CodeLang = 'typescript') {
  return extractWithQueries({
    providerId: 'js-ts',
    lang,
    source,
    sizeBytes: Buffer.byteLength(source),
    maxParseFileBytes: 1024 * 1024,
    path: 'snippet.ts',
    grammarForLang: typeScriptProvider.parser.grammarForLang,
    tagsSource: TAGS.sourceForLang(lang),
    tagsHash: TAGS.hashForLang(lang),
    importsSource: IMPORTS.sourceForLang(lang),
    importsHash: IMPORTS.hashForLang(lang),
    enclosingStatementNodeTypes: ENCLOSING,
  });
}

describe('code-map query runtime — capture→draft mapping', () => {
  it('maps function / class / type / interface definitions with the structural subtype', async () => {
    const draft = await run('function f(){}\nclass C{}\ntype T = number;\ninterface I{ x: number }');
    assert.equal(draft.attributes?.parseStatus, 'parsed');
    const byName = new Map(draft.definitions.map((d) => [d.name, d.subtype]));
    assert.equal(byName.get('f'), 'function');
    assert.equal(byName.get('C'), 'class');
    assert.equal(byName.get('T'), 'type');
    assert.equal(byName.get('I'), 'interface');
  });

  it('marks exported declarations and uses the INNER declaration span (not export keyword)', async () => {
    const draft = await run('export function f(){}');
    assert.equal(draft.definitions.length, 1);
    const d = draft.definitions[0];
    assert.equal(d.exported, true);
    // `export ` is 7 cols; the function_declaration node starts at col 8.
    assert.equal(d.span.start_line, 1);
    assert.equal(d.span.start_col, 8);
  });

  it('emits one definition per declarator, all sharing the enclosing statement span', async () => {
    const draft = await run('const a = 1, b = 2, c = 3;');
    const vars = draft.definitions.filter((d) => d.subtype === 'variable');
    assert.deepEqual(
      vars.map((d) => d.name),
      ['a', 'b', 'c'],
    );
    // Same identity span for every declarator.
    for (const d of vars) {
      assert.equal(d.span.start_col, 1);
      assert.equal(d.span.start_line, 1);
    }
    // Ordinals are strictly ascending in source order.
    assert.deepEqual(
      vars.map((d) => d.ordinal),
      [0, 1, 2],
    );
  });

  it('groups named/default/namespace imports into ONE module per statement with source-side names', async () => {
    const draft = await run(
      "import def from 'm';\nimport * as ns from 'n';\nimport { a, b as c } from 'p';",
    );
    assert.equal(draft.imports.length, 3);
    const bySource = new Map(draft.imports.map((im) => [im.source, [...im.importedNames]]));
    assert.deepEqual(bySource.get('m'), ['default']);
    assert.deepEqual(bySource.get('n'), ['*']);
    // Named: source-side name `b`, NOT the alias `c`.
    assert.deepEqual(bySource.get('p'), ['a', 'b']);
  });

  it('routes `export … from` / `export *` to imports (no phantom symbol) and `export {a}` to exports', async () => {
    const draft = await run("export { x, y } from 'm';\nexport * from 'star';\nconst z = 1;\nexport { z };");
    // Two re-export imports + the local export clause.
    const reexports = draft.imports.filter((im) => im.isReExport);
    assert.equal(reexports.length, 2);
    const star = reexports.find((im) => im.source === 'star');
    assert.deepEqual([...star!.importedNames], ['*']);
    // Local `export { z }` is an export draft, NOT an import; no phantom symbol.
    assert.equal(draft.exports.length, 1);
    assert.equal(draft.exports[0].name, 'z');
  });

  it('interleaves definitions, imports and exports by source ordinal', async () => {
    const draft = await run("import { a } from 'm';\nfunction f(){}\nexport { f };");
    const stream = [
      ...draft.definitions.map((d) => ({ ord: d.ordinal, k: 'def', n: d.name })),
      ...draft.imports.map((im) => ({ ord: im.ordinal, k: 'import', n: im.source })),
      ...draft.exports.map((e) => ({ ord: e.ordinal, k: 'export', n: e.name })),
    ].sort((x, y) => x.ord - y.ord);
    assert.deepEqual(
      stream.map((s) => `${s.k}:${s.n}`),
      ['import:m', 'def:f', 'export:f'],
    );
  });

  it('JS grammar definition subset extracts function/class/variable (no type/interface)', async () => {
    const draft = await run('export function g(start){ return start; }\nclass K{}\nconst p = 1;', 'javascript');
    assert.equal(draft.attributes?.parseStatus, 'parsed');
    const byName = new Map(draft.definitions.map((d) => [d.name, d.subtype]));
    assert.equal(byName.get('g'), 'function');
    assert.equal(byName.get('K'), 'class');
    assert.equal(byName.get('p'), 'variable');
  });

  it('a syntax-error tree returns parse_error best-effort and never throws', async () => {
    const draft = await run('export function ( { const = = = <<< @@@ }');
    assert.equal(draft.attributes?.parseStatus, 'parse_error');
    assert.ok(draft.facts.some((f) => f.code === 'parse_error'));
  });

  it('oversized input is skipped without parsing', async () => {
    const draft = await extractWithQueries({
      providerId: 'js-ts',
      lang: 'typescript',
      source: 'function f(){}',
      sizeBytes: 8 * 1024 * 1024,
      maxParseFileBytes: 1024 * 1024,
      path: 'big.ts',
      grammarForLang: typeScriptProvider.parser.grammarForLang,
      tagsSource: TAGS.sourceForLang('typescript'),
      tagsHash: TAGS.hashForLang('typescript'),
      importsSource: IMPORTS.sourceForLang('typescript'),
      importsHash: IMPORTS.hashForLang('typescript'),
      enclosingStatementNodeTypes: ENCLOSING,
    });
    assert.equal(draft.attributes?.parseStatus, 'skipped_too_large');
    assert.equal(draft.definitions.length, 0);
    assert.ok(draft.facts.some((f) => f.code === 'skipped_too_large'));
  });

  it('compiles each query asset ONCE per (provider,lang,hash) and reuses it across files', async () => {
    // The compiled-query cache is process-wide and keyed by (provider,lang,hash).
    // From an empty cache, the FIRST typescript file compiles tags + imports = 2
    // entries; subsequent typescript files add NOTHING (compile-once reuse).
    __resetQueryCache();
    assert.equal(__queryCacheSize(), 0, 'cache should start empty after reset');

    await run('function a(){}');
    assert.equal(__queryCacheSize(), 2, 'first TS file compiles exactly tags + imports');

    await run('function b(){}');
    await run('function c(){}');
    assert.equal(__queryCacheSize(), 2, 'subsequent TS files reuse the cache (no recompile)');

    // A DIFFERENT lang (javascript uses the JS tags subset → different hash) adds
    // its own distinct entries; the TS entries stay cached.
    await run('function d(){}', 'javascript');
    assert.equal(__queryCacheSize(), 4, 'javascript adds its own tags+imports entries');

    __resetQueryCache();
  });
});
