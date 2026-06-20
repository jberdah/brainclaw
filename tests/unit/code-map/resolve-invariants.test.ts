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
