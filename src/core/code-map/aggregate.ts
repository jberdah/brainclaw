/**
 * Code Map workspace AGGREGATION (pln#631 PR1 — root-aggregated find).
 *
 * A `find` at a multi-project workspace ROOT must surface symbols defined in ANY
 * nested child project's store — today it reads only the root store (which, after a
 * cascade refresh, is scoped to the files no child owns, so a root find returns
 * almost nothing and the agent falls back to grep). This module fans `findInStore`
 * out across the root + every nested project store at READ time (no persisted root
 * super-index, no cross-store index writes) and merges the results.
 *
 * The three semantics the design pins (dec#146):
 *  (a) ONE shared lazy-check budget across stores (the checker's memo is file_id-keyed
 *      — unique per store — so sharing never collides same-named files across packages).
 *  (b) Merged badge = WORST status across the *indexed* stores + coverage
 *      (projects_indexed/total, unindexed_projects); a child with no index must NOT
 *      drag the top-line to `missing`.
 *  (c) Dedupe merged matches on (project_id, node_id) and rewrite paths to
 *      workspace-relative, so the `prj_${basename}` id fallback + same-named files
 *      across packages can never merge two distinct symbols.
 *
 * Cross-package import resolution + brief aggregation + child-initiated workspace
 * scope are follow-ups (see pln#631).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { listNestedProjects } from './cascade.js';
import { readManifest, readImportsIndex } from './store.js';
import { makeFreshnessBadge, applyGitHeadDrift, type SpotCheckDetails } from './freshness.js';
import {
  findInStore,
  briefInStore,
  makeLazyChecker,
  newAccumulator,
  deriveBadge,
  reserveSourceSlots,
  attachRelatedMemory,
  attachMemoryIds,
  validateStoreEntry,
  BRIEF_FILE_CAP,
  LAZY_BUDGET,
  type FindMatch,
  type RankedFile,
  type BriefMatchKind,
  type BriefReadEntry,
  type RelatedMemoryItem,
  type MemoryReader,
  type LazyChecker,
} from './query.js';
import type { FreshnessBadge, FreshnessStatus } from './types.js';

/** Same default cap as the single-store find (query.ts DEFAULT_FIND_LIMIT). */
const DEFAULT_FIND_LIMIT = 20;

/**
 * pln#631 (review F2) — an aggregated find shares ONE lazy budget across N stores.
 * A flat 32-file budget starves alphabetically-later stores (their drifted candidates
 * get dropped once earlier stores spend it). Scale the budget with the store count so
 * later stores keep headroom, capped so an interactive read stays bounded even on a
 * large monorepo. Fully fresh stores cost nothing (the mtime/size gate short-circuits
 * before the budget), so this only raises the ceiling for genuinely-drifted trees.
 */
const AGG_MAX_FILES_CAP = 256;
const AGG_MAX_WALL_CAP_MS = 10_000;
function aggregateBudget(storeCount: number): { maxFilesChecked: number; maxWallMs: number } {
  return {
    maxFilesChecked: Math.min(LAZY_BUDGET.maxFilesChecked * Math.max(1, storeCount), AGG_MAX_FILES_CAP),
    maxWallMs: Math.min(LAZY_BUDGET.maxWallMs * Math.max(1, storeCount), AGG_MAX_WALL_CAP_MS),
  };
}

/** How a read fans out across a multi-project workspace. */
export type TraversalMode = 'auto' | 'project' | 'workspace';

/** A resolved store participating in an aggregation. */
export interface StoreRef {
  /** Absolute project cwd (its store lives at `<cwd>/.brainclaw/code/`). */
  cwd: string;
  /** Workspace-root-relative dir (`''` for the root project). */
  relPath: string;
  /** Project id (manifest, else config, else a cwd-basename fallback). */
  projectId: string;
  /** The commit this store's index was built against (manifest git.head), if any.
   *  Used for per-store HEAD-drift detection against the one current workspace HEAD. */
  gitHead: string | null;
  /** True for the project owning the caller's cwd (locality; unused in PR1). */
  isLocal: boolean;
}

