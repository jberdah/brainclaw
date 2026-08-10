/**
 * Code Map index builders (spec §5.6, §5.7).
 *
 * Both indexes are derived purely from `files/**` shards and written atomically
 * (store.ts uses writeFileAtomic). Queries answer from these + shards alone;
 * materialized JSONL is never required.
 *
 * Ordering is deterministic so two refreshes over identical inputs produce
 * byte-identical indexes (concurrency rule 5 spirit; helps "no JSONL committed"
 * diffs stay clean).
 */
import {
  CODE_MAP_SCHEMA_VERSION,
  type DependencyIndexEntry,
  type FileShard,
  type ImportIndexEntry,
  type ImportsIndex,
  type ResolutionIndex,
  type SymbolIndexEntry,
  type SymbolsIndex,
} from './types.js';
import { fileNodeId } from './ids.js';

/** Lowercase token normalization (spec §5.6 keys). */
function tokenize(name: string): string[] {
  const lower = name.toLowerCase();
  const tokens = new Set<string>();
  tokens.add(lower);
  // split camelCase / snake / kebab boundaries into sub-tokens for partial recall
  for (const part of name.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    // camelCase split
    for (const sub of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
      if (sub) tokens.add(sub.toLowerCase());
    }
  }
  return [...tokens];
}

export function buildSymbolsIndex(
  projectId: string,
  shards: FileShard[],
  extractorVersion: string,
): SymbolsIndex {
  // Null-proto map: symbol-name tokens can collide with Object.prototype members
  // (e.g. a method named `constructor`, or a `__proto__` key), which would make
  // `entries[token] ??= []` see the inherited function and crash on .push, or make
  // `entries['__proto__'] = …` mutate the prototype instead of adding a key.
  const entries: Record<string, SymbolIndexEntry[]> = Object.create(null);
  // Deterministic shard order by path.
  const ordered = [...shards].sort((a, b) => a.path.localeCompare(b.path));
  for (const shard of ordered) {
    for (const node of shard.nodes) {
      if (node.kind !== 'symbol') continue;
      const entry: SymbolIndexEntry = {
        node_id: node.id,
        name: node.name,
        kind: node.kind,
        subtype: node.subtype ?? null,
        path: node.path,
        file_id: shard.file_id,
        score_hint: node.exported ? 1.0 : 0.8,
      };
      for (const token of tokenize(node.name)) {
        (entries[token] ??= []).push(entry);
      }
    }
  }
  // Deterministic ordering within each token bucket.
  for (const token of Object.keys(entries)) {
    entries[token]!.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.name.localeCompare(b.name) ||
        a.node_id.localeCompare(b.node_id),
    );
  }
  // Sort keys for byte-stable output.
  const sortedEntries: Record<string, SymbolIndexEntry[]> = Object.create(null);
  for (const key of Object.keys(entries).sort()) sortedEntries[key] = entries[key]!;

  return {
    schema_version: CODE_MAP_SCHEMA_VERSION,
    project_id: projectId,
    updated_at: new Date().toISOString(),
    extractor_version: extractorVersion,
    entries: sortedEntries,
  };
}

export function buildImportsIndex(projectId: string, shards: FileShard[]): ImportsIndex {
  // module specifier -> (path -> entry)
  const byModule = new Map<string, Map<string, ImportIndexEntry>>();
  const ordered = [...shards].sort((a, b) => a.path.localeCompare(b.path));
  for (const shard of ordered) {
    for (const node of shard.nodes) {
      if (node.kind !== 'module') continue;
      const module = node.name;
      const perPath = byModule.get(module) ?? new Map<string, ImportIndexEntry>();
      const entry = perPath.get(shard.path) ?? {
        path: shard.path,
        file_id: shard.file_id,
        imported: [] as string[],
      };
      // Merge imported bindings across multiple imports of the same module in one
      // file, deduped + sorted for byte-stable output (spec §5.7 imported[]).
      const merged = new Set(entry.imported);
      for (const name of node.imported_names ?? []) merged.add(name);
      entry.imported = [...merged].sort();
      perPath.set(shard.path, entry);
      byModule.set(module, perPath);
    }
  }
  const entries: Record<string, ImportIndexEntry[]> = Object.create(null);
  for (const key of [...byModule.keys()].sort()) {
    const list = [...byModule.get(key)!.values()].sort((a, b) => a.path.localeCompare(b.path));
    entries[key] = list;
  }
  return {
    schema_version: CODE_MAP_SCHEMA_VERSION,
    project_id: projectId,
    updated_at: new Date().toISOString(),
    entries,
  };
}

/**
 * P1d reverse-dependency index: "who imports this target". Derived from the P1c
 * resolution edges that live on each IMPORTER's shard:
 *  - `resolves_to` (module → target FILE node) → `dependents_by_file[targetPath]`
 *  - `imports_symbol` (module → target SYMBOL node) → `dependents_by_symbol[nodeId]`
 *
 * `resolves_to.to` is a file NODE ID (not a path), so we invert fileNodeId→path by
 * computing the id for every indexed shard (Codex review). One entry per (target,
 * importer file): multiple module nodes in one importer that hit the same target are
 * merged (imported names unioned, strongest confidence, lexicographically-smallest
 * specifier) for byte-stable output. Deterministic key + array ordering.
 */
