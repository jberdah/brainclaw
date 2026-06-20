/**
 * Code Map P1c-B — importable-symbol boundary (the soundness core, tested in
 * isolation per the Codex cadrage review BEFORE resolver integration).
 *
 * Covers: the default predicate (exported && not synthetic export), index +
 * unambiguous lookup, and the Python top-level-via-span-containment override
 * (method/nested NOT importable, missing-span skip, same-name ambiguity).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportableIndex, lookupImportable } from '../../../src/core/code-map/importable.js';
import { defaultImportableSymbol } from '../../../src/core/code-map/lang/provider.js';
import { pythonProvider } from '../../../src/core/code-map/lang/python/index.js';
import type { CodeLanguageProvider } from '../../../src/core/code-map/lang/provider.js';
import type { CodeNode, NodeSubtype, Span } from '../../../src/core/code-map/types.js';

function sym(
  id: string,
  name: string,
  opts: { exported?: boolean; subtype?: NodeSubtype | null; span?: Span; kind?: CodeNode['kind']; lang?: string } = {},
): CodeNode {
  return {
    id,
    kind: opts.kind ?? 'symbol',
    subtype: opts.subtype ?? 'function',
    lang: (opts.lang ?? 'typescript') as CodeNode['lang'],
    name,
    path: 'f',
    span: opts.span ?? { start_line: 1, start_col: 0, end_line: 1, end_col: 5 },
    exported: opts.exported ?? false,
    confidence: 1,
    related_memory_ids: [],
    imported_names: [],
  } as CodeNode;
}
const noHookProvider = {} as unknown as CodeLanguageProvider; // → falls back to default

describe('code-map P1c-B defaultImportableSymbol', () => {
  it('exported real symbol is importable', () => {
    assert.equal(defaultImportableSymbol(sym('s1', 'foo', { exported: true })), true);
  });
  it('non-exported symbol is not importable', () => {
    assert.equal(defaultImportableSymbol(sym('s2', 'foo', { exported: false })), false);
  });
  it('synthetic export-clause placeholder (subtype export) is excluded', () => {
    assert.equal(defaultImportableSymbol(sym('s3', 'foo', { exported: true, subtype: 'export' })), false);
  });
  it('non-symbol node is not importable', () => {
    assert.equal(defaultImportableSymbol(sym('m1', 'foo', { exported: true, kind: 'module' })), false);
  });
});

describe('code-map P1c-B buildImportableIndex + lookupImportable (default)', () => {
  it('indexes exported symbols by name; lookup returns the single candidate', () => {
    const nodes = [sym('s1', 'foo', { exported: true }), sym('s2', 'bar', { exported: false })];
    const idx = buildImportableIndex(nodes, noHookProvider);
    assert.equal(lookupImportable(idx, 'foo')?.id, 's1');
    assert.equal(lookupImportable(idx, 'bar'), null, 'non-exported → absent');
    assert.equal(lookupImportable(idx, 'nope'), null, 'missing → null');
  });
  it('same-name ambiguity → null (never guess)', () => {
    const nodes = [
      sym('s1', 'foo', { exported: true, span: { start_line: 1, start_col: 0, end_line: 1, end_col: 5 } }),
      sym('s2', 'foo', { exported: true, span: { start_line: 9, start_col: 0, end_line: 9, end_col: 5 } }),
    ];
    const idx = buildImportableIndex(nodes, noHookProvider);
    assert.equal(lookupImportable(idx, 'foo'), null);
  });
});

describe('code-map P1c-B PythonProvider.isImportableSymbol (top-level via span)', () => {
  // class Foo (lines 1-10) with method bar (2-3); top-level func baz (12-14);
  // func outer (16-22) with nested inner (17-18).
  const cls = sym('c', 'Foo', { lang: 'python', subtype: 'class', span: { start_line: 1, start_col: 0, end_line: 10, end_col: 0 } });
  const method = sym('m', 'bar', { lang: 'python', subtype: 'method', span: { start_line: 2, start_col: 4, end_line: 3, end_col: 0 } });
  const top = sym('t', 'baz', { lang: 'python', subtype: 'function', span: { start_line: 12, start_col: 0, end_line: 14, end_col: 0 } });
  const outer = sym('o', 'outer', { lang: 'python', subtype: 'function', span: { start_line: 16, start_col: 0, end_line: 22, end_col: 0 } });
  const inner = sym('i', 'inner', { lang: 'python', subtype: 'function', span: { start_line: 17, start_col: 4, end_line: 18, end_col: 0 } });
  const noSpan = sym('n', 'orphan', { lang: 'python', subtype: 'function', span: undefined as unknown as Span });
  const all = [cls, method, top, outer, inner];

  it('top-level class and function are importable', () => {
    assert.equal(pythonProvider.isImportableSymbol!(cls, all), true);
    assert.equal(pythonProvider.isImportableSymbol!(top, all), true);
    assert.equal(pythonProvider.isImportableSymbol!(outer, all), true);
  });
  it('class method is NOT importable (contained by the class)', () => {
    assert.equal(pythonProvider.isImportableSymbol!(method, all), false);
  });
  it('nested function is NOT importable (contained by its parent function)', () => {
    assert.equal(pythonProvider.isImportableSymbol!(inner, all), false);
  });
  it('a symbol with no usable span is skipped', () => {
    assert.equal(pythonProvider.isImportableSymbol!(noSpan, [...all, noSpan]), false);
  });
  it('index over a Python file binds only the top-level names', () => {
    const idx = buildImportableIndex(all, pythonProvider);
    assert.equal(lookupImportable(idx, 'Foo')?.id, 'c');
    assert.equal(lookupImportable(idx, 'baz')?.id, 't');
    assert.equal(lookupImportable(idx, 'bar'), null, 'method not bound');
    assert.equal(lookupImportable(idx, 'inner'), null, 'nested not bound');
  });
});
