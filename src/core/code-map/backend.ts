/**
 * CodeQueryBackend — the agent-facing query contract (spec §8).
 *
 * Introduced in P0 so a future Memgraph (or other) backend can be added without
 * changing the agent-facing APIs. P0 ships exactly one implementation:
 * `JsonlBackend`. In this sprint, `status()` and `refresh()` are minimally real
 * (they read/init the durable store and report freshness); `find()`/`brief()`
 * return not-yet-implemented placeholders that still carry a real
 * `freshness_badge`, locking the response shape for later sprints.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readManifest, storeExists } from './store.js';
import { refresh as runRefresh } from './refresh.js';
import { applyGitHeadDrift, withCoarse } from './freshness.js';
import { brief as runBrief, find as runFind, type MemoryReader, type QueryContext } from './query.js';
import { resolveTraversal, aggregateFind, aggregateBrief, type TraversalMode } from './aggregate.js';
import { defaultMemoryReader } from './memory-reader.js';
import { listNestedProjects, refreshWorkspaceCascade, type CascadeResult } from './cascade.js';
import { loadConfig } from '../config.js';
import type { FreshnessBadge, FreshnessStatus, Manifest } from './types.js';

// --- Input / output types (spec §8, §9) ---

export interface CodeBackendContext {
  cwd?: string;
  preferredDirName?: string;
}

export interface CodeStatusInput extends CodeBackendContext {
  /**
   * Multi-project workspace recap: also report per-child store presence /
   * freshness for every nested brainclaw project under the root. Opt-in, mirrors
   * `refresh(cascade)`. No-op outside a multi-project workspace.
   */
  cascade?: boolean;
}

export interface CodeStatusChild {
  path: string;
  store_exists: boolean;
  freshness: FreshnessStatus | 'missing_index';
  files_indexed: number | null;
}

export interface CodeStatus {
  store_exists: boolean;
  freshness_badge: FreshnessBadge;
  stats: {
    files_indexed: number;
    nodes: number;
    edges: number;
  } | null;
  /** Present only when `cascade` was requested in a multi-project workspace. */
  cascade?: {
    children: CodeStatusChild[];
    /** Children that already have a built code index (manifest present). */
    indexed_children: number;
    total_children: number;
  };
}

export interface CodeRefreshInput extends CodeBackendContext {
  scope?: 'changed' | 'all';
  ownerAgent?: string | null;
  ownerAgentId?: string | null;
  /** Project identity. Falls back to the manifest, then a cwd-derived default. */
  projectId?: string;
  /** Source root to enumerate. Falls back to the manifest, then cwd. */
  projectRoot?: string;
  /**
   * Multi-project cascade: refresh EVERY nested brainclaw project into its own
   * store and the root store scoped to the files no child owns (zero
   * double-indexing). Opt-in. No-op (falls back to a single refresh) outside a
   * multi-project workspace. DGX Finding 2.
   */
  cascade?: boolean;
}

export interface CodeRefreshResult {
  ran: boolean;
  scope: 'changed' | 'all';
  lock_acquired: boolean;
  freshness_badge: FreshnessBadge;
  /** Present when the lock was held by a live competitor (spec §6 rule 7/12.3). */
  lock_status?: string;
  /** Present only when a `cascade` refresh ran (multi-project workspace). */
  cascade?: CascadeResult;
}

export interface CodeFindInput extends CodeBackendContext {
  query: string;
  limit?: number;
  /**
   * pln#631 — store traversal. `auto` (default) aggregates the whole workspace when
   * cwd is a multi-project root, else single-store; `project` forces single-store;
   * `workspace` requests aggregation (root cwd only in PR1).
   */
  traversal?: TraversalMode;
}

export interface CodeFindMatch {
  node_id: string;
  name: string;
  path: string;
  file_id: string;
  kind: string;
  subtype: string | null;
  score: number;
  /** pln#631 — set only on AGGREGATED results: the owning project (workspace-relative
   *  dir, `''` = root) + its id. `path` is workspace-root-relative when aggregating. */
  project?: string;
  project_id?: string;
  /** pln#631 PR4 — true when the hit is in the caller's OWN package (locality tiebreak). */
  local?: boolean;
}