export interface ResolvedTraversal {
  /** True when this resolves to a multi-store workspace aggregation. */
  workspace: boolean;
  /** Absolute workspace root (or the single project's cwd). */
  root: string;
  /** Stores to read (root first, then nested children; single entry when !workspace). */
  stores: StoreRef[];
}

/** A find match tagged with its owning project (only set on aggregated results). */
export interface AggregatedFindMatch extends FindMatch {
  /** Workspace-relative package dir (`''` = root project). Undefined single-store. */
  project?: string;
  project_id?: string;
  /** pln#631 PR4 — true when this hit is in the caller's OWN package (locality tiebreak:
   *  a same-package hit ranks above an equal-scored hit from another package). */
  local?: boolean;
}

export interface AggregatedFindOutput {
  query: string;
  matches: AggregatedFindMatch[];
  freshness_badge: FreshnessBadge;
}

/**
 * Walk UP from a child cwd and return the NEAREST ancestor that is a multi-project
 * workspace root. Preferred over "outermost .brainclaw" (which can over-reach to an
 * unrelated ancestor project, or a stray ~/tmp/.brainclaw): the immediate enclosing
 * multi-project root is the child's actual workspace. Bounded ancestor walk.
 */
function findEnclosingWorkspaceRoot(startDir: string): string | undefined {
  let dir = path.dirname(path.resolve(startDir)); // the child itself is not its own workspace root
  const fsRoot = path.parse(dir).root;
  for (let i = 0; i < 64; i++) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === fsRoot) break;
    dir = parent;
  }
  return undefined;
}

/** True when cwd is a multi-project workspace root (the SAME gate the cascade uses). */
function isWorkspaceRoot(cwd: string): boolean {
  let mode: string | undefined;
  try {
    mode = loadConfig(cwd).project_mode;
  } catch {
    return false;
  }
  return mode === 'multi-project' && listNestedProjects(cwd).length > 0;
}

/** Read a store's identity + built-against commit in ONE manifest read. */
function storeMeta(cwd: string): { projectId: string; gitHead: string | null } {
  const m = readManifest(cwd);
  const gitHead = m?.git?.head ?? null;
  if (m?.project_id) return { projectId: m.project_id, gitHead };
  try {
    const id = loadConfig(cwd).project_id;
    if (id) return { projectId: id, gitHead };
  } catch {
    /* no config — fall through to a cwd-derived default */
  }
  return { projectId: `prj_${path.basename(path.resolve(cwd))}`, gitHead };
}

