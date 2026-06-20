/**
 * Code Map P1c — resolves_to INVARIANTS + determinism, through the REAL provider
 * registry (typescript + python) end-to-end via the whole-project pass.
 *
 * Locks the cross-cutting safety net for the first cross-file edge kind:
 *  - every resolves_to `to` is the file-node id of an INDEXED project file
 *  - every `from` is a MODULE node that lives in the emitting shard
 *  - confidence ∈ (0,1]; edge ids are unique; `source.path` = the importer
 *  - determinism: two independent refreshes over identical inputs are byte-equal
 *
 * Unlike the per-provider resolve tests (mock ctx), this drives `defaultRegistry`
 * so a provider wiring/contract regression (wrong lang routing, a resolver that
 * returns an absolute or non-indexed path, a mis-minted id) fails HERE.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectImports } from '../../../src/core/code-map/resolve.js';
import { fileNodeId } from '../../../src/core/code-map/ids.js';
import { defaultRegistry } from '../../../src/core/code-map/lang/providers.js';
import type { CodeEdge, CodeLang, CodeNode, FileShard } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_resolve_invariants';

function moduleNode(id: string, source: string, line: number, importedNames: string[] = []): CodeNode {
  return {
    id, kind: 'module', subtype: null, lang: 'typescript', name: source, path: 'x',
    span: { start_line: line, start_col: 1, end_line: line, end_col: 10 },
    exported: false, confidence: 1, related_memory_ids: [], imported_names: importedNames,
  } as CodeNode;
}
function shard(path: string, lang: CodeLang, nodes: CodeNode[] = []): FileShard {
  return { path, lang, nodes, edges: [] } as unknown as FileShard;
}

/** A small mixed-language project: TS relative import + Python relative import, each
 *  alongside an external (react / os) that must NOT resolve. Fresh every call so two
 *  runs are genuinely independent (the pass mutates shard.edges in place). */
function freshShards(): FileShard[] {
  return [
    shard('src/a.ts', 'typescript', [moduleNode('module:a_b', './b', 1), moduleNode('module:a_ext', 'react', 2)]),
    shard('src/b.ts', 'typescript'),
    shard('pkg/m.py', 'python', [moduleNode('module:m_n', '.n', 1), moduleNode('module:m_ext', 'os', 2)]),
    shard('pkg/n.py', 'python'),
  ];
}

function edgeKey(e: CodeEdge): string {
  return `${e.id}|${e.from}|${e.to}|${e.kind}|${e.confidence}`;
}

describe('code-map P1c resolves_to invariants (real registry)', () => {
  it('emits the two intra-project edges and no edge for externals', async () => {
    const shards = freshShards();
    const res = await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards, persistShard: () => {} });
    const rt = shards.flatMap((s) => s.edges.filter((e) => e.kind === 'resolves_to'));
    assert.equal(res.edgesEmitted, 2, 'exactly ./b and .n resolve');
    assert.equal(rt.length, 2);
    const toA = shards.find((s) => s.path === 'src/a.ts')!.edges.find((e) => e.kind === 'resolves_to')!;
    const toM = shards.find((s) => s.path === 'pkg/m.py')!.edges.find((e) => e.kind === 'resolves_to')!;
    assert.equal(toA.to, fileNodeId(PROJECT, 'src/b.ts', 'typescript'));
    assert.equal(toM.to, fileNodeId(PROJECT, 'pkg/n.py', 'python'));
  });

  it('every resolves_to edge satisfies the structural invariants', async () => {
    const shards = freshShards();
    await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards, persistShard: () => {} });

    const indexedFileNodeIds = new Set(shards.map((s) => fileNodeId(PROJECT, s.path, s.lang)));
    const seenIds = new Set<string>();
    for (const s of shards) {
      const moduleIds = new Set(s.nodes.filter((n) => n.kind === 'module').map((n) => n.id));
      for (const e of s.edges) {
        if (e.kind !== 'resolves_to') continue;
        assert.ok(indexedFileNodeIds.has(e.to), `to must be an indexed file node (${e.to})`);
        assert.ok(moduleIds.has(e.from), `from must be a module node in this shard (${e.from})`);
        assert.ok(e.confidence > 0 && e.confidence <= 1, `confidence ∈ (0,1] (${e.confidence})`);
        assert.equal(e.source?.path, s.path, 'source.path is the importer');
        assert.ok(!seenIds.has(e.id), `edge id is unique (${e.id})`);
        seenIds.add(e.id);
      }
    }
  });

  it('is deterministic across two independent refreshes', async () => {
    const run1 = freshShards();
    const run2 = freshShards();
    await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards: run1, persistShard: () => {} });
    const r2 = await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards: run2, persistShard: () => {} });
    const keys1 = run1.flatMap((s) => s.edges.filter((e) => e.kind === 'resolves_to').map(edgeKey)).sort();
    const keys2 = run2.flatMap((s) => s.edges.filter((e) => e.kind === 'resolves_to').map(edgeKey)).sort();
    assert.deepEqual(keys2, keys1);
    assert.equal(r2.rewroteAny, true, 'a fresh shard set is always written once');
  });

  it('is idempotent — re-running over the same shards rewrites nothing', async () => {
    const shards = freshShards();
    await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards, persistShard: () => {} });
    const again = await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards, persistShard: () => {} });
    assert.equal(again.rewroteAny, false);
  });
});

