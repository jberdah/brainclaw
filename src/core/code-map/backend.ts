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
import { readManifest, readShard, storeExists } from './store.js';
import { refresh as runRefresh } from './refresh.js';
import { applyGitHeadDrift, withFreshness } from './freshness.js';
import { brief as runBrief, find as runFind, type MemoryReader, type QueryContext, type RelatedMemoryItem } from './query.js';
import { impact as runImpact, type CodeImpactOutput } from './impact.js';
import { exportSubgraph, type CodeGraphExportOutput, type CodeGraphExportOptions } from './export.js';
import { fileId } from './ids.js';
import { resolveTraversal, aggregateFind, aggregateBrief, type TraversalMode } from './aggregate.js';
import { defaultMemoryReader } from './memory-reader.js';
import { listNestedProjects, refreshWorkspaceCascade, type CascadeResult } from './cascade.js';
import { loadConfig } from '../config.js';
import { codeMapDir } from './paths.js';
import type { FreshnessBadge, FreshnessStatus, Manifest, ParseStatus, Span } from './types.js';

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
  /** Exact paths used for this answer; lets operators compare CLI and MCP. */
  resolution: {
    project_root: string;
    store_path: string;
  };
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

export interface CodeImpactInput extends CodeBackendContext {
  /** Symbol name or source-file path whose resolved blast radius to inspect. */
  target: string;
  /** Maximum graph distance: 1 is direct only; 2+ opts into transitives (capped at 4). */
  depth?: number;
  /** Per-section response cap for direct, transitive, and naming-suggestion rows (capped at 100). */
  limit?: number;
}

/** Bounded local graph projection; does not aggregate or export a workspace graph. */
export interface CodeExportInput extends CodeBackendContext, CodeGraphExportOptions {
  /** Required symbol name or source-file path around which to select the subgraph. */
  target: string;
}

export type CodeExportResult = CodeGraphExportOutput;

export type CodeImpactResult = CodeImpactOutput;

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

/** Keeps response-visible join evidence/freshness in sync with `code_brief`. */
export type CodeBriefRelatedMemory = RelatedMemoryItem;

export interface CodeBrief {
  target: string;
  suggested_files_to_read: CodeBriefReadEntry[];
  related_memory: CodeBriefRelatedMemory[];
  freshness_badge: FreshnessBadge;
}

/** spec §9 caps the brief reading list at 12 files. */
export const BRIEF_FILE_CAP = 12;

/**
 * Agent-facing file outline (P2b). The symbol count is deliberately bounded:
 * an outline is a navigation aid, not a replacement for opening a generated
 * source file. `symbol_count` always records the complete indexed count.
 */
export const OUTLINE_SYMBOL_CAP = 200;

/** Diagnostics are useful context, but unbounded provider facts are not. */
export const OUTLINE_DIAGNOSTIC_CAP = 20;

export interface CodeOutlineInput extends CodeBackendContext {
  /** Workspace-relative source path, or an absolute path under the project root. */
  path: string;
  /** Optional caller cap, clamped to {@link OUTLINE_SYMBOL_CAP}. */
  limit?: number;
}

export interface CodeOutlineSymbol {
  name: string;
  kind: string;
  subtype: string | null;
  span: Span | null;
  exported: boolean;
  /** Extractor confidence retained from the persisted symbol node, never recomputed here. */
  confidence: number;
}

/** Separates no Code Map index from a known indexed file with no symbols. */
export type CodeOutlineIndexStatus = 'missing_index' | 'file_not_indexed' | 'indexed';

export interface CodeOutlineResult {
  /** Normalized, project-relative source path used to address the shard. */
  path: string;
  /** `indexed` includes a parsed shard whose `symbols` array is empty. */
  index_status: CodeOutlineIndexStatus;
  file_indexed: boolean;
  parse_status: ParseStatus | null;
  /** Complete symbol count before the response cap is applied. */
  symbol_count: number;
  symbols: CodeOutlineSymbol[];
  truncated: boolean;
  diagnostics: unknown[];
  diagnostics_truncated: boolean;
  freshness_badge: FreshnessBadge;
}
export interface CodeQueryBackend {
  status(input: CodeStatusInput): Promise<CodeStatus>;
  refresh(input: CodeRefreshInput): Promise<CodeRefreshResult>;
  find(input: CodeFindInput): Promise<CodeFindResult>;
  brief(input: CodeBriefInput): Promise<CodeBrief>;
  impact(input: CodeImpactInput): Promise<CodeImpactResult>;
  exportGraph(input: CodeExportInput): Promise<CodeExportResult>;
  outline(input: CodeOutlineInput): Promise<CodeOutlineResult>;
}

function badge(status: FreshnessStatus, details: Record<string, unknown> = {}): FreshnessBadge {
  // pln#601 — build the uniform freshness envelope for every backend surface
  // It always includes index and spot-check details.
  return withFreshness({ status, details });
}
/**
 * Convert a user path into the POSIX project-relative identity used by shards.
 * This is pure path arithmetic: outline must not stat, parse, or otherwise touch
 * the live source file on its read path.
 */
function normalizeOutlinePath(requestedPath: string, projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, requestedPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.replace(/\\/g, '/');
}

function outlineLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return OUTLINE_SYMBOL_CAP;
  return Math.min(Math.max(Math.floor(limit), 0), OUTLINE_SYMBOL_CAP);
}

function compareOutlineSymbols(a: CodeOutlineSymbol & { node_id: string }, b: CodeOutlineSymbol & { node_id: string }): number {
  // Symbols normally always have spans. Keep malformed/legacy span-less nodes
  // deterministic and at the end instead of trusting shard append order.
  const as = a.span;
  const bs = b.span;
  if (as && bs) {
    return as.start_line - bs.start_line
      || as.start_col - bs.start_col
      || as.end_line - bs.end_line
      || as.end_col - bs.end_col
      || a.name.localeCompare(b.name)
      || a.node_id.localeCompare(b.node_id);
  }
  if (as) return -1;
  if (bs) return 1;
  return a.name.localeCompare(b.name) || a.node_id.localeCompare(b.node_id);
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
    const projectRoot = path.resolve(input.cwd ?? process.cwd());
    const resolution = {
      project_root: projectRoot,
      store_path: codeMapDir(projectRoot, input.preferredDirName),
    };
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const result: CodeStatus = manifest
      ? {
        store_exists: true,
        resolution,
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
        resolution,
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
   * Explain a target's resolved blast radius. Unlike brief(), this deliberately
   * stays store-local: impact only traverses persisted P1c/P1d edges and reports
   * their concrete causes, with an opt-in bounded transitive walk.
   */
  async impact(input: CodeImpactInput): Promise<CodeImpactResult> {
    const ctx = this.queryContext(input);
    const out = runImpact(input.target, { depth: input.depth, limit: input.limit }, ctx);
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const base: FreshnessBadge = badge(out.freshness_badge.status, out.freshness_badge.details);
    return {
      ...out,
      freshness_badge: this.withHeadDrift(base, manifest, input.cwd),
    };
  }

  /**
   * Export only a caller-selected, hard-bounded local graph. This stays
   * store-local even at a multi-project root: implicit workspace graph dumps
   * are intentionally unsupported.
   */
  async exportGraph(input: CodeExportInput): Promise<CodeExportResult> {
    const ctx = this.queryContext(input);
    const out = exportSubgraph(input.target, input, ctx);
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const base: FreshnessBadge = badge(out.freshness_badge.status, out.freshness_badge.details);
    return {
      ...out,
      freshness_badge: this.withHeadDrift(base, manifest, input.cwd),
    };
  }

  /**
   * Return an indexed file's symbols in source order. This reads exactly one
   * manifest and one deterministic shard; it never calls refresh, extractor, or
   * the lazy live-file validator, so the response is a snapshot of the index.
   */
  async outline(input: CodeOutlineInput): Promise<CodeOutlineResult> {
    const cwd = input.cwd ?? process.cwd();
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const root = manifest?.project_root ?? cwd;
    const normalizedPath = normalizeOutlinePath(input.path.trim(), root) ?? input.path.trim().replace(/\\/g, '/');
    const missing = (): CodeOutlineResult => ({
      path: normalizedPath,
      index_status: 'missing_index',
      file_indexed: false,
      parse_status: null,
      symbol_count: 0,
      symbols: [],
      truncated: false,
      diagnostics: [],
      diagnostics_truncated: false,
      freshness_badge: badge('missing_index', { hint: 'run refresh' }),
    });
    if (!manifest || manifest.freshness.status === 'missing_index') return missing();

    const freshnessBadge = this.withHeadDrift(
      badge(manifest.freshness.status, {
        stale_file_count: manifest.freshness.stale_file_count,
        partial_reason: manifest.freshness.partial_reason,
      }),
      manifest,
      input.cwd,
    );
    const safePath = normalizeOutlinePath(input.path.trim(), root);
    if (!safePath) {
      return {
        ...missing(),
        index_status: 'file_not_indexed',
        freshness_badge: freshnessBadge,
      };
    }

    const shard = readShard(fileId(manifest.project_id, safePath), input.cwd, input.preferredDirName);
    if (!shard || shard.path !== safePath) {
      return {
        path: safePath,
        index_status: 'file_not_indexed',
        file_indexed: false,
        parse_status: null,
        symbol_count: 0,
        symbols: [],
        truncated: false,
        diagnostics: [],
        diagnostics_truncated: false,
        freshness_badge: freshnessBadge,
      };
    }

    const allSymbols = shard.nodes
      .filter((node) => node.kind === 'symbol')
      .map((node) => ({
        node_id: node.id,
        name: node.name,
        kind: node.kind,
        subtype: node.subtype ?? null,
        span: node.span ?? null,
        exported: node.exported,
        confidence: node.confidence,
      }))
      .sort(compareOutlineSymbols);
    const limit = outlineLimit(input.limit);
    const diagnostics = shard.diagnostics.slice(0, OUTLINE_DIAGNOSTIC_CAP);

    return {
      path: safePath,
      index_status: 'indexed',
      file_indexed: true,
      parse_status: shard.parse_status,
      symbol_count: allSymbols.length,
      symbols: allSymbols.slice(0, limit).map(({ node_id: _nodeId, ...symbol }) => symbol),
      truncated: allSymbols.length > limit,
      diagnostics,
      diagnostics_truncated: shard.diagnostics.length > diagnostics.length,
      freshness_badge: freshnessBadge,
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
