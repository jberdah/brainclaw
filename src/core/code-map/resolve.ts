/**
 * Code Map P1c — whole-project import RESOLUTION pass (cadrage v2; Codex R1).
 *
 * The FIRST cross-file pass in Code Map. P0..langs are strictly per-file: the
 * finalizer turns one file's draft into nodes/edges with no knowledge of sibling
 * files. Resolution is inherently cross-file (`./utils` in `src/a.ts` →
 * `src/utils.ts`), so it runs as a core pass over the whole shard set AFTER
 * extraction + compaction + freshness reclassification, but BEFORE the index /
 * materialized / stats writes (so everything downstream sees the same edge set).
 *
 * For each `module` node (an import) it asks the owning provider's `resolveImport`
 * to map the specifier → a project-internal target FILE path, then emits
 * `module --resolves_to--> <target file node>` (A, file-level). The PROVIDER returns
 * paths only; the CORE mints the edge + target file-node id (dec#108/#109 boundary).
 *
 * P1c-B (symbol-level, additive): for that SAME-RUN resolved target file, each NAMED
 * imported symbol (`mod.imported_names`, excluding `'default'`/`'*'`) is bound to its
 * definition via `module --imports_symbol--> <def symbol node>` — but only when the
 * target file has exactly ONE importable symbol of that name (ambiguous/absent → no
 * edge). "Importable" is the TARGET provider's `isImportableSymbol` (TS: exported &&
 * not a synthetic export; Python: top-level). B's confidence INHERITS the A
 * file-resolution confidence (never higher than the resolution it rides on).
 *
 * Idempotency (Codex R1 #4): edge ids are deterministic by (project, from, to,
 * kind) only, so each shard is rewritten by KEEPING every non-pass-owned node/edge
 * byte-identical (same order), FILTERING old pass-owned edges (BOTH `resolves_to`
 * AND `imports_symbol` — else a renamed/deleted symbol leaves a stale B edge), then
 * appending the freshly computed A+B edges in a single deterministic order. A shard
 * is only written when its edge array actually changed — so a project with no
 * resolver is a pure no-op, and re-runs are byte-identical.
 *
 * Recompute-all (Codex R1): the pass resolves over ALL shards every refresh (even
 * `--changed`) and rewrites only the shards whose pass-owned set changed. That
 * removes the moved/deleted-target stale-edge problem without a reverse-dependency
 * scheduler — the pass already holds the full current file set.
 */
import { edgeId, fileNodeId } from './ids.js';
import { writeShard } from './store.js';
import { buildImportableIndex, lookupImportable } from './importable.js';
import type { CodeEdge, CodeLang, CodeNode, FileShard } from './types.js';
import { EdgeSchema } from './types.js';
import type { CodeLanguageRegistry, ResolveImportContext } from './lang/provider.js';

/** Edge kinds this pass OWNS — stale-stripped + recomputed every run (A + B). */
const PASS_OWNED_EDGE_KINDS = new Set<string>(['resolves_to', 'imports_symbol']);

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function clampConfidence(c: number | undefined): number {
  if (typeof c !== 'number' || !Number.isFinite(c)) return 1.0;
  return Math.max(0, Math.min(1, c));
}

/** Order-and-content equality for an edge array (decides whether a shard rewrite is needed). */
function edgesArrayEqual(a: readonly CodeEdge[], b: readonly CodeEdge[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.from !== y.from || x.to !== y.to || x.kind !== y.kind || x.confidence !== y.confidence || x.origin !== y.origin) {
      return false;
    }
  }
  return true;
}

export interface ResolveProjectImportsInput {
  projectId: string;
  registry: CodeLanguageRegistry;
  /** All current shards (post extraction + compaction + freshness reclass). */
  shards: FileShard[];
  /** Project-local resolver configuration snapshot, prepared by refresh. */
  resolverConfig?: unknown;
  cwd?: string;
  preferredDirName?: string;
  /** Test seam: shard persister (defaults to the real {@link writeShard}). */
  persistShard?: (shard: FileShard, cwd?: string, preferredDirName?: string) => void;
}

export interface ResolveProjectImportsResult {
  rewroteAny: boolean;
  shardsRewritten: number;
  /** Total pass-owned edges emitted (A `resolves_to` + B `imports_symbol`). */
  edgesEmitted: number;
  /** Subset: B `imports_symbol` edges emitted. */
  symbolEdgesEmitted: number;
}

/**
 * Resolve every import in the project to a `resolves_to` edge (file-level v1).
 * Mutates + persists only the shards whose `resolves_to` set changed; returns
 * whether any shard was rewritten so the caller can re-list before index build.
 */