export interface CodeFindResult {
  query: string;
  matches: CodeFindMatch[];
  freshness_badge: FreshnessBadge;
}

export interface CodeBriefInput extends CodeBackendContext {
  target: string;
  limit?: number;
  /** pln#631 — store traversal (same semantics as find): `auto` (default) aggregates
   *  the workspace when cwd is a multi-project root, else single-store. */
  traversal?: TraversalMode;
}

export interface CodeBriefReadEntry {
  path: string;
  reason: string;
  score: number;
  related_memory_ids: string[];
  /** pln#631 — set only on AGGREGATED briefs: the owning project (workspace-relative
   *  dir, `''` = root). `path` is workspace-root-relative when aggregating. */
  project?: string;
  /** pln#631 PR3 — true when this row is a cross-package importer (a sibling package
   *  importing the defining package's public name), not an intra-package graph row. */
  cross_package?: boolean;
  /** pln#631 PR4 — true when this row is in the caller's OWN package (locality tiebreak). */
  local?: boolean;
}

export interface CodeBriefRelatedMemory {
  id: string;
  kind: string;
  text: string;
  tags: string[];
  related_paths: string[];
}

export interface CodeBrief {
  target: string;
  suggested_files_to_read: CodeBriefReadEntry[];
  related_memory: CodeBriefRelatedMemory[];
  freshness_badge: FreshnessBadge;
}

/** spec §9 caps the brief reading list at 12 files. */
export const BRIEF_FILE_CAP = 12;

export interface CodeQueryBackend {
  status(input: CodeStatusInput): Promise<CodeStatus>;
  refresh(input: CodeRefreshInput): Promise<CodeRefreshResult>;
  find(input: CodeFindInput): Promise<CodeFindResult>;
  brief(input: CodeBriefInput): Promise<CodeBrief>;
}

function badge(status: FreshnessStatus, details: Record<string, unknown> = {}): FreshnessBadge {
  // pln#601 — stamp the coarse rollup at construction so every backend-built badge
  // (status, missing_index fallbacks, find/brief base) carries it uniformly.
  return withCoarse({ status, details });
}

/**
 * Read the working tree's current commit at `root` (read-path git-HEAD drift,
 * trp_42688015). Returns null on any failure or a non-git project (also detached
 * HEAD resolves to the commit sha, which is the correct comparison key) — a null
 * makes the comparison a no-op, preserving existing behaviour.
 *
 * COST (review finding, LOW): one synchronous `git rev-parse HEAD` per status/
 * find/brief call. These are interactive, human-/agent-paced reads (not a tight
 * loop), so a single ~5–15ms spawn is acceptable and keeps branch-switch detection
 * immediate. If this ever shows up on a profile, memoize per `root` behind a short
 * TTL (a few seconds) — short enough that a checkout is still caught promptly.
 */
