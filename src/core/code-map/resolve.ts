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
 * `module --resolves_to--> <target file node>`. The PROVIDER returns paths only;
 * the CORE mints the edge + target file-node id (dec#108/#109 boundary).
 *
 * Idempotency (Codex R1 #4): edge ids are deterministic by (project, from, to,
 * kind) only, so each shard is rewritten by KEEPING every non-`resolves_to`
 * node/edge byte-identical (same order), FILTERING old `resolves_to`, then
 * appending the freshly computed edges in a deterministic order. A shard is only
 * written when its edge array actually changed — so a project with no resolver is
 * a pure no-op (nothing rewritten), and re-runs are byte-identical.
 *
 * Recompute-all (Codex R1): the pass resolves over ALL shards every refresh (even
 * `--changed`) and rewrites only the shards whose `resolves_to` set changed. That
 * removes the moved/deleted-target stale-edge problem without a reverse-dependency
 * scheduler — the pass already holds the full current file set.
 */
import { edgeId, fileNodeId } from './ids.js';
import { writeShard } from './store.js';
import type { CodeEdge, CodeLang, FileShard } from './types.js';
import { EdgeSchema } from './types.js';
import type { CodeLanguageRegistry, ResolveImportContext } from './lang/provider.js';

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
    if (x.id !== y.id || x.from !== y.from || x.to !== y.to || x.kind !== y.kind || x.confidence !== y.confidence) {
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
  cwd?: string;
  preferredDirName?: string;
  /** Test seam: shard persister (defaults to the real {@link writeShard}). */
  persistShard?: (shard: FileShard, cwd?: string, preferredDirName?: string) => void;
}

export interface ResolveProjectImportsResult {
  rewroteAny: boolean;
  shardsRewritten: number;
  edgesEmitted: number;
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
  };

  let shardsRewritten = 0;
  let edgesEmitted = 0;

  for (const shard of shards) {
    const provider = registry.providerForLang(shard.lang);
    // Non-resolves_to edges are preserved byte-identical (same order).
    const kept = shard.edges.filter((e) => e.kind !== 'resolves_to');

    // Fresh resolves_to set (empty when no resolver — which also strips any stale
    // resolves_to from a prior run, keeping the pass idempotent).
    const fresh: CodeEdge[] = [];
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
          const to = fileNodeId(projectId, targetPath, targetLang);
          const id = edgeId({ projectId, from: mod.id, to, kind: 'resolves_to' });
          if (seen.has(id)) continue; // dedup (same module → same target)
          seen.add(id);
          fresh.push({
            id,
            from: mod.id,
            to,
            kind: 'resolves_to',
            confidence,
            source: { path: toPosix(shard.path), line: mod.span?.start_line ?? null },
          });
        }
      }
    }

    // Deterministic order so re-runs are byte-identical.
    fresh.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

    const nextEdges = [...kept, ...fresh];
    if (!edgesArrayEqual(shard.edges, nextEdges)) {
      for (const e of fresh) EdgeSchema.parse(e); // loud on a malformed pass-owned edge
      shard.edges = nextEdges;
      persist(shard, input.cwd, input.preferredDirName);
      shardsRewritten++;
    }
    edgesEmitted += fresh.length;
  }

  return { rewroteAny: shardsRewritten > 0, shardsRewritten, edgesEmitted };
}
