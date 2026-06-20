/**
 * Code Map P1c-B — symbol-level resolution through resolveProjectImports.
 *
 * Drives the pass with synthetic shards + a mock resolver (default importability:
 * exported && not synthetic-export). Locks: emits module --imports_symbol--> the right
 * def node; default/'*' skipped; ambiguity/absent → no edge; non-exported target → no
 * edge; B confidence inherits A's; A resolves_to unchanged (additive); dedup; stale B
 * strip; idempotency.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectImports } from '../../../src/core/code-map/resolve.js';
import { edgeId } from '../../../src/core/code-map/ids.js';
import type { CodeEdge, CodeLang, CodeNode, FileShard } from '../../../src/core/code-map/types.js';
import type {
  CodeLanguageRegistry,
  ImportResolution,
  ImportResolutionRequest,
  ResolveImportContext,
} from '../../../src/core/code-map/lang/provider.js';

const PROJECT = 'prj_resolve_symbol_test';

function moduleNode(id: string, source: string, importedNames: string[]): CodeNode {
  return {
    id, kind: 'module', subtype: null, lang: 'typescript', name: source, path: 'a.ts',
    span: { start_line: 1, start_col: 1, end_line: 1, end_col: 10 },
    exported: false, confidence: 1, related_memory_ids: [], imported_names: importedNames,
  } as CodeNode;
}
function symbolNode(id: string, name: string, exported: boolean, subtype = 'function'): CodeNode {
  return {
    id, kind: 'symbol', subtype, lang: 'typescript', name, path: 'b.ts',
    span: { start_line: 2, start_col: 1, end_line: 4, end_col: 1 },
    exported, confidence: 1, related_memory_ids: [], imported_names: [],
  } as CodeNode;
}
function fileShard(path: string, lang: CodeLang, nodes: CodeNode[] = [], edges: CodeEdge[] = []): FileShard {
  return { path, lang, nodes, edges } as unknown as FileShard;
}
type Resolver = (req: ImportResolutionRequest, ctx: ResolveImportContext) => Promise<readonly ImportResolution[]>;
function registryWith(resolver: Resolver, confidence = 1): CodeLanguageRegistry {
  // No isImportableSymbol → default predicate (exported && not synthetic export).
  const provider = { resolveImport: resolver };
  return { providerForLang: () => provider } as unknown as CodeLanguageRegistry;
}
// './b' → b.ts at the given confidence.
const resolveToB = (confidence = 1): Resolver => async (req) =>
  req.source === './b' ? [{ source: req.source, resolvedPath: 'b.ts', confidence }] : [];

function symEdges(s: FileShard): CodeEdge[] {
  return s.edges.filter((e) => e.kind === 'imports_symbol');
}

describe('code-map P1c-B resolveProjectImports symbol binding', () => {
  it('binds a named import to the exported def, alongside the file-level A edge', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true)]);
    const res = await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    const se = symEdges(a);
    assert.equal(se.length, 1);
    assert.equal(se[0]!.from, 'module:m1');
    assert.equal(se[0]!.to, 'sym:foo');
    assert.equal(se[0]!.id, edgeId({ projectId: PROJECT, from: 'module:m1', to: 'sym:foo', kind: 'imports_symbol' }));
    assert.equal(a.edges.filter((e) => e.kind === 'resolves_to').length, 1, 'A file edge still present');
    assert.equal(res.symbolEdgesEmitted, 1);
  });

  it('source-side alias name matches (import {foo as baz} → imported_names has foo)', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])]); // baz is local-only, not stored
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true)]);
    await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    assert.equal(symEdges(a)[0]?.to, 'sym:foo');
  });

  it('skips default and namespace imports (no single named symbol)', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['default', '*'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true)]);
    const res = await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    assert.equal(symEdges(a).length, 0);
    assert.equal(res.symbolEdgesEmitted, 0);
  });

  it('no edge when the imported name is not exported in the target', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', false)]); // not exported
    await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    assert.equal(symEdges(a).length, 0);
  });

  it('no edge when the name is ambiguous (two exported symbols same name)', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo1', 'foo', true), symbolNode('sym:foo2', 'foo', true)]);
    await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    assert.equal(symEdges(a).length, 0);
  });

  it('no edge when the imported name is absent from the target', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['missing'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true)]);
    await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    assert.equal(symEdges(a).length, 0);
  });

  it('B confidence inherits the A file-resolution confidence (never higher)', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true)]);
    await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB(0.7)), shards: [a, b], persistShard: () => {} });
    assert.equal(symEdges(a)[0]?.confidence, 0.7);
  });

  it('dedups duplicate imported names', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo', 'foo'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true)]);
    const res = await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    assert.equal(symEdges(a).length, 1);
    assert.equal(res.symbolEdgesEmitted, 1);
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true)]);
    const writes: string[] = [];
    await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: (s) => writes.push(s.path) });
    const r2 = await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: (s) => writes.push(s.path) });
    assert.equal(r2.rewroteAny, false);
    assert.deepEqual(writes, ['a.ts']);
  });

  it('strips a stale imports_symbol when the name no longer binds', async () => {
    const stale = {
      id: 'oldB', from: 'module:m1', to: 'sym:gone', kind: 'imports_symbol',
      confidence: 1, source: { path: 'a.ts', line: 1 },
    } as CodeEdge;
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])], [stale]);
    const b = fileShard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo', false)]); // foo no longer exported
    const res = await resolveProjectImports({ projectId: PROJECT, registry: registryWith(resolveToB()), shards: [a, b], persistShard: () => {} });
    assert.equal(res.rewroteAny, true);
    assert.equal(symEdges(a).length, 0, 'stale B edge stripped, none re-added');
  });
});
