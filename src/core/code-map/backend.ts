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
import path from 'node:path';
import { readManifest, storeExists } from './store.js';
import { refresh as runRefresh } from './refresh.js';
import { brief as runBrief, find as runFind, type MemoryReader, type QueryContext } from './query.js';
import { defaultMemoryReader } from './memory-reader.js';
import type { FreshnessBadge, FreshnessStatus } from './types.js';

// --- Input / output types (spec §8, §9) ---

export interface CodeBackendContext {
  cwd?: string;
  preferredDirName?: string;
}

export interface CodeStatusInput extends CodeBackendContext {}

export interface CodeStatus {
  store_exists: boolean;
  freshness_badge: FreshnessBadge;
  stats: {
    files_indexed: number;
    nodes: number;
    edges: number;
  } | null;
}

export interface CodeRefreshInput extends CodeBackendContext {
  scope?: 'changed' | 'all';
  ownerAgent?: string | null;
  ownerAgentId?: string | null;
  /** Project identity. Falls back to the manifest, then a cwd-derived default. */
  projectId?: string;
  /** Source root to enumerate. Falls back to the manifest, then cwd. */
  projectRoot?: string;
}

export interface CodeRefreshResult {
  ran: boolean;
  scope: 'changed' | 'all';
  lock_acquired: boolean;
  freshness_badge: FreshnessBadge;
  /** Present when the lock was held by a live competitor (spec §6 rule 7/12.3). */
  lock_status?: string;
}

export interface CodeFindInput extends CodeBackendContext {
  query: string;
  limit?: number;
}

export interface CodeFindMatch {
  node_id: string;
  name: string;
  path: string;
  file_id: string;
  kind: string;
  subtype: string | null;
  score: number;
}

export interface CodeFindResult {
  query: string;
  matches: CodeFindMatch[];
  freshness_badge: FreshnessBadge;
}

export interface CodeBriefInput extends CodeBackendContext {
  target: string;
  limit?: number;
}

export interface CodeBriefReadEntry {
  path: string;
  reason: string;
  score: number;
  related_memory_ids: string[];
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
  return { status, details };
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

  constructor(opts: { memoryReader?: MemoryReader } = {}) {
    this.memoryReader = opts.memoryReader ?? defaultMemoryReader;
  }

  async status(input: CodeStatusInput): Promise<CodeStatus> {
    const manifest = readManifest(input.cwd, input.preferredDirName);
    if (!manifest) {
      return {
        store_exists: storeExists(input.cwd, input.preferredDirName),
        freshness_badge: badge('missing_index'),
        stats: null,
      };
    }
    return {
      store_exists: true,
      freshness_badge: badge(manifest.freshness.status, {
        stale_file_count: manifest.freshness.stale_file_count,
        partial_reason: manifest.freshness.partial_reason,
      }),
      stats: {
        files_indexed: manifest.stats.files_indexed,
        nodes: manifest.stats.nodes,
        edges: manifest.stats.edges,
      },
    };
  }

  /**
   * Real refresh (spec §7): resolves project identity (input -> manifest ->
   * cwd-derived default), then runs the Tree-sitter parse + index + materialize
   * pipeline behind the project lock. A live competing lock fails fast with a
   * clear status — refresh never blocks bclaw_work (rule 8).
   */
  async refresh(input: CodeRefreshInput): Promise<CodeRefreshResult> {
    const scope = input.scope ?? 'changed';
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
    const ctx = this.queryContext(input);
    const out = runFind(input.query, input.limit, ctx);
    return {
      query: out.query,
      matches: out.matches,
      freshness_badge: { status: out.freshness_badge.status, details: out.freshness_badge.details },
    };
  }

  /**
   * Agent-facing reading list (spec §9, §11). Produces a ranked
   * suggested_files_to_read (cap 12), attaches related brainclaw memory (cap 5),
   * and carries a §6.1 lazy-validated freshness badge.
   */
  async brief(input: CodeBriefInput): Promise<CodeBrief> {
    const ctx = this.queryContext(input);
    const out = runBrief(input.target, input.limit, ctx, this.memoryReader);
    return {
      target: out.target,
      suggested_files_to_read: out.suggested_files_to_read,
      related_memory: out.related_memory,
      freshness_badge: { status: out.freshness_badge.status, details: out.freshness_badge.details },
    };
  }

  private queryContext(input: CodeBackendContext): QueryContext {
    return { cwd: input.cwd, preferredDirName: input.preferredDirName };
  }
}
