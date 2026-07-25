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
import path from 'node:path';
import { loadConfig } from '../config.js';
import { listNestedProjects } from './cascade.js';
import { readManifest } from './store.js';
import { coarseFreshness, applyGitHeadDrift } from './freshness.js';
import {
  findInStore,
  makeLazyChecker,
  newAccumulator,
  deriveBadge,
  LAZY_BUDGET,
  type FindMatch,
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
}

export interface AggregatedFindOutput {
  query: string;
  matches: AggregatedFindMatch[];
  freshness_badge: FreshnessBadge;
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

/**
 * Resolve which stores a find/brief should read. `auto` (default) aggregates the
 * whole workspace ONLY when the caller's cwd is itself a multi-project root;
 * otherwise it is single-store (unchanged behavior, and a child cwd stays local).
 * `project` forces single-store. `workspace` requests aggregation but, in PR1, still
 * only fires at a root cwd — resolving a *child* cwd UP to its workspace root is a
 * follow-up (see pln#631), so it degrades to single-store rather than guess.
 */
export function resolveTraversal(cwd: string, mode: TraversalMode): ResolvedTraversal {
  const abs = path.resolve(cwd);
  const wantWorkspace = mode === 'workspace' || mode === 'auto';
  if (wantWorkspace && isWorkspaceRoot(abs)) {
    const rootMeta = storeMeta(abs);
    const stores: StoreRef[] = [
      { cwd: abs, relPath: '', projectId: rootMeta.projectId, gitHead: rootMeta.gitHead, isLocal: true },
      ...listNestedProjects(abs).map((childAbs) => {
        const meta = storeMeta(childAbs);
        return {
          cwd: childAbs,
          relPath: path.relative(abs, childAbs).replace(/\\/g, '/'),
          projectId: meta.projectId,
          gitHead: meta.gitHead,
          isLocal: false,
        };
      }),
    ];
    return { workspace: true, root: abs, stores };
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
  const unindexed = perStore
    .filter((p) => !p.hasIndex)
    .map((p) => p.ref.relPath || '.')
    .sort();

  if (indexed.length === 0) {
    return {
      status: 'missing_index',
      coarse: 'missing',
      details: {
        traversal: 'workspace',
        projects_indexed: 0,
        projects_total: total,
        unindexed_projects: unindexed,
        hint: 'run refresh --cascade',
      },
    };
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

  // Merge the per-store detail path-sets, prefixing each with its store's
  // workspace-relative dir so a bare `src/index.ts` isn't ambiguous across packages.
  const prefixMerge = (key: string): string[] => {
    const out: string[] = [];
    for (const p of indexed) {
      const arr = p.badge.details?.[key];
      if (Array.isArray(arr)) {
        for (const f of arr) out.push(p.ref.relPath ? `${p.ref.relPath}/${String(f)}` : String(f));
      }
    }
    return out.sort();
  };
  for (const key of ['stale_changed_files', 'deleted_files', 'unchecked_files']) {
    const merged = prefixMerge(key);
    if (merged.length) details[key] = merged;
  }
  const partialStore = indexed.find((p) => p.badge.status === 'partial');
  if (partialStore) {
    details.partial_reason = partialStore.badge.details?.partial_reason ?? 'lazy_check_budget_exhausted';
  }

  return { status: worst, coarse: coarseFreshness(worst), details };
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
      });
    }
  }

  merged.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
  );
  const capped = merged.slice(0, limit ?? DEFAULT_FIND_LIMIT);
  return { query, matches: capped, freshness_badge: mergeBadges(perStore) };
}
