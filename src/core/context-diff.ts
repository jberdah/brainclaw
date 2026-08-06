import fs from 'node:fs';
import { readAuditLog } from './audit.js';
import { listCandidates } from './candidates.js';
import { entityRecordPaths } from './io.js';
import { loadVersionedJsonFile } from './migration.js';
import { buildNotificationSummary, hasEventCursor, readUnseenEvents, seedCursorToEnd, type MemoryEvent } from './event-log.js';
import { SessionSnapshotSchema, type SessionSnapshot } from './schema.js';
import { loadState } from './state.js';

type DiffSection = 'constraint' | 'decision' | 'trap' | 'handoff' | 'candidate' | 'plan';

export interface ContextDiffItem {
  section: DiffSection;
  id: string;
  text: string;
  created_at: string;
  /** What happened since the caller last looked (event-cursor source only). */
  action?: 'created' | 'updated' | 'deleted' | 'accepted' | 'rejected';
}

export interface ContextDiffResult {
  since?: string;
  since_session?: string;
  /**
   * Reference point: per-agent event-log cursor (default), explicit
   * timestamp/session, or the first-contact arrival digest (curated active
   * state instead of an event replay; the cursor is seeded at log end).
   */
  source?: 'event_cursor' | 'timestamp' | 'arrival_digest';
  summary: string;
  counts: {
    constraints: number;
    decisions: number;
    traps: number;
    handoffs: number;
    plans: number;
    pending_candidates: number;
    total: number;
  };
  changed_items?: ContextDiffItem[];
  /** action:item_type histogram over ALL unseen events (incl. claims/sessions) — event-cursor source only. */
  event_summary?: Record<string, number>;
  unseen_event_count?: number;
}

export interface BuildContextDiffOptions {
  since?: string;
  session?: string;
  cwd?: string;
  includeItems?: boolean;
}

export function resolveContextDiffSince(options: Pick<BuildContextDiffOptions, 'since' | 'session' | 'cwd'>): {
  since?: string;
  since_session?: string;
} {
  if (options.since) {
    return { since: options.since };
  }

  if (options.session) {
    const snapshot = loadSessionSnapshot(options.session, options.cwd);
    if (snapshot?.started_at) {
      return { since: snapshot.started_at, since_session: options.session };
    }

    const sessionEntry = readAuditLog({ action: 'session_start', itemId: options.session }, options.cwd)[0];
    if (sessionEntry?.timestamp) {
      return { since: sessionEntry.timestamp, since_session: options.session };
    }

    return { since_session: options.session };
  }

  // No global marker fallback: the "what's new" default lives on the
  // per-agent event-log cursors (buildContextDiffFromEvents). The store-global
  // .last-context marker cross-contaminated agents — one agent's read reset
  // everyone's diff baseline.
  return {};
}

/**
 * THE LAST BY-ID SITE THAT COULD ACTUALLY FIRE, and the only one with live two-layout
 * data in the field: this store holds 173 sessions in the legacy layout next to 1019
 * canonical ones (dec#153-T2's dual write). `resolveEntityDir(..., 'read')` answers a
 * DIRECTORY question with a `hasContent` heuristic, so one canonical file made every
 * legacy record invisible — the same malformed abstraction pln#649 removed from the
 * entity locator and the by-id loaders, still here because nothing routed sessions.
 *
 * The consequence was a SILENT WRONG ANSWER, which is why this one was worth fixing
 * while the sibling sites were not: an invisible snapshot falls through to the audit-log
 * scan, and if that misses too `resolveContextDiffSince` returns no `since`, so
 * `buildContextDiff` returns undefined and the caller is told "no changes" over a window
 * where there were changes. An agent cannot tell that apart from a quiet period.
 *
 * Uses the shared primitive rather than a fourth hand-rolled pair of paths (io.ts).
 */
function loadSessionSnapshot(sessionId: string, cwd?: string): SessionSnapshot | undefined {
  for (const snapshotPath of entityRecordPaths('sessions', sessionId, cwd ?? process.cwd())) {
    if (!fs.existsSync(snapshotPath)) continue;
    try {
      return SessionSnapshotSchema.parse(loadVersionedJsonFile<SessionSnapshot>('session_snapshot', snapshotPath).document);
    } catch {
      // An unparseable record in one layout must not mask a good one in the other.
      continue;
    }
  }
  return undefined;
}

