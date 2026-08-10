/** Contract tests for the bounded Code Map graph export. */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSubgraph } from '../../../src/core/code-map/export.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { runCodeMap } from '../../../src/commands/code-map.js';
import { executeMcpToolCall } from '../../../src/commands/mcp.js';
import { isolateAgentEnv } from '../../helpers/workspace.js';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { listShards, writeShard } from '../../../src/core/code-map/store.js';

const PROJECT = 'prj_export_test';
const cleanupDirs: string[] = [];

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-export-'));
  cleanupDirs.push(root);
  return root;
}

function writeSrc(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

async function fixture(root: string): Promise<void> {
  writeSrc(root, 'src/a.ts', 'export function alpha() { return 1; }\nexport function beta() { return alpha(); }\n');
  writeSrc(root, 'src/b.ts', "import { alpha } from './a';\nexport const consume = alpha;\n");
  await refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });
}

afterEach(() => {
  while (cleanupDirs.length > 0) fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
});

describe('code-map bounded export', () => {
  it('returns a deterministic compact JSON neighborhood with factual relationship metadata', async () => {
    const root = tmpProject();
    await fixture(root);

    const first = exportSubgraph('alpha', { direction: 'both', depth: 1 }, { cwd: root });
    const second = exportSubgraph('alpha', { direction: 'both', depth: 1 }, { cwd: root });

    assert.deepEqual(second, first, 'same persisted graph and selector produce byte-stable data');
    assert.equal(first.format, 'json');
    assert.equal(first.limits.max_depth, 1, 'a local neighborhood is the default, never a graph dump');
    assert.ok(first.nodes.length <= first.limits.max_nodes);
    assert.ok(first.edges.length <= first.limits.max_edges);
    assert.ok(first.root_node_ids.length > 0);
    assert.ok(first.edges.some((edge) => edge.kind === 'imports_symbol'), 'incoming resolved relation selected');
    for (const edge of first.edges) {
      assert.equal(typeof edge.kind, 'string');
      assert.equal(typeof edge.confidence, 'number');
      assert.ok(Object.hasOwn(edge, 'source'), 'source is explicit even for legacy source-less edges');
    }
  });

  it('honours edge direction and strict depth/node/edge caps', async () => {
    const root = tmpProject();
    await fixture(root);

    const outgoingSymbol = exportSubgraph('alpha', { targetKind: 'symbol', direction: 'outgoing', depth: 1 }, { cwd: root });
    assert.deepEqual(outgoingSymbol.edges, [], 'symbol has only persisted incoming relations in this fixture');

    const edgeCapped = exportSubgraph('src/a.ts', {
      targetKind: 'file', direction: 'outgoing', depth: 1, maxEdges: 1,
    }, { cwd: root });
    assert.equal(edgeCapped.edges.length, 1);
    assert.equal(edgeCapped.truncated.edges, true);

    const nodeCapped = exportSubgraph('src/a.ts', {
      targetKind: 'file', direction: 'outgoing', depth: 1, maxNodes: 1,
    }, { cwd: root });
    assert.equal(nodeCapped.nodes.length, 1);
    assert.equal(nodeCapped.edges.length, 0);
    assert.equal(nodeCapped.truncated.nodes, true);
  });

  it('excludes low-confidence relationships even when a caller requests a lower threshold', async () => {
    const root = tmpProject();
    await fixture(root);
    const shard = listShards(root).find((candidate) => candidate.path === 'src/b.ts');
    assert.ok(shard, 'importer shard exists');
    writeShard({
      ...shard!,
      edges: shard!.edges.map((edge) => edge.kind === 'imports_symbol' ? { ...edge, confidence: 0.25 } : edge),
    }, root);

    const result = exportSubgraph('alpha', { direction: 'incoming', minConfidence: 0 }, { cwd: root });
    assert.equal(result.limits.min_confidence, 0.5);
    assert.ok(result.edges.every((edge) => edge.confidence >= 0.5));
    assert.ok(result.edges.every((edge) => edge.kind !== 'imports_symbol'), 'low-confidence edge cannot pose as a fact');
  });

  it('adds Mermaid only as a projection of the exact selected JSON graph', async () => {
    const root = tmpProject();
    await fixture(root);
    const json = exportSubgraph('alpha', { direction: 'both', depth: 1 }, { cwd: root });
    const mermaid = exportSubgraph('alpha', { direction: 'both', depth: 1, format: 'mermaid' }, { cwd: root });

    assert.equal(mermaid.format, 'mermaid');
    assert.deepEqual(mermaid.nodes, json.nodes);
    assert.deepEqual(mermaid.edges, json.edges);
    assert.match(mermaid.mermaid ?? '', /^flowchart TD/m);
    assert.match(mermaid.mermaid ?? '', /imports_symbol/);
  });

  it('exposes the same bounded model through the async backend facade', async () => {
    const root = tmpProject();
    await fixture(root);
    const result = await new JsonlBackend().exportGraph({
      target: 'alpha', direction: 'both', depth: 99, maxNodes: 999, maxEdges: 999, format: 'mermaid', cwd: root,
    });
    assert.equal(result.limits.max_depth, 4);
    assert.equal(result.limits.max_nodes, 100);
    assert.equal(result.limits.max_edges, 200);
    assert.equal(result.format, 'mermaid');
    assert.ok(result.mermaid);
    assert.equal(result.freshness_badge.status, 'fresh');
  });
  it('exposes the same bounded graph through CLI JSON and the MCP read tool', async () => {
    const env = isolateAgentEnv();
    const root = tmpProject();
    await fixture(root);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      await runCodeMap('export', ['alpha'], {
        cwd: root, json: true, direction: 'incoming', maxNodes: 2, maxEdges: 2, format: 'mermaid',
      });
    } finally {
      console.log = originalLog;
    }
    const cli = JSON.parse(lines.join('\n')) as { format: string; nodes: unknown[]; edges: unknown[]; mermaid?: string };
    assert.equal(cli.format, 'mermaid');
    assert.ok(cli.nodes.length <= 2 && cli.edges.length <= 2);
    assert.ok(cli.mermaid);

    try {
      const call = await executeMcpToolCall({
        name: 'bclaw_code_export',
        args: { target: 'alpha', direction: 'incoming', maxNodes: 2, maxEdges: 2, format: 'mermaid' },
        cwd: root,
      });
      assert.equal(call.response.isError, false);
      const structured = call.response.structuredContent as { format: string; mermaid?: string; nodes: unknown[]; edges: unknown[] };
      assert.equal(structured.format, 'mermaid');
      assert.ok(structured.nodes.length <= 2 && structured.edges.length <= 2);
      assert.ok(structured.mermaid);
    } finally {
      env.restore();
    }
  });
  it('reports a missing index rather than manufacturing a graph', () => {
    const result = exportSubgraph('alpha', undefined, { cwd: tmpProject() });
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
    assert.equal(result.freshness_badge.status, 'missing_index');
  });
});