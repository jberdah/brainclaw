/**
 * Code Map P1c — resolveProjectImports (whole-project import resolution) unit tests.
 *
 * Drives the pass with synthetic shards + a mock provider/registry (via the
 * persistShard seam, no disk). Locks: no-op without a resolver (additive gate),
 * module --resolves_to--> target file emission + core id minting, idempotency,
 * no edge for unresolved/non-indexed targets, and stale-edge stripping.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectImports } from '../../../src/core/code-map/resolve.js';
import { edgeId, fileNodeId } from '../../../src/core/code-map/ids.js';
import type { CodeEdge, CodeLang, CodeNode, FileShard } from '../../../src/core/code-map/types.js';
import type {
  CodeLanguageRegistry,
  ImportResolution,
  ImportResolutionRequest,
  ResolveImportContext,
} from '../../../src/core/code-map/lang/provider.js';

const PROJECT = 'prj_resolve_test';

function moduleNode(id: string, source: string, line = 1): CodeNode {
  return {
    id,
    kind: 'module',
    subtype: null,
    lang: 'typescript',
    name: source,
    path: 'x',
    span: { start_line: line, start_col: 1, end_line: line, end_col: 10 },
    exported: false,
    confidence: 1,
    related_memory_ids: [],
    imported_names: [],
  } as CodeNode;
}

function importsEdge(): CodeEdge {
  return { id: 'e1', from: 'file:a', to: 'module:m1', kind: 'imports', confidence: 1, source: { path: 'a.ts', line: 1 } } as CodeEdge;
}

function fileShard(path: string, lang: CodeLang, nodes: CodeNode[] = [], edges: CodeEdge[] = []): FileShard {
  return { path, lang, nodes, edges } as unknown as FileShard;
}

type Resolver = (req: ImportResolutionRequest, ctx: ResolveImportContext) => Promise<readonly ImportResolution[]>;
function registryWith(resolver?: Resolver): CodeLanguageRegistry {
  const provider = resolver ? { resolveImport: resolver } : {};
  return { providerForLang: () => provider } as unknown as CodeLanguageRegistry;
}

describe('code-map P1c resolveProjectImports', () => {
  it('no-op when the provider has no resolveImport (additive gate)', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b')], [importsEdge()]);
    const writes: string[] = [];
    const res = await resolveProjectImports({
      projectId: PROJECT, registry: registryWith(), shards: [a], persistShard: (s) => writes.push(s.path),
    });
    assert.equal(res.rewroteAny, false);
    assert.equal(writes.length, 0);
    assert.equal(a.edges.length, 1, 'edges untouched');
  });

  it('emits module --resolves_to--> target file with a core-minted id', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b')], [importsEdge()]);
    const b = fileShard('b.ts', 'typescript');
    const reg = registryWith(async (req) => (req.source === './b' ? [{ source: req.source, resolvedPath: 'b.ts', confidence: 1 }] : []));
    const writes: string[] = [];
    const res = await resolveProjectImports({ projectId: PROJECT, registry: reg, shards: [a, b], persistShard: (s) => writes.push(s.path) });
    assert.equal(res.rewroteAny, true);
    assert.deepEqual(writes, ['a.ts'], 'only the importer shard is rewritten');
    const rt = a.edges.filter((e) => e.kind === 'resolves_to');
    assert.equal(rt.length, 1);
    const to = fileNodeId(PROJECT, 'b.ts', 'typescript');
    assert.equal(rt[0]!.from, 'module:m1');
    assert.equal(rt[0]!.to, to);
    assert.equal(rt[0]!.id, edgeId({ projectId: PROJECT, from: 'module:m1', to, kind: 'resolves_to' }));
    assert.equal(a.edges[0]!.kind, 'imports', 'non-resolves_to edges kept first/byte-identical');
  });

  it('passes importedNames + a pure ctx to the resolver (B-additive contract)', async () => {
    const mod = moduleNode('module:m1', './b');
    (mod as { imported_names: string[] }).imported_names = ['foo', 'default'];
    const a = fileShard('a.ts', 'typescript', [mod], []);
    const b = fileShard('b.ts', 'typescript');
    let sawNames: readonly string[] = [];
    let ctxFileExists = false;
    const reg = registryWith(async (req, ctx) => {
      sawNames = req.importedNames;
      ctxFileExists = ctx.fileExists('b.ts') && !ctx.fileExists('nope.ts');
      return ctx.fileExists('b.ts') ? [{ source: req.source, resolvedPath: 'b.ts', confidence: 0.9 }] : [];
    });
    await resolveProjectImports({ projectId: PROJECT, registry: reg, shards: [a, b], persistShard: () => {} });
    assert.deepEqual(sawNames, ['foo', 'default']);
    assert.ok(ctxFileExists, 'ctx.fileExists reflects the indexed file-set');
    assert.equal(a.edges.find((e) => e.kind === 'resolves_to')?.confidence, 0.9);
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b')], [importsEdge()]);
    const b = fileShard('b.ts', 'typescript');
    const reg = registryWith(async (req) => [{ source: req.source, resolvedPath: 'b.ts', confidence: 1 }]);
    const writes: string[] = [];
    await resolveProjectImports({ projectId: PROJECT, registry: reg, shards: [a, b], persistShard: (s) => writes.push(s.path) });
    const r2 = await resolveProjectImports({ projectId: PROJECT, registry: reg, shards: [a, b], persistShard: (s) => writes.push(s.path) });
    assert.equal(r2.rewroteAny, false);
    assert.deepEqual(writes, ['a.ts'], 'only the first run persisted');
  });

  it('no edge for an unresolved (null path) or a non-indexed target', async () => {
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:ext', 'react'), moduleNode('module:gone', './missing')], []);
    const reg = registryWith(async (req) =>
      req.source === 'react'
        ? [{ source: req.source, resolvedPath: null, confidence: 0 }]
        : [{ source: req.source, resolvedPath: 'missing.ts', confidence: 1 }], // not in the file-set
    );
    const res = await resolveProjectImports({ projectId: PROJECT, registry: reg, shards: [a], persistShard: () => {} });
    assert.equal(a.edges.filter((e) => e.kind === 'resolves_to').length, 0);
    assert.equal(res.edgesEmitted, 0);
  });

  it('strips a stale resolves_to when the import no longer resolves', async () => {
    const stale = {
      id: 'old', from: 'module:m1', to: fileNodeId(PROJECT, 'b.ts', 'typescript'),
      kind: 'resolves_to', confidence: 1, source: { path: 'a.ts', line: 1 },
    } as CodeEdge;
    const a = fileShard('a.ts', 'typescript', [moduleNode('module:m1', './b')], [importsEdge(), stale]);
    const reg = registryWith(async () => []); // resolves nothing now (target gone)
    const res = await resolveProjectImports({ projectId: PROJECT, registry: reg, shards: [a], persistShard: () => {} });
    assert.equal(res.rewroteAny, true);
    assert.equal(a.edges.filter((e) => e.kind === 'resolves_to').length, 0);
    assert.equal(a.edges.length, 1, 'only the imports edge remains');
  });
});
