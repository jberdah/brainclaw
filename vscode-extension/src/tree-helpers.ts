/**
 * Pure helpers extracted from board-tree.ts so they can be unit-tested without
 * pulling in the vscode module. Keep this file free of vscode imports.
 *
 * pln#393 stp_92cd2775.
 */

export type Freshness = 'active' | 'idle' | 'stale';

export const STALE_MS = {
  plan: 7 * 24 * 60 * 60 * 1000,
  claim: 4 * 60 * 60 * 1000,
  assignment: 30 * 60 * 1000,
  action: 60 * 60 * 1000,
} as const;

export function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function priorityLetter(value: string | undefined | null): string {
  switch (String(value ?? '').toLowerCase()) {
    case 'urgent': return 'U';
    case 'high': return 'H';
    case 'medium': return 'M';
    case 'low': return 'L';
    default: return '·';
  }
}

export function formatRelativeAge(isoDate: string): string {
  const diff = Date.now() - Date.parse(isoDate);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${days}d ago`;
}

export function isStale(isoDate: string | undefined, thresholdMs: number): boolean {
  if (!isoDate) return false;
  return Date.now() - Date.parse(isoDate) > thresholdMs;
}

export function agentFreshness(agent: { has_open_session?: boolean; claim_count?: number; last_active?: string }): Freshness {
  // pln#559 step 5 — evidence-based roster freshness. The previous rule
  // ("claim_count > 0 → active") forced a green dot on a crashed worker that
  // never released its claims (the 2026-06-10 silent_death pattern). Liveness
  // is now derived from last_active: a session/claim only counts as
  // confirming activity when last_active is recent. Otherwise the row
  // degrades to idle/stale based on age, even with a session left open and
  // claims dangling.
  const lastActiveMs = agent.last_active ? Date.now() - new Date(agent.last_active).getTime() : undefined;
  if (lastActiveMs === undefined) return 'stale';
  const hours = lastActiveMs / 3600000;
  if (hours < 1) return 'active';
  // A held session OR held claim with last_active in the 1–6h band keeps the
  // row at 'idle' rather than collapsing to 'stale' — the agent had real
  // work in flight before going quiet.
  if (hours < 6) {
    return (agent.has_open_session || (agent.claim_count ?? 0) > 0) ? 'idle' : 'idle';
  }
  return 'stale';
}

/**
 * A candidate is "auto" when the server marked it so (source=auto) OR when its
 * origin is a session-end handoff. The server-side `source` field is the
 * authoritative signal; `origin` is kept as a legacy fallback for candidates
 * predating the source field (pln_3fe7fbb3).
 */
export function isAutoCandidate(candidate: { source?: string; origin?: string }): boolean {
  return candidate.source === 'auto' || String(candidate.origin ?? '').startsWith('session-end');
}

/**
 * Server-imposed page cap for board-tree pagination follow-ups.
 *
 * Why: bclaw_find size-bounds each page to ~40k chars (DEFAULT_FIND_CHAR_BUDGET,
 * pln#491) and plan lists sort oldest-first (state.ts:151). A single call
 * therefore truncates recent items silently — the operator saw the Backlog stuck
 * on old plans and never noticed the new ones (trp#925). The pager below walks
 * has_more/next_offset; MAX_PAGES caps the walk so a runaway server (or a
 * pathological filter) can't spin the tree forever.
 */
export const FIND_MAX_PAGES = 5;

interface FindPagerClient {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Walk bclaw_find pages until has_more=false or MAX_PAGES is reached, and
 * concatenate the items. The initial filter is preserved across pages; only
 * `offset` is threaded from the previous response's `next_offset`.
 */
export async function paginatedFind<T = unknown>(
  client: FindPagerClient,
  entity: string,
  filter: Record<string, unknown> = {},
  maxPages: number = FIND_MAX_PAGES,
): Promise<T[]> {
  const items: T[] = [];
  let currentFilter: Record<string, unknown> = { ...filter };
  for (let page = 0; page < maxPages; page++) {
    const result = await client.callTool('bclaw_find', { entity, filter: currentFilter });
    if (Array.isArray(result.items)) items.push(...(result.items as T[]));
    if (!result.has_more) return items;
    const nextOffset = result.next_offset;
    if (typeof nextOffset !== 'number') return items;
    currentFilter = { ...currentFilter, offset: nextOffset };
  }
  return items;
}
