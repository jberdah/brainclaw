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
  if (agent.has_open_session || (agent.claim_count ?? 0) > 0) return 'active';
  if (!agent.last_active) return 'stale';
  const hours = (Date.now() - new Date(agent.last_active).getTime()) / 3600000;
  if (hours < 1) return 'active';
  if (hours < 6) return 'idle';
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