/** True when `localCwd` is `storeCwd` or lives under it (case-folded on win32). */
function storeContains(storeCwd: string, localCwd: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(storeCwd), norm(localCwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Build the root + nested-child StoreRefs for a workspace, flagging the caller-local one.
 * Locality is by CONTAINMENT, not exact equality (review): the caller usually stands in a
 * `src/…` subdir of its package, not exactly at the package root — the DEEPEST store whose
 * cwd contains `localCwd` is the caller's own package. Case-insensitive on win32.
 */
function buildWorkspaceStores(root: string, localCwd: string): StoreRef[] {
  const rootMeta = storeMeta(root);
  const stores: StoreRef[] = [
    { cwd: root, relPath: '', projectId: rootMeta.projectId, gitHead: rootMeta.gitHead, isLocal: false },
    ...listNestedProjects(root).map((childAbs) => {
      const meta = storeMeta(childAbs);
      return {
        cwd: childAbs,
        relPath: path.relative(root, childAbs).replace(/\\/g, '/'),
        projectId: meta.projectId,
        gitHead: meta.gitHead,
        isLocal: false,
      };
    }),
  ];
  // The caller-local store = the DEEPEST (longest cwd) store containing localCwd.
  let localStore: StoreRef | undefined;
  for (const s of stores) {
    if (storeContains(s.cwd, localCwd) && (!localStore || s.cwd.length > localStore.cwd.length)) {
      localStore = s;
    }
  }
  if (localStore) localStore.isLocal = true;
  return stores;
}

/**
 * Resolve which stores a find/brief should read.
 *  - `auto` (default): aggregate the whole workspace ONLY when cwd is itself a
 *    multi-project root; otherwise single-store (a child cwd stays local, unchanged).
 *  - `project`: force single-store.
 *  - `workspace`: aggregate the whole workspace. At a root, same as auto. From a CHILD
 *    cwd (pln#631 PR4), walk UP to the workspace root and aggregate from there, keeping
 *    the caller's package flagged `isLocal` for the locality tiebreak — so an agent
 *    inside `packages/api` can search the whole monorepo, with its own package's hits
 *    ranked first. Degrades to single-store only when no multi-project root is found.
 */
export function resolveTraversal(cwd: string, mode: TraversalMode): ResolvedTraversal {
  const abs = path.resolve(cwd);
  if ((mode === 'auto' || mode === 'workspace') && isWorkspaceRoot(abs)) {
    return { workspace: true, root: abs, stores: buildWorkspaceStores(abs, abs) };
  }
  if (mode === 'workspace') {
    // Explicit workspace request from a non-root cwd: find the NEAREST enclosing
    // multi-project root and aggregate from there (auto never does this).
    const wsRoot = findEnclosingWorkspaceRoot(abs);
    if (wsRoot) {
      return { workspace: true, root: wsRoot, stores: buildWorkspaceStores(wsRoot, abs) };
    }
  }
  const meta = storeMeta(abs);
  return {
    workspace: false,
    root: abs,
    stores: [{ cwd: abs, relPath: '', projectId: meta.projectId, gitHead: meta.gitHead, isLocal: true }],
  };
}

/** Worst-status precedence for the merged badge (higher = worse = surfaced). */
function statusRank(s: FreshnessStatus): number {
  switch (s) {
    case 'partial':
      return 4;
    case 'stale_changed_files':
    case 'stale_extractor':
    case 'stale_grammar':
    case 'stale_git_head':
      return 3;
    case 'fresh':
      return 1;
    case 'missing_index':
      return 0;
    default: {
      const _exhaustive: never = s;
      void _exhaustive;
      return 0;
    }
  }
}

interface PerStoreBadge {
  ref: StoreRef;
  badge: FreshnessBadge;
  hasIndex: boolean;
}

/**
 * Merge per-store badges into one workspace badge: worst status among the INDEXED
 * stores (a missing-index child contributes to coverage, never drags the top-line),
 * plus coverage + workspace-relative detail path-sets. Only when EVERY store is
 * un-indexed is the whole workspace `missing_index`.
 */
function mergeBadges(perStore: PerStoreBadge[]): FreshnessBadge {
  const total = perStore.length;
  const indexed = perStore.filter((p) => p.hasIndex);
  const unindexed = perStore.filter((p) => !p.hasIndex).map((p) => p.ref.relPath || '.').sort();

  if (indexed.length === 0) {
    return makeFreshnessBadge('missing_index', {
      extra: { traversal: 'workspace', projects_indexed: 0, projects_total: total, unindexed_projects: unindexed, hint: 'run refresh --cascade' },
    });
  }

  let worst: FreshnessStatus = indexed[0]!.badge.status;
  for (const p of indexed) {
    if (statusRank(p.badge.status) > statusRank(worst)) worst = p.badge.status;
  }

  const details: Record<string, unknown> = {
    traversal: 'workspace',
    projects_indexed: indexed.length,
    projects_total: total,
    per_project: Object.fromEntries(perStore.map((p) => [p.ref.relPath || '.', p.badge.status])),
  };
  if (unindexed.length) details.unindexed_projects = unindexed;

  const prefixMerge = (key: keyof SpotCheckDetails): string[] => {
    const out: string[] = [];
    for (const p of indexed) {
      const spot = p.badge.details.spot_check as Partial<SpotCheckDetails> | undefined;
      const arr = spot?.[key];
      if (Array.isArray(arr)) {
        for (const f of arr) out.push(p.ref.relPath ? `${p.ref.relPath}/${String(f)}` : String(f));
      }
    }
    return out.sort();
  };
  const spotChecks = indexed.map((p) => p.badge.details.spot_check as Partial<SpotCheckDetails> | undefined);
  const spotStatus = spotChecks.some((spot) => spot?.status === 'partial')
    ? 'partial'
    : spotChecks.some((spot) => spot?.status === 'stale')
      ? 'stale'
      : spotChecks.some((spot) => spot?.status === 'fresh') ? 'fresh' : 'not_run';
  const partialSpot = spotChecks.find((spot) => spot?.status === 'partial');
  return makeFreshnessBadge(worst, {
    spotCheck: {
      status: spotStatus,
      checked_files: spotChecks.reduce((sum, spot) => sum + (spot?.checked_files ?? 0), 0),
      stale_changed_files: prefixMerge('stale_changed_files'),
      deleted_files: prefixMerge('deleted_files'),
      unchecked_files: prefixMerge('unchecked_files'),
      budget_exhausted: spotChecks.some((spot) => spot?.budget_exhausted === true),
      partial_reason: partialSpot?.partial_reason ?? null,
    },
    extra: details,
  });
}
/**
 * Aggregated find across a resolved multi-project workspace. Shares ONE lazy budget
 * across stores; dedupes on (project_id, node_id); rewrites paths workspace-relative;
 * re-ranks with the single-store comparator; caps; and merges the freshness badges.
 */
export function aggregateFind(
  query: string,
  limit: number | undefined,
  resolved: ResolvedTraversal,
  currentHead: string | null,
): AggregatedFindOutput {
  // ONE shared budget across every store, scaled by store count (review F2) so
  // alphabetically-later stores aren't starved by earlier dirty trees.
  const checker = makeLazyChecker(aggregateBudget(resolved.stores.length));
  const perStore: PerStoreBadge[] = [];
  const merged: AggregatedFindMatch[] = [];
  const seen = new Set<string>(); // (project_id, node_id)

  for (const ref of resolved.stores) {
    const acc = newAccumulator();
    const r = findInStore(query, { cwd: ref.cwd }, checker, acc);
    // Per-store badge: drive `partial` from THIS store's own budget-skips (review F2),
    // NOT the shared checker.exhausted flag — else an early store spending the budget
    // would mislabel every fully-fresh later store as `partial` in per_project. Then
    // apply per-store HEAD drift against the one workspace HEAD (review F3) so a child
    // whose index lags the working tree is flagged even under an otherwise-fresh root.
    let badge = deriveBadge(r.base, acc, false, r.matches.length > 0, r.emptyCandidates);
    badge = applyGitHeadDrift(badge, ref.gitHead, currentHead);
    perStore.push({ ref, badge, hasIndex: r.hasIndex });
    for (const m of r.matches) {
      // Dedup key scoped by store cwd (unique per store), NEVER project_id — two stores
      // can share a project_id (review F1), which would false-merge/drop a distinct symbol.
      // Cross-store never merges (different packages = different symbols).
      const key = `${ref.cwd} ${m.node_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...m,
        path: ref.relPath ? `${ref.relPath}/${m.path}` : m.path,
        project: ref.relPath,
        project_id: ref.projectId,
        ...(ref.isLocal ? { local: true } : {}),
      });
    }
  }

  // Sort by score, then LOCALITY (caller's own package first — PR4 tiebreak), then path.
  merged.sort(
    (a, b) =>
      b.score - a.score ||
      (b.local ? 1 : 0) - (a.local ? 1 : 0) ||
      a.path.localeCompare(b.path) ||
      a.name.localeCompare(b.name),
  );
  const capped = merged.slice(0, limit ?? DEFAULT_FIND_LIMIT);
  return { query, matches: capped, freshness_badge: mergeBadges(perStore) };
}

// --- brief aggregation (pln#631 PR2) ---

/** An aggregated brief reading-list entry: a BriefReadEntry tagged with its project. */
export interface AggregatedBriefReadEntry extends BriefReadEntry {
  /** Workspace-relative package dir (`''` = root). Undefined on single-store briefs. */
  project?: string;
  /** pln#631 PR3 — true when this row is a CROSS-PACKAGE importer (a sibling package
   *  importing the defining package's public name), not an intra-package graph row. */
  cross_package?: boolean;
  /** pln#631 PR4 — true when this row is in the caller's OWN package (locality tiebreak). */
  local?: boolean;
}

export interface AggregatedBriefOutput {
  target: string;
  suggested_files_to_read: AggregatedBriefReadEntry[];
  related_memory: RelatedMemoryItem[];
  freshness_badge: FreshnessBadge;
}

/** Match-tier precedence for cross-store target selection: exact > path > fuzzy > none. */
function briefMatchTier(k: BriefMatchKind): number {
  return k === 'exact' ? 3 : k === 'path' ? 2 : k === 'fuzzy' ? 1 : 0;
}

/** A merged brief reading-list row (workspace-relative path + owning project). */
type MergedBriefRow = RankedFile & { project: string; cross_package?: boolean; local?: boolean };

/** Read a store's package.json `name` (the specifier siblings import it as), or null. */
function packageNameOf(cwd: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : null;
  } catch {
    return null;
  }
}

/**
 * Cross-package reverse dependents (pln#631 PR3): sibling packages that IMPORT the
 * defining package's public name. READ-TIME only — no cross-store index writes (the
 * per-project-store-write invariant is inviolate). For each defining store B (package
 * name `nameB`), scan every OTHER store A's imports index for specifiers `=== nameB`
 * or `startsWith(nameB + '/')`; each importer file is a cross-package dependent.
 * NAME-LEVEL precision: an importer whose `imported[]` names one of the target symbols
 * ranks above a bare package-level import. Reverse-deps ONLY — forward cross-package
 * deps have no single target file (deferred). Rows are graph-derived + flagged
 * cross_package so their (name-based, lower) confidence is legible.
 */
function crossPackageReverseDeps(
  contributing: StoreRef[],
  allStores: StoreRef[],
  symbolNames: Set<string>,
  checker: LazyChecker,
): MergedBriefRow[] {
  const targetPkgNames = new Map<string, StoreRef>(); // package name -> defining store B
  for (const ref of contributing) {
    const name = packageNameOf(ref.cwd);
    if (name) targetPkgNames.set(name, ref);
  }
  if (targetPkgNames.size === 0) return [];
  const matchesTarget = (spec: string): boolean => {
    for (const nameB of targetPkgNames.keys()) {
      if (spec === nameB || spec.startsWith(`${nameB}/`)) return true;
    }
    return false;
  };

  // Aggregate per IMPORTER FILE across ALL matching specifiers first (review F2): a file
  // importing the target package under two specifiers — one name-level, one bare — must
  // be scored by its BEST precision, not by whichever specifier `Object.entries` happens
  // to yield first. Keyed by store cwd + path (never project_id).
  const contributingCwds = new Set(contributing.map((r) => r.cwd));
  interface Agg { cwd: string; relPath: string; path: string; file_id: string; local: boolean; namedHits: Set<string>; specs: Set<string>; }
  const byImporter = new Map<string, Agg>();
  for (const a of allStores) {
    if (contributingCwds.has(a.cwd)) continue; // intra-package deps already covered
    const imports = readImportsIndex(a.cwd);
    if (!imports) continue;
    for (const [spec, importers] of Object.entries(imports.entries)) {
      if (!matchesTarget(spec)) continue;
      for (const imp of importers) {
        const key = `${a.cwd}::${imp.path}`;
        let agg = byImporter.get(key);
        if (!agg) {
          agg = { cwd: a.cwd, relPath: a.relPath, path: imp.path, file_id: imp.file_id, local: a.isLocal, namedHits: new Set(), specs: new Set() };
          byImporter.set(key, agg);
        }
        agg.specs.add(spec);
        for (const n of imp.imported) if (symbolNames.has(n)) agg.namedHits.add(n);
      }
    }
  }

  // Emit one row per importer — but LAZY-VALIDATE it against its store first (review F1):
  // a cross-package row is graph-derived, so a deleted/stale importer must be SUPPRESSED
  // just like an intra-package graph row (no silent stale graph hints). Shares the one
  // budget; a throwaway acc (row-drop only — the sibling store's manifest freshness
  // already rides the merged badge via its per-store briefInStore).
  const rows: MergedBriefRow[] = [];
  const acc = newAccumulator();
  for (const agg of byImporter.values()) {
    const ok = validateStoreEntry({ path: agg.path, file_id: agg.file_id }, checker, acc, agg.cwd, undefined);
    if (!ok) continue; // deleted / stale / budget-skipped → suppress (graph-derived)
    const nameLevel = agg.namedHits.size > 0;
    const score = nameLevel ? 5 : 3; // name-level ranks with reverse-deps; package-level below
    const shortestSpec = [...agg.specs].sort((x, y) => x.length - y.length)[0] ?? '';
    rows.push({
      path: agg.relPath ? `${agg.relPath}/${agg.path}` : agg.path,
      file_id: agg.file_id,
      reason: nameLevel
        ? `cross-package: imports ${[...agg.namedHits].sort().join(', ')} from ${shortestSpec}`
        : `cross-package: imports ${shortestSpec}`,
      score,
      bestDelta: score,
      graphDerived: true,
      project: agg.relPath,
      cross_package: true,
      ...(agg.local ? { local: true } : {}),
    });
  }
  return rows;
}

/**
 * Aggregated brief across a resolved multi-project workspace (pln#631 PR2). Resolves
 * the target in EVERY store (shared budget), then contributes reading lists ONLY from
 * the stores at the HIGHEST match tier present (exact > path > fuzzy) — so a symbol
 * defined exactly in one package is never diluted by fuzzy token-noise from siblings,
 * while a name defined exactly in two packages briefs both. Reading-list paths are
 * workspace-relative + project-tagged; the source-reserve + memory attach run on the
 * MERGED list. Related memory comes from the ROOT project only in PR2 (cross-package
 * memory attach = follow-up). The badge merges per-store (worst-status + coverage,
 * per-store HEAD drift) exactly like aggregateFind.
 */
export function aggregateBrief(
  target: string,
  limit: number | undefined,
  resolved: ResolvedTraversal,
  currentHead: string | null,
  memoryReader: MemoryReader,
): AggregatedBriefOutput {
  const checker = makeLazyChecker(aggregateBudget(resolved.stores.length));
  const perStore = resolved.stores.map((ref) => {
    const acc = newAccumulator();
    const r = briefInStore(target, { cwd: ref.cwd }, checker, acc);
    let badge = deriveBadge(r.base, acc, false, r.confident.length > 0, r.emptyRanked);
    badge = applyGitHeadDrift(badge, ref.gitHead, currentHead);
    return { ref, r, badge };
  });

  // Contribute reading lists from the stores at the highest match TIER present (no
  // fuzzy dilution). But when NO store DEFINES the target (bestTier 0), fall back to
  // any store with a non-empty reading list — rankFiles' import-specifier heuristic can
  // surface relevant IMPORTER files even with no defining symbol (review F1: preserves
  // single-store brief parity for an imported-but-not-locally-defined name like `axios`).
  const bestTier = Math.max(0, ...perStore.map((p) => briefMatchTier(p.r.matchKind)));
  const contributing =
    bestTier > 0
      ? perStore.filter((p) => briefMatchTier(p.r.matchKind) === bestTier)
      : perStore.filter((p) => p.r.confident.length > 0);

  const merged: MergedBriefRow[] = [];
  const seen = new Set<string>();
  const mergedDefiningPaths = new Set<string>();
  const symbolNames = new Set<string>();
  const memorySymbolNames = new Set<string>();
  const memoryImportNames = new Set<string>();
  for (const p of contributing) {
    for (const e of p.r.defining) symbolNames.add(e.name);
    for (const name of p.r.memorySymbolNames) memorySymbolNames.add(name);
    for (const name of p.r.memoryImportNames) memoryImportNames.add(name);
    for (const dp of p.r.definingPaths) mergedDefiningPaths.add(p.ref.relPath ? `${p.ref.relPath}/${dp}` : dp);
    for (const rf of p.r.confident) {
      const key = `${p.ref.cwd}::${rf.path}`; // store-scoped dedup (never project_id)
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...rf,
        path: p.ref.relPath ? `${p.ref.relPath}/${rf.path}` : rf.path,
        project: p.ref.relPath,
        ...(p.ref.isLocal ? { local: true } : {}),
      });
    }
  }

  // pln#631 PR3 — cross-package reverse dependents: sibling packages importing the
  // defining package's public name. Only when a store genuinely DEFINES the target
  // (bestTier > 0) — the heuristic fallback has no "defining package" to find importers
  // of. Rows are flagged cross_package; keyed by their own store so they never collide
  // with the intra-package rows above.
  if (bestTier > 0) {
    // crossPackageReverseDeps dedups internally, and its rows come from NON-contributing
    // stores (distinct workspace-relative paths from the intra-package rows above), so a
    // direct append cannot collide.
    merged.push(...crossPackageReverseDeps(contributing.map((p) => p.ref), resolved.stores, symbolNames, checker));
  }

  merged.sort(
    (a, b) => b.score - a.score || (b.local ? 1 : 0) - (a.local ? 1 : 0) || a.path.localeCompare(b.path),
  );

  const cap = Math.min(limit ?? BRIEF_FILE_CAP, BRIEF_FILE_CAP);
  const capped = reserveSourceSlots(merged, cap, mergedDefiningPaths) as MergedBriefRow[];

  if (symbolNames.size === 0) symbolNames.add(target);
  if (memorySymbolNames.size === 0) memorySymbolNames.add(target);
  const related = attachRelatedMemory(
    memoryReader({ cwd: resolved.root }),
    capped.map((f) => f.path),
    [...memorySymbolNames],
    [...memoryImportNames],
  );
  const baseEntries = attachMemoryIds(capped, related, mergedDefiningPaths);
  const suggested: AggregatedBriefReadEntry[] = baseEntries.map((s, i) => ({
    ...s,
    project: capped[i]!.project,
    ...(capped[i]!.cross_package ? { cross_package: true } : {}),
    ...(capped[i]!.local ? { local: true } : {}),
  }));

  return {
    target,
    suggested_files_to_read: suggested,
    related_memory: summarizeRelatedMemory(related),
    freshness_badge: mergeBadges(perStore.map((p) => ({ ref: p.ref, badge: p.badge, hasIndex: p.r.hasIndex }))),
  };
}

/**
 * Resume la memoire liee servie par `code_brief` (pln#598 etape 3).
 *
 * POURQUOI. Un trap ou une decision de ce depot depasse regulierement 2 000 caracteres —
 * plusieurs des textes ecrits pendant la refonte federation v2 en font le double. Un
 * `code_brief` qui attache trois d'entre eux sert des milliers de caracteres avant meme
 * que l'agent n'ait ouvert un fichier, pour un contenu qu'il ne lira peut-etre pas.
 *
 * LE TEXTE N'EST PAS PERDU, IL EST DIFFERE. Chaque entree raccourcie porte l'appel EXACT
 * qui rend l'integralite. Un allegement qui supprime l'information au lieu de la deplacer
 * force l'agent a deviner — et deviner sur un trap est precisement ce que les traps
 * existent pour eviter.
 *
 * `id`, `kind`, `tags` et `related_paths` restent ENTIERS : ce sont eux qui permettent de
 * decider s'il vaut la peine d'aller lire. Les tronquer ferait economiser des octets sur
 * la seule partie qui sert a trier.
 */
const RELATED_MEMORY_TEXT_LIMIT = 300;

export function summarizeRelatedMemory(items: RelatedMemoryItem[]): RelatedMemoryItem[] {
  return items.map((item) => {
    if (typeof item.text !== 'string' || item.text.length <= RELATED_MEMORY_TEXT_LIMIT) return item;
    return {
      ...item,
      text: `${item.text.slice(0, RELATED_MEMORY_TEXT_LIMIT)}…`,
      text_truncated: true,
      full_text_via: { tool: 'bclaw_get', args: { entity: item.kind, id: item.id } },
    };
  });
}