export function buildResolutionIndex(projectId: string, shards: FileShard[]): ResolutionIndex {
  // Invert file-node id → path so reverse resolves_to can be keyed by target path.
  const fileNodeIdToPath = new Map<string, string>();
  for (const shard of shards) {
    fileNodeIdToPath.set(fileNodeId(projectId, shard.path, shard.lang), shard.path);
  }

  // target key -> (importer path -> merged entry)
  const byFile = new Map<string, Map<string, DependencyIndexEntry>>();
  const bySymbol = new Map<string, Map<string, DependencyIndexEntry>>();

  const addDependent = (
    bucket: Map<string, Map<string, DependencyIndexEntry>>,
    targetKey: string,
    importerPath: string,
    importerFileId: string,
    module: string | undefined,
    imported: readonly string[],
    confidence: number | undefined,
    kind: 'resolves_to' | 'imports_symbol',
    sourceLine: number | null | undefined,
  ): void => {
    const perImporter = bucket.get(targetKey) ?? new Map<string, DependencyIndexEntry>();
    const prev = perImporter.get(importerPath);
    if (!prev) {
      perImporter.set(importerPath, {
        path: importerPath,
        file_id: importerFileId,
        module,
        imported: [...new Set(imported)].sort(),
        confidence,
        reasons: [],
      });
    } else {
      // Merge a second edge from the same importer to the same target.
      const mergedNames = new Set(prev.imported);
      for (const n of imported) mergedNames.add(n);
      prev.imported = [...mergedNames].sort();
      if (module && (!prev.module || module < prev.module)) prev.module = module; // smallest spec, stable
      if (typeof confidence === 'number') {
        prev.confidence = typeof prev.confidence === 'number' ? Math.max(prev.confidence, confidence) : confidence;
      }
    }
    const current = perImporter.get(importerPath)!;
    const reason = {
      kind,
      ...(module ? { module } : {}),
      imported: [...new Set(imported)].sort(),
      ...(typeof confidence === 'number' ? { confidence } : {}),
      ...(sourceLine !== undefined ? { source_line: sourceLine } : {}),
    };
    // Multiple module nodes can resolve to one target from one importer. Keep
    // every concrete cause, deduping an identical extractor edge defensively.
    if (!current.reasons.some((existing) =>
      existing.kind === reason.kind
      && existing.module === reason.module
      && existing.confidence === reason.confidence
      && existing.source_line === reason.source_line
      && existing.imported.length === reason.imported.length
      && existing.imported.every((name, index) => name === reason.imported[index]),
    )) {
      current.reasons.push(reason);
      current.reasons.sort((a, b) =>
        a.kind.localeCompare(b.kind)
        || (a.module ?? '').localeCompare(b.module ?? '')
        || (a.source_line ?? -1) - (b.source_line ?? -1)
        || a.imported.join('\0').localeCompare(b.imported.join('\0'))
        || (a.confidence ?? -1) - (b.confidence ?? -1),
      );
    }
    bucket.set(targetKey, perImporter);
  };

  const ordered = [...shards].sort((a, b) => a.path.localeCompare(b.path));
  for (const shard of ordered) {
    // module node id -> its specifier + imported names (for reason metadata).
    const moduleById = new Map<string, { name: string; imported: readonly string[] }>();
    for (const n of shard.nodes) {
      if (n.kind === 'module') moduleById.set(n.id, { name: n.name, imported: n.imported_names ?? [] });
    }
    for (const e of shard.edges) {
      if (e.kind !== 'resolves_to' && e.kind !== 'imports_symbol') continue;
      const mod = moduleById.get(e.from);
      if (e.kind === 'resolves_to') {
        const targetPath = fileNodeIdToPath.get(e.to);
        if (!targetPath) continue; // target id not an indexed file (defensive)
        addDependent(
          byFile, targetPath, shard.path, shard.file_id, mod?.name, mod?.imported ?? [], e.confidence,
          'resolves_to', e.source?.line,
        );
      } else {
        addDependent(
          bySymbol, e.to, shard.path, shard.file_id, mod?.name, mod?.imported ?? [], e.confidence,
          'imports_symbol', e.source?.line,
        );
      }
    }
  }

  const finalize = (
    bucket: Map<string, Map<string, DependencyIndexEntry>>,
  ): Record<string, DependencyIndexEntry[]> => {
    const out: Record<string, DependencyIndexEntry[]> = Object.create(null);
    for (const key of [...bucket.keys()].sort()) {
      out[key] = [...bucket.get(key)!.values()].sort((a, b) => a.path.localeCompare(b.path));
    }
    return out;
  };

  return {
    schema_version: CODE_MAP_SCHEMA_VERSION,
    project_id: projectId,
    updated_at: new Date().toISOString(),
    dependents_by_file: finalize(byFile),
    dependents_by_symbol: finalize(bySymbol),
  };
}