export function buildContextDiff(options: BuildContextDiffOptions = {}): ContextDiffResult | undefined {
  const resolved = resolveContextDiffSince(options);
  if (!resolved.since) {
    return undefined;
  }

  const state = loadState(options.cwd);
  const pendingCandidates = listCandidates('pending', options.cwd).filter((item) => item.created_at >= resolved.since!);
  const constraints = state.active_constraints.filter((item) => item.created_at >= resolved.since!);
  const decisions = state.recent_decisions.filter((item) => item.created_at >= resolved.since!);
  const traps = state.known_traps.filter((item) => item.created_at >= resolved.since!);
  const handoffs = state.open_handoffs.filter((item) => item.created_at >= resolved.since!);

  const changedItems = options.includeItems
    ? [
        ...constraints.map((item) => toChangedItem('constraint', item)),
        ...decisions.map((item) => toChangedItem('decision', item)),
        ...traps.map((item) => toChangedItem('trap', item)),
        ...handoffs.map((item) => toChangedItem('handoff', item)),
        ...pendingCandidates.map((item) => toChangedItem('candidate', item)),
      ].sort((a, b) => b.created_at.localeCompare(a.created_at))
    : undefined;

  const counts = {
    constraints: constraints.length,
    decisions: decisions.length,
    traps: traps.length,
    handoffs: handoffs.length,
    plans: 0,
    pending_candidates: pendingCandidates.length,
    total: constraints.length + decisions.length + traps.length + handoffs.length + pendingCandidates.length,
  };

  return {
    since: resolved.since,
    since_session: resolved.since_session,
    source: 'timestamp',
    summary: buildContextDiffSummary(counts),
    counts,
    changed_items: changedItems,
  };
}

const EVENT_SECTION_BY_ITEM_TYPE: Record<string, DiffSection> = {
  constraint: 'constraint',
  decision: 'decision',
  trap: 'trap',
  handoff: 'handoff',
  candidate: 'candidate',
  plan: 'plan',
};

const EVENT_ACTION_LABEL: Record<string, NonNullable<ContextDiffItem['action']>> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  accept: 'accepted',
  reject: 'rejected',
};

/**
 * Build a per-agent "what's new" diff from the event-log cursors
 * (src/core/event-log.ts). This is the converged novelty mechanism: it
 * replaces the store-global .last-context marker for the default diff path
 * and natively covers status transitions (logged as `update` events by
 * bclaw_transition / bclaw_update via the audit→event bridge).
 *
 * NOTE: reading ADVANCES the agent's cursor — events surfaced here are
 * considered seen. Returns undefined when there is nothing new.
 *
 * First contact (no cursor for this agent yet): the diff would otherwise
 * replay the ENTIRE event log from genesis — on a mature store that means
 * thousands of stale claim/session events summarized into noise, and the
 * agent's single chance to triage history is consumed by the cursor advance.
 * Instead we emit a curated arrival digest (active constraints/traps,
 * in-progress plans, latest open handoffs) and seed the cursor at log end so
 * subsequent diffs are genuinely incremental.
 */
export function buildContextDiffFromEvents(agent: string, cwd?: string, options: { includeItems?: boolean } = {}): ContextDiffResult | undefined {
  if (!hasEventCursor(agent, cwd)) {
    return buildArrivalDigest(agent, cwd, options);
  }
  const events = readUnseenEvents(agent, cwd);
  if (events.length === 0) {
    return undefined;
  }

  // Latest relevant event per item (an item created then updated counts once).
  const latestByItem = new Map<string, MemoryEvent>();
  for (const event of events) {
    if (!event.item_id) continue;
    if (!EVENT_SECTION_BY_ITEM_TYPE[event.item_type] || !EVENT_ACTION_LABEL[event.action]) continue;
    latestByItem.set(event.item_id, event);
  }

  const state = loadState(cwd);
  const pendingCandidates = listCandidates('pending', cwd);
  const textById = new Map<string, { text: string; created_at: string }>();
  for (const collection of [state.active_constraints, state.recent_decisions, state.known_traps, state.open_handoffs, state.plan_items, pendingCandidates]) {
    for (const item of collection as Array<{ id: string; text: string; created_at: string }>) {
      textById.set(item.id, { text: item.text, created_at: item.created_at });
    }
  }

  const counts = { constraints: 0, decisions: 0, traps: 0, handoffs: 0, plans: 0, pending_candidates: 0, total: 0 };
  const sectionToCountKey: Record<DiffSection, keyof typeof counts> = {
    constraint: 'constraints',
    decision: 'decisions',
    trap: 'traps',
    handoff: 'handoffs',
    plan: 'plans',
    candidate: 'pending_candidates',
  };

  const changedItems: ContextDiffItem[] = [];
  for (const [itemId, event] of latestByItem) {
    const section = EVENT_SECTION_BY_ITEM_TYPE[event.item_type];
    const current = textById.get(itemId);
    counts[sectionToCountKey[section]] += 1;
    counts.total += 1;
    changedItems.push({
      section,
      id: itemId,
      text: current?.text ?? event.summary ?? `(${EVENT_ACTION_LABEL[event.action]} — no longer in state)`,
      created_at: event.ts,
      action: EVENT_ACTION_LABEL[event.action],
    });
  }
  changedItems.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const oldest = events[0]?.ts;
  return {
    since: oldest,
    source: 'event_cursor',
    summary: buildContextDiffSummary(counts),
    counts,
    changed_items: options.includeItems === false ? undefined : changedItems,
    event_summary: buildNotificationSummary(events),
    unseen_event_count: events.length,
  };
}