export async function resolveProjectImports(
  input: ResolveProjectImportsInput,
): Promise<ResolveProjectImportsResult> {
  const { projectId, registry, shards } = input;
  const persist = input.persistShard ?? writeShard;

  // Project file-set: indexed path -> lang. Resolution targets MUST be indexed
  // files — this map is the ONLY project knowledge providers get (via ctx).
  const fileLang = new Map<string, CodeLang>();
  for (const s of shards) fileLang.set(toPosix(s.path), s.lang);

  const ctx: ResolveImportContext = {
    fileExists: (rel) => fileLang.has(toPosix(rel)),
    langOfFile: (rel) => fileLang.get(toPosix(rel)),
    resolverConfig: input.resolverConfig,
  };

  // Target-file lookups for B: path -> shard, and a memoized importable index
  // (name -> importable symbols) per target file (built lazily, reused across importers).
  const shardByPath = new Map<string, FileShard>();
  for (const s of shards) shardByPath.set(toPosix(s.path), s);
  const importableCache = new Map<string, Map<string, CodeNode[]>>();
  const importableFor = (targetPath: string, targetLang: CodeLang): Map<string, CodeNode[]> => {
    let idx = importableCache.get(targetPath);
    if (!idx) {
      const targetShard = shardByPath.get(targetPath);
      idx = buildImportableIndex(targetShard?.nodes ?? [], registry.providerForLang(targetLang));
      importableCache.set(targetPath, idx);
    }
    return idx;
  };

  let shardsRewritten = 0;
  let edgesEmitted = 0;
  let symbolEdgesEmitted = 0;

  for (const shard of shards) {
    const provider = registry.providerForLang(shard.lang);
    // Non-pass-owned edges are preserved byte-identical (same order). Filtering BOTH
    // pass-owned kinds also strips any stale A/B edge from a prior run (idempotency).
    const kept = shard.edges.filter((e) => !PASS_OWNED_EDGE_KINDS.has(e.kind) && e.origin !== 'usage_import');

    // Fresh pass-owned set (A resolves_to + B imports_symbol). Empty when no resolver.
    const fresh: CodeEdge[] = [];
    const seen = new Set<string>();
    // module + imported-name → unique target proven by imports_symbol below.
    const resolvedImportedBindings = new Map<string, CodeNode>();
    let freshSymbolCount = 0;
    if (provider?.resolveImport) {
      const seen = new Set<string>();
      for (const mod of shard.nodes) {
        if (mod.kind !== 'module') continue;
        const resolutions = await provider.resolveImport(
          {
            source: mod.name,
            fromPath: toPosix(shard.path),
            importedNames: mod.imported_names ?? [],
            span: mod.span ?? undefined,
          },
          ctx,
        );
        for (const r of resolutions) {
          if (!r.resolvedPath) continue;
          const targetPath = toPosix(r.resolvedPath);
          const targetLang = fileLang.get(targetPath);
          if (!targetLang) continue; // target not an indexed file → no edge
          const confidence = clampConfidence(r.confidence);
          if (confidence <= 0) continue; // preserves the resolves_to confidence invariant: (0, 1]
          const source = { path: toPosix(shard.path), line: mod.span?.start_line ?? null };

          // A — file-level resolves_to.
          const to = fileNodeId(projectId, targetPath, targetLang);
          const id = edgeId({ projectId, from: mod.id, to, kind: 'resolves_to' });
          if (!seen.has(id)) {
            seen.add(id);
            fresh.push({ id, from: mod.id, to, kind: 'resolves_to', confidence, source });
          }

          // B — symbol-level imports_symbol, off the SAME-RUN resolved target file.
          // Skip default/namespace (no single named symbol). Bind a name only when the
          // target has exactly ONE importable symbol with it (ambiguous/absent → skip).
          const idx = importableFor(targetPath, targetLang);
          for (const name of mod.imported_names ?? []) {
            if (name === 'default' || name === '*') continue;
            const target = lookupImportable(idx, name);
            if (!target) continue;
            const symId = edgeId({ projectId, from: mod.id, to: target.id, kind: 'imports_symbol' });
            if (seen.has(symId)) continue; // dedup (duplicate names / re-imports)
            seen.add(symId);
            fresh.push({ id: symId, from: mod.id, to: target.id, kind: 'imports_symbol', confidence, source });
            resolvedImportedBindings.set(`${r.source}\0${name}`, target);
            freshSymbolCount++;
          }
        }
      }
    }

    // P4 imported-binding usages are emitted only after the exact `imports_symbol`
    // proof above. If a module is unresolved, ambiguous, wildcard/default, or its
    // target no longer exports the symbol, no call/reference edge survives.
    for (const candidate of shard.reference_candidates ?? []) {
      const target = resolvedImportedBindings.get(`${candidate.module}\0${candidate.imported_name}`);
      if (!target) continue;
      const id = edgeId({ projectId, from: candidate.from, to: target.id, kind: candidate.kind });
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push({
        id,
        from: candidate.from,
        to: target.id,
        kind: candidate.kind,
        confidence: Math.min(clampConfidence(candidate.confidence), 1.0),
        source: candidate.source,
        origin: 'usage_import',
      });
    }

    // Single deterministic order over A+B so re-runs are byte-identical (from, to, kind).
    fresh.sort((a, b) => {
      if (a.from !== b.from) return a.from.localeCompare(b.from);
      if (a.to !== b.to) return a.to.localeCompare(b.to);
      return a.kind.localeCompare(b.kind);
    });

    const nextEdges = [...kept, ...fresh];
    if (!edgesArrayEqual(shard.edges, nextEdges)) {
      for (const e of fresh) EdgeSchema.parse(e); // loud on a malformed pass-owned edge
      shard.edges = nextEdges;
      persist(shard, input.cwd, input.preferredDirName);
      shardsRewritten++;
    }
    edgesEmitted += fresh.length;
    symbolEdgesEmitted += freshSymbolCount;
  }

  return { rewroteAny: shardsRewritten > 0, shardsRewritten, edgesEmitted, symbolEdgesEmitted };
}