function symbolNode(id: string, name: string, exported: boolean): CodeNode {
  return {
    id, kind: 'symbol', subtype: 'function', lang: 'typescript', name, path: 'src/b.ts',
    span: { start_line: 1, start_col: 1, end_line: 3, end_col: 1 },
    exported, confidence: 1, related_memory_ids: [], imported_names: [],
  } as CodeNode;
}
/** a.ts imports {foo,bar} from ./b; b.ts exports foo only. Real TS registry binds foo. */
function freshSymbolShards(): FileShard[] {
  return [
    shard('src/a.ts', 'typescript', [moduleNode('module:ab', './b', 1, ['foo', 'bar'])]),
    shard('src/b.ts', 'typescript', [symbolNode('sym:foo', 'foo', true), symbolNode('sym:bar', 'bar', false)]),
  ];
}

describe('code-map P1c-B imports_symbol invariants (real registry)', () => {
  it('binds the exported name only, satisfying the structural invariants', async () => {
    const shards = freshSymbolShards();
    const res = await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards, persistShard: () => {} });
    const symbolIds = new Set(shards.flatMap((s) => s.nodes.filter((n) => n.kind === 'symbol').map((n) => n.id)));
    const moduleIds = new Set(shards.flatMap((s) => s.nodes.filter((n) => n.kind === 'module').map((n) => n.id)));
    const b = shards.flatMap((s) => s.edges.filter((e) => e.kind === 'imports_symbol'));
    assert.equal(res.symbolEdgesEmitted, 1, 'only the exported foo binds (bar is not exported)');
    assert.equal(b.length, 1);
    assert.equal(b[0]!.to, 'sym:foo');
    assert.ok(moduleIds.has(b[0]!.from), 'from is a module node');
    assert.ok(symbolIds.has(b[0]!.to), 'to is a symbol node in an indexed file');
    assert.ok(b[0]!.confidence > 0 && b[0]!.confidence <= 1, 'confidence ∈ (0,1]');
    // A still present and unperturbed.
    assert.equal(shards.find((s) => s.path === 'src/a.ts')!.edges.filter((e) => e.kind === 'resolves_to').length, 1);
  });

  it('is deterministic across two independent refreshes (incl. imports_symbol)', async () => {
    const run1 = freshSymbolShards();
    const run2 = freshSymbolShards();
    await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards: run1, persistShard: () => {} });
    await resolveProjectImports({ projectId: PROJECT, registry: defaultRegistry, shards: run2, persistShard: () => {} });
    const k1 = run1.flatMap((s) => s.edges.filter((e) => e.kind === 'imports_symbol').map(edgeKey)).sort();
    const k2 = run2.flatMap((s) => s.edges.filter((e) => e.kind === 'imports_symbol').map(edgeKey)).sort();
    assert.deepEqual(k2, k1);
    assert.equal(k1.length, 1);
  });
});