function readCurrentGitHead(root: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** True when `cwd` is a multi-project workspace (gates the cascade paths). */
function isMultiProjectWorkspace(cwd?: string): boolean {
  try {
    return loadConfig(cwd).project_mode === 'multi-project';
  } catch {
    return false;
  }
}

/** Per-child store recap for `status(cascade)` in a multi-project workspace. */
function buildCascadeStatus(rootCwd?: string): NonNullable<CodeStatus['cascade']> {
  const root = rootCwd ?? process.cwd();
  const children: CodeStatusChild[] = listNestedProjects(root).map((abs) => {
    const m = readManifest(abs);
    return {
      path: path.relative(root, abs).replace(/\\/g, '/') || '.',
      store_exists: m ? true : storeExists(abs),
      freshness: m ? m.freshness.status : 'missing_index',
      files_indexed: m ? m.stats.files_indexed : null,
    };
  });
  const indexed = children.filter((c) => c.freshness !== 'missing_index').length;
  return { children, indexed_children: indexed, total_children: children.length };
}

/**
 * P0 JSONL-backed query backend. Reads the durable file store (manifest +
 * shards + indexes); no graph DB. find()/brief() are stubbed for Sprint 1.
 */
export class JsonlBackend implements CodeQueryBackend {
  /**
   * Related-memory read seam (spec §11). Defaults to the canonical entity read
   * path; tests inject an in-memory reader to assert attachment without a store.
   */
  private readonly memoryReader: MemoryReader;
  /** Read-path git-HEAD reader (injectable for tests). trp_42688015. */
  private readonly gitHeadReader: (root: string) => string | null;

  constructor(
    opts: { memoryReader?: MemoryReader; gitHeadReader?: (root: string) => string | null } = {},
  ) {
    this.memoryReader = opts.memoryReader ?? defaultMemoryReader;
    this.gitHeadReader = opts.gitHeadReader ?? readCurrentGitHead;
  }

  async status(input: CodeStatusInput): Promise<CodeStatus> {
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const result: CodeStatus = manifest
      ? {
        store_exists: true,
        freshness_badge: this.withHeadDrift(
          badge(manifest.freshness.status, {
            stale_file_count: manifest.freshness.stale_file_count,
            partial_reason: manifest.freshness.partial_reason,
          }),
          manifest,
          input.cwd,
        ),
        stats: {
          files_indexed: manifest.stats.files_indexed,
          nodes: manifest.stats.nodes,
          edges: manifest.stats.edges,
        },
      }
      : {
        store_exists: storeExists(input.cwd, input.preferredDirName),
        freshness_badge: badge('missing_index'),
        stats: null,
      };

    // Multi-project recap (opt-in): per-child store presence + freshness, so a
    // status at the monorepo root surfaces the 27-children-missing-index state
    // instead of just the (now child-scoped) root store. DGX Finding 2.
    if (input.cascade && isMultiProjectWorkspace(input.cwd)) {
      result.cascade = buildCascadeStatus(input.cwd);
    }
    return result;
  }

  /**
   * Real refresh (spec §7): resolves project identity (input -> manifest ->
   * cwd-derived default), then runs the Tree-sitter parse + index + materialize
   * pipeline behind the project lock. A live competing lock fails fast with a
   * clear status — refresh never blocks bclaw_work (rule 8).
   */
  async refresh(input: CodeRefreshInput): Promise<CodeRefreshResult> {
    const scope = input.scope ?? 'changed';

    // Multi-project cascade (opt-in): refresh every nested brainclaw project +
    // a child-scoped root store. No-op outside a multi-project workspace — fall
    // through to the normal single-project refresh below. DGX Finding 2.
    if (input.cascade && isMultiProjectWorkspace(input.cwd)) {
      const cascade = await refreshWorkspaceCascade({
        rootCwd: input.cwd ?? process.cwd(),
        scope,
        ownerAgent: input.ownerAgent ?? null,
        ownerAgentId: input.ownerAgentId ?? null,
      });
      const root = cascade.root_result;
      const allProjects = [root, ...cascade.children];
      // A cascade is only fully "acquired" when EVERY project got its lock; if a
      // child or the root was skipped under a live writer, surface that instead
      // of reporting a clean lock_acquired=true over a partial cascade (codex review).
      const skipped = allProjects.filter((p) => !p.lock_acquired);
      return {
        ran: allProjects.some((p) => p.ran),
        scope,
        lock_acquired: skipped.length === 0,
        freshness_badge: badge(root.freshness, {
          files_parsed: root.files_parsed,
          children_refreshed: cascade.children_refreshed,
        }),
        ...(skipped.length > 0
          ? { lock_status: `${skipped.length} project(s) skipped (lock held): ${skipped.map((p) => p.path).join(', ')}` }
          : {}),
        cascade,
      };
    }

    const manifest = readManifest(input.cwd, input.preferredDirName);
    const projectRoot = input.projectRoot ?? manifest?.project_root ?? input.cwd ?? process.cwd();
    const projectId =
      input.projectId ?? manifest?.project_id ?? `prj_${path.basename(path.resolve(projectRoot))}`;

    const result = await runRefresh({
      projectId,
      projectRoot,
      scope,
      cwd: input.cwd,
      preferredDirName: input.preferredDirName,
      ownerAgent: input.ownerAgent ?? null,
      ownerAgentId: input.ownerAgentId ?? null,
    });

    return {
      ran: result.ran,
      scope,
      lock_acquired: result.lock_acquired,
      freshness_badge: badge(result.freshness.status, {
        stale_file_count: result.freshness.stale_file_count,
        partial_reason: result.freshness.partial_reason,
        files_parsed: result.files_parsed,
        files_compacted: result.files_compacted,
        duration_ms: result.duration_ms,
      }),
      ...(result.lock_status ? { lock_status: result.lock_status } : {}),
    };
  }

  /**
   * Agent-facing symbol search (spec §12.1). Ranks symbols-index matches and
   * lazily validates each backing shard against the live file before serving it
   * as confident (§6.1); the response badge reflects any detected drift.
   */
  async find(input: CodeFindInput): Promise<CodeFindResult> {
    const cwd = input.cwd ?? process.cwd();
    const resolved = resolveTraversal(cwd, input.traversal ?? 'auto');
    if (resolved.workspace) {
      // pln#631 — root-aggregated find across the workspace's per-project stores.
      // git-HEAD drift is resolved ONCE at the workspace root (one working tree) and
      // compared PER STORE inside aggregateFind (review F3) — so a child whose index
      // lags the working tree is flagged even under an otherwise-fresh root.
      const currentHead = this.gitHeadReader(resolved.root);
      const agg = aggregateFind(input.query, input.limit, resolved, currentHead);
      return {
        query: agg.query,
        matches: agg.matches,
        freshness_badge: agg.freshness_badge,
      };
    }
    const ctx = this.queryContext(input);
    const out = runFind(input.query, input.limit, ctx);
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const base: FreshnessBadge = badge(out.freshness_badge.status, out.freshness_badge.details);
    return {
      query: out.query,
      matches: out.matches,
      freshness_badge: this.withHeadDrift(base, manifest, input.cwd),
    };
  }

  /**
   * Agent-facing reading list (spec §9, §11). Produces a ranked
   * suggested_files_to_read (cap 12), attaches related brainclaw memory (cap 5),
   * and carries a §6.1 lazy-validated freshness badge.
   */
  async brief(input: CodeBriefInput): Promise<CodeBrief> {
    const cwd = input.cwd ?? process.cwd();
    const resolved = resolveTraversal(cwd, input.traversal ?? 'auto');
    if (resolved.workspace) {
      // pln#631 PR2 — root-aggregated brief across the per-project stores (per-store
      // HEAD drift resolved against ONE workspace HEAD, like aggregateFind).
      const currentHead = this.gitHeadReader(resolved.root);
      const agg = aggregateBrief(input.target, input.limit, resolved, currentHead, this.memoryReader);
      return {
        target: agg.target,
        suggested_files_to_read: agg.suggested_files_to_read,
        related_memory: agg.related_memory,
        freshness_badge: agg.freshness_badge,
      };
    }
    const ctx = this.queryContext(input);
    const out = runBrief(input.target, input.limit, ctx, this.memoryReader);
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const base: FreshnessBadge = badge(out.freshness_badge.status, out.freshness_badge.details);
    return {
      target: out.target,
      suggested_files_to_read: out.suggested_files_to_read,
      related_memory: out.related_memory,
      freshness_badge: this.withHeadDrift(base, manifest, input.cwd),
    };
  }

  /**
   * Annotate a read badge with git-HEAD drift vs the commit the index was built
   * against (`manifest.git.head`). trp_42688015 — a branch switch (whole-tree move)
   * is otherwise unflagged because `status` reads only write-side freshness and the
   * per-file lazy check is query-scoped + budgeted. No-op for non-git projects.
   */
  private withHeadDrift(
    base: FreshnessBadge,
    manifest: Manifest | null,
    cwd: string | undefined,
  ): FreshnessBadge {
    if (!manifest) return base;
    const root = manifest.project_root || cwd || process.cwd();
    return applyGitHeadDrift(base, manifest.git.head, this.gitHeadReader(root));
  }

  private queryContext(input: CodeBackendContext): QueryContext {
    return { cwd: input.cwd, preferredDirName: input.preferredDirName };
  }
}