/** Hard cap on arrival-digest items — the digest informs, it must not drown. */
const ARRIVAL_DIGEST_MAX_ITEMS = 12;
const ARRIVAL_DIGEST_MAX_HANDOFFS = 3;

/**
 * First-contact digest for an agent arriving on a store it has never read.
 * Curated active state (constraints, traps, in-progress plans, latest open
 * handoffs) instead of an event-log replay; seeds the agent's cursor at the
 * end of the log so the next diff is incremental. Returns undefined only when
 * there is nothing to say (empty store with no event history) — that case is
 * the bootstrap hint's job, not the diff's.
 */
export function buildArrivalDigest(agent: string, cwd?: string, options: { includeItems?: boolean } = {}): ContextDiffResult | undefined {
  const skippedBytes = seedCursorToEnd(agent, cwd);
  const state = loadState(cwd);

  const constraints = state.active_constraints.filter((item) => (item.status ?? 'active') === 'active');
  const traps = state.known_traps.filter((item) => (item.status ?? 'active') === 'active');
  const plans = state.plan_items.filter((item) => item.status === 'in_progress');
  const handoffs = state.open_handoffs
    .filter((item) => (item.status ?? 'open') === 'open')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, ARRIVAL_DIGEST_MAX_HANDOFFS);

  const counts = {
    constraints: constraints.length,
    decisions: 0,
    traps: traps.length,
    handoffs: handoffs.length,
    plans: plans.length,
    pending_candidates: 0,
    total: constraints.length + traps.length + plans.length + handoffs.length,
  };

  if (counts.total === 0 && skippedBytes === 0) {
    return undefined;
  }

  const changedItems = [
    ...constraints.map((item) => toChangedItem('constraint', item)),
    ...traps.map((item) => toChangedItem('trap', item)),
    ...plans.map((item) => toChangedItem('plan', item)),
    ...handoffs.map((item) => toChangedItem('handoff', item)),
  ].slice(0, ARRIVAL_DIGEST_MAX_ITEMS);

  const skippedKb = Math.round(skippedBytes / 1024);
  const stateSummary = counts.total > 0 ? buildContextDiffSummary(counts) : 'no active items';
  const summary = `First contact — arrival digest: ${stateSummary}. Event history skipped (${skippedKb} KB); cursor initialized at log end, future diffs are incremental.`;

  return {
    source: 'arrival_digest',
    summary,
    counts,
    changed_items: options.includeItems === false ? undefined : changedItems,
  };
}

export function buildContextDiffSummary(counts: ContextDiffResult['counts']): string {
  if (counts.total === 0) {
    return 'No memory changes detected';
  }

  const parts: string[] = [];
  if (counts.constraints > 0) parts.push(`${counts.constraints} constraint${counts.constraints > 1 ? 's' : ''}`);
  if (counts.decisions > 0) parts.push(`${counts.decisions} decision${counts.decisions > 1 ? 's' : ''}`);
  if (counts.traps > 0) parts.push(`${counts.traps} trap${counts.traps > 1 ? 's' : ''}`);
  if (counts.handoffs > 0) parts.push(`${counts.handoffs} handoff${counts.handoffs > 1 ? 's' : ''}`);
  if (counts.plans > 0) parts.push(`${counts.plans} plan${counts.plans > 1 ? 's' : ''}`);
  if (counts.pending_candidates > 0) parts.push(`${counts.pending_candidates} pending candidate${counts.pending_candidates > 1 ? 's' : ''}`);
  return parts.join(', ');
}

function toChangedItem(
  section: DiffSection,
  item: { id: string; text: string; created_at: string },
): ContextDiffItem {
  return {
    section,
    id: item.id,
    text: item.text,
    created_at: item.created_at,
  };
}
