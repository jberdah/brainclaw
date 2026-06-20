/**
 * Materialized JSONL cache (spec §4, §6 rule 5).
 *
 * nodes.v1.jsonl + edges.v1.jsonl are REBUILDABLE outputs with deterministic
 * ordering. They exist for inspection / export / bulk scans only — queries must
 * never depend on them. They are ignored by project generated-ignore rules by
 * default, so they should not be committed.
 */
import fs from 'node:fs';
import { writeFileAtomic } from '../io.js';
import { materializedDir, materializedNodesPath, materializedEdgesPath } from './paths.js';
import type { CodeEdge, CodeNode, FileShard } from './types.js';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Deterministic node ordering: by path, then id. */
function orderedNodes(shards: FileShard[]): CodeNode[] {
  const ordered = [...shards].sort((a, b) => a.path.localeCompare(b.path));
  const out: CodeNode[] = [];
  for (const shard of ordered) {
    const nodes = [...shard.nodes].sort((a, b) => a.id.localeCompare(b.id));
    out.push(...nodes);
  }
  return out;
}

/** Deterministic edge ordering: by from, to, kind, id. */
function orderedEdges(shards: FileShard[]): CodeEdge[] {
  const ordered = [...shards].sort((a, b) => a.path.localeCompare(b.path));
  const out: CodeEdge[] = [];
  for (const shard of ordered) {
    const edges = [...shard.edges].sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );
    out.push(...edges);
  }
  return out;
}

function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * Rebuild both materialized JSONL files from shards, atomically. Safe to call
 * after every refresh; cheap relative to parsing.
 */
export function rebuildMaterialized(shards: FileShard[], cwd?: string, preferredDirName?: string): void {
  ensureDir(materializedDir(cwd, preferredDirName));
  writeFileAtomic(materializedNodesPath(cwd, preferredDirName), toJsonl(orderedNodes(shards)));
  writeFileAtomic(materializedEdgesPath(cwd, preferredDirName), toJsonl(orderedEdges(shards)));
}
