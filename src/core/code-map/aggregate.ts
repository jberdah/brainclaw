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
import { coarseFreshness } from './freshness.js';
import {
  findInStore,
  makeLazyChecker,
  newAccumulator,
  deriveBadge,
  type FindMatch,
} from './query.js';
import type { FreshnessBadge, FreshnessStatus } from './types.js';

/** Same default cap as the single-store find (query.ts DEFAULT_FIND_LIMIT). */
const DEFAULT_FIND_LIMIT = 20;

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

function projectIdOf(cwd: string): string {
  const m = readManifest(cwd);
  if (m?.project_id) return m.project_id;
  try {
    const id = loadConfig(cwd).project_id;
    if (id) return id;
  } catch {
    /* no config — fall through to a cwd-derived default */
  }
  return `prj_${path.basename(path.resolve(cwd))}`;
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
    const stores: StoreRef[] = [
      { cwd: abs, relPath: '', projectId: projectIdOf(abs), isLocal: true },
      ...listNestedProjects(abs).map((childAbs) => ({
        cwd: childAbs,
        relPath: path.relative(abs, childAbs).replace(/\\/g, '/'),
        projectId: projectIdOf(childAbs),
        isLocal: false,
      })),
    ];
    return { workspace: true, root: abs, stores };
  }
  return {
    workspace: false,
    root: abs,
    stores: [{ cwd: abs, relPath: '', projectId: projectIdOf(abs), isLocal: true }],
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
): AggregatedFindOutput {
  const checker = makeLazyChecker(); // ONE shared budget across every store
  const perStore: PerStoreBadge[] = [];
  const merged: AggregatedFindMatch[] = [];
  const seen = new Set<string>(); // (project_id, node_id)

  for (const ref of resolved.stores) {
    const acc = newAccumulator();
    const r = findInStore(query, { cwd: ref.cwd }, checker, acc);
    const badge = deriveBadge(r.base, acc, checker.exhausted, r.matches.length > 0, r.emptyCandidates);
    perStore.push({ ref, badge, hasIndex: r.hasIndex });
    for (const m of r.matches) {
      const key = `${ref.projectId} ${m.node_id}`;
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
