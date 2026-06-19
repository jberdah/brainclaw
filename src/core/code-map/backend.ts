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
import { readManifest, storeExists } from './store.js';
import { acquireCodeLock, releaseCodeLock } from './lock.js';
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
  kind: string;
  subtype: string | null;
  score: number;
}

export interface CodeFindResult {
  query: string;
  matches: CodeFindMatch[];
  freshness_badge: FreshnessBadge;
  not_implemented?: boolean;
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

export interface CodeBrief {
  target: string;
  suggested_files_to_read: CodeBriefReadEntry[];
  freshness_badge: FreshnessBadge;
  not_implemented?: boolean;
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
   * Minimal real refresh: acquires the lock (returning a clear lock status if a
   * live competitor holds it), then releases. Parse/index work lands in later
   * sprints. Never blocks indefinitely — a held live lock fails fast.
   */
  async refresh(input: CodeRefreshInput): Promise<CodeRefreshResult> {
    const scope = input.scope ?? 'changed';
    const handle = acquireCodeLock({
      cwd: input.cwd,
      preferredDirName: input.preferredDirName,
      operation: 'refresh',
      scope,
      ownerAgent: input.ownerAgent ?? null,
      ownerAgentId: input.ownerAgentId ?? null,
    });

    if (!handle) {
      return {
        ran: false,
        scope,
        lock_acquired: false,
        freshness_badge: badge('partial', { reason: 'lock_held_by_live_writer' }),
        lock_status: 'held_by_live_writer',
      };
    }

    try {
      const manifest = readManifest(input.cwd, input.preferredDirName);
      const status: FreshnessStatus = manifest ? manifest.freshness.status : 'missing_index';
      // Parse loop / index rebuild / compaction: deferred to later sprints.
      return {
        ran: true,
        scope,
        lock_acquired: true,
        freshness_badge: badge(status, { note: 'refresh_stub_no_parse_yet' }),
      };
    } finally {
      releaseCodeLock(handle);
    }
  }

  async find(input: CodeFindInput): Promise<CodeFindResult> {
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const status: FreshnessStatus = manifest ? manifest.freshness.status : 'missing_index';
    return {
      query: input.query,
      matches: [],
      freshness_badge: badge(status, { note: 'find_not_implemented_in_sprint1' }),
      not_implemented: true,
    };
  }

  async brief(input: CodeBriefInput): Promise<CodeBrief> {
    const manifest = readManifest(input.cwd, input.preferredDirName);
    const status: FreshnessStatus = manifest ? manifest.freshness.status : 'missing_index';
    return {
      target: input.target,
      suggested_files_to_read: [],
      freshness_badge: badge(status, { note: 'brief_not_implemented_in_sprint1' }),
      not_implemented: true,
    };
  }
}
