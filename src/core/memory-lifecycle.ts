/**
 * pln#544 — Memory lifecycle (confirm/decay/reinforce).
 *
 * Three primitives that combine into the "memory ages honestly" loop:
 *
 *  1. `recordMemoryEvent` — one-call confirm/infirm/saved_me/misled_me write
 *     against an existing decision/constraint/trap. Updates the denormalised
 *     counters and `last_confirmed_at` / `last_infirmed_at`, appends a
 *     bounded event log entry, and re-saves the item.
 *
 *  2. `getLifecycleStats` — pure read of the lifecycle state for a single
 *     item (age since confirmation, decay multiplier, "fresh" / "stale" /
 *     "infirmed" classification). Context ranking and the curation hints
 *     both consume this.
 *
 *  3. `buildMemoryLifecycleMetrics` — aggregate over the project's active
 *     memory items: confirmed_ratio, average age, oldest unconfirmed, total
 *     saved_me/misled_me signals. Surfaced in workflow hints and reputation.
 *
 * Decay curves are intentionally entity-specific (traps describe environment
 * facts that mostly stay true, decisions/constraints describe project
 * intent that drifts faster as the codebase evolves).
 */
import { mutateState } from './state.js';
import { nowISO } from './ids.js';
import type {
  Constraint,
  Decision,
  MemoryConfirmationEvent,
  MemoryConfirmationKind,
  Trap,
} from './schema.js';

/** Maximum events kept inline on a memory item — older events are dropped
 *  from the log. The counters stay accurate; the log is a recent-evidence
 *  buffer, not an audit trail (audit.ts covers durable provenance). */
export const MAX_INLINE_CONFIRMATIONS = 8;

/** Per-entity decay half-life (days). Tuned by intuition + the rationale in
 *  pln#544: traps describe stable environmental risks, decisions/constraints
 *  describe project intent that goes stale faster as code evolves. */
export const DECAY_HALF_LIFE_DAYS: Readonly<Record<MemoryLifecycleEntity, number>> = {
  trap: 90,
  constraint: 60,
  decision: 60,
};

export type MemoryLifecycleEntity = 'decision' | 'constraint' | 'trap';
export type MemoryLifecycleItem = Decision | Constraint | Trap;

export interface RecordMemoryEventInput {
  entity: MemoryLifecycleEntity;
  id: string;
  kind: MemoryConfirmationKind;
  by: string;
  by_id?: string;
  session_id?: string;
  evidence?: string;
  note?: string;
  cwd?: string;
  /** ISO timestamp override (testing); defaults to nowISO(). */
  at?: string;
}

export interface RecordMemoryEventResult {
  entity: MemoryLifecycleEntity;
  id: string;
  kind: MemoryConfirmationKind;
  last_confirmed_at?: string;
  last_infirmed_at?: string;
  confirmation_count: number;
  infirmation_count: number;
  saved_me_count: number;
  misled_me_count: number;
}

/**
 * Append a confirm/infirm/saved_me/misled_me event onto a memory item and
 * update its denormalised counters. Returns the updated counters so the
 * caller (CLI/MCP layer, tests) can echo them back to the operator.
 *
 * Throws if the item id is not present in the project's active state.
 */
export function recordMemoryEvent(input: RecordMemoryEventInput): RecordMemoryEventResult {
  const cwd = input.cwd ?? process.cwd();
  const at = input.at ?? nowISO();

  let captured: RecordMemoryEventResult | undefined;
  mutateState((state) => {
    const bucket =
      input.entity === 'decision'  ? state.recent_decisions
      : input.entity === 'constraint' ? state.active_constraints
      : state.known_traps;
    const item = (bucket as Array<MemoryLifecycleItem>).find((x) => x.id === input.id);
    if (!item) {
      throw new Error(`memory-lifecycle: ${input.entity} '${input.id}' not found in active state`);
    }

    const event: MemoryConfirmationEvent = {
      at,
      by: input.by,
      kind: input.kind,
      ...(input.by_id ? { by_id: input.by_id } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.note ? { note: input.note } : {}),
    };

    const next: MemoryConfirmationEvent[] = Array.isArray(item.confirmations)
      ? [...item.confirmations, event]
      : [event];
    // Bounded log: keep the most recent MAX_INLINE_CONFIRMATIONS.
    item.confirmations = next.slice(-MAX_INLINE_CONFIRMATIONS);

    if (input.kind === 'confirm' || input.kind === 'saved_me') {
      item.last_confirmed_at = at;
      item.confirmation_count = (item.confirmation_count ?? 0) + 1;
      if (input.kind === 'saved_me') {
        item.saved_me_count = (item.saved_me_count ?? 0) + 1;
      }
    } else {
      item.last_infirmed_at = at;
      item.infirmation_count = (item.infirmation_count ?? 0) + 1;
      if (input.kind === 'misled_me') {
        item.misled_me_count = (item.misled_me_count ?? 0) + 1;
      }
    }

    captured = {
      entity: input.entity,
      id: input.id,
      kind: input.kind,
      last_confirmed_at: item.last_confirmed_at,
      last_infirmed_at: item.last_infirmed_at,
      confirmation_count: item.confirmation_count ?? 0,
      infirmation_count: item.infirmation_count ?? 0,
      saved_me_count: item.saved_me_count ?? 0,
      misled_me_count: item.misled_me_count ?? 0,
    };
  }, cwd);

  if (!captured) {
    // Defensive: mutateState should have thrown on a missing item, but if
    // mutateState swallows the throw we still surface a useful error.
    throw new Error(`memory-lifecycle: ${input.entity} '${input.id}' could not be updated`);
  }
  return captured;
}

export interface LifecycleStats {
  /** Effective freshness anchor: max(created_at, last_confirmed_at). */
  anchor_at: string;
  /** Days elapsed since the anchor — or since created_at if never confirmed. */
  age_days: number;
  /** True when the item has been infirmed AFTER its last confirmation. */
  infirmed: boolean;
  /** Days since last infirmation; Infinity when never infirmed. */
  infirmation_age_days: number;
  /** Decay multiplier in [0, 1] derived from age and entity half-life.
   *  1.0 = fresh, 0.5 = at half-life, 0.25 = at 2 half-lives, etc. */
  decay_factor: number;
  /** Ranking adjustment to add to the item's score:
   *    - boost (+) for confirmed-recent + reinforced items,
   *    - penalty (-) for stale unconfirmed and infirmed items.
   *  Range roughly [-6, +5]. */
  ranking_delta: number;
  /** Human-readable classification for hints + UI. */
  classification: 'fresh' | 'aging' | 'stale' | 'infirmed' | 'never_confirmed';
  /** Confirmation/infirmation/saved-me/misled-me counters (mirror item). */
  confirmation_count: number;
  infirmation_count: number;
  saved_me_count: number;
  misled_me_count: number;
}

export interface LifecycleStatsInput {
  entity: MemoryLifecycleEntity;
  created_at: string;
  last_confirmed_at?: string;
  last_infirmed_at?: string;
  confirmation_count?: number;
  infirmation_count?: number;
  saved_me_count?: number;
  misled_me_count?: number;
  /** Reference time for age computation; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Compute the lifecycle stats for a single memory item. Pure function — no
 * I/O, drivable from the schema fields alone. Context ranking calls this on
 * every item; curation hints call it to surface the oldest unconfirmed.
 */
export function getLifecycleStats(input: LifecycleStatsInput): LifecycleStats {
  const nowMs = input.nowMs ?? Date.now();
  const createdMs = Date.parse(input.created_at);
  const confirmedMs = input.last_confirmed_at ? Date.parse(input.last_confirmed_at) : undefined;
  const infirmedMs = input.last_infirmed_at ? Date.parse(input.last_infirmed_at) : undefined;

  const anchorMs = Number.isFinite(createdMs)
    ? Math.max(createdMs, confirmedMs ?? -Infinity)
    : (confirmedMs ?? nowMs);
  const anchorAt = new Date(anchorMs).toISOString();
  const ageDays = Math.max(0, Math.floor((nowMs - anchorMs) / 86_400_000));

  const infirmed = infirmedMs !== undefined
    && (confirmedMs === undefined || infirmedMs > confirmedMs);
  const infirmationAgeDays = infirmedMs !== undefined
    ? Math.max(0, Math.floor((nowMs - infirmedMs) / 86_400_000))
    : Number.POSITIVE_INFINITY;

  const halfLife = DECAY_HALF_LIFE_DAYS[input.entity];
  // 2^(-age / halfLife) — pure exponential decay, capped to [0, 1].
  const decayFactor = Math.max(0, Math.min(1, Math.pow(2, -ageDays / halfLife)));

  const confirmationCount = input.confirmation_count ?? 0;
  const infirmationCount = input.infirmation_count ?? 0;
  const savedMeCount = input.saved_me_count ?? 0;
  const misledMeCount = input.misled_me_count ?? 0;

  // Ranking delta combines:
  //   decay     — gentle aging penalty up to ~-2 at +2 half-lives.
  //   freshness — boost for items confirmed in the last 30d (+2).
  //   reinforce — +1 per saved_me up to +3.
  //   infirmed  — heavy penalty (-5) when infirmed after last confirm.
  //   misled_me — extra penalty (-1 per misled_me up to -3).
  //   stale     — -1 when never confirmed and older than half-life.
  let rankingDelta = -2 * (1 - decayFactor);

  const recentlyConfirmed = confirmedMs !== undefined && (nowMs - confirmedMs) <= 30 * 86_400_000;
  if (recentlyConfirmed) rankingDelta += 2;

  rankingDelta += Math.min(savedMeCount, 3);

  if (infirmed) rankingDelta -= 5;
  rankingDelta -= Math.min(misledMeCount, 3);

  if (confirmationCount === 0 && ageDays > halfLife) rankingDelta -= 1;

  // Round to keep score reasons readable (e.g. "lifecycle:-2.5").
  rankingDelta = Math.round(rankingDelta * 10) / 10;

  let classification: LifecycleStats['classification'];
  if (infirmed) classification = 'infirmed';
  else if (confirmationCount === 0 && ageDays > halfLife) classification = 'never_confirmed';
  else if (recentlyConfirmed) classification = 'fresh';
  else if (ageDays > 2 * halfLife) classification = 'stale';
  else classification = 'aging';

  return {
    anchor_at: anchorAt,
    age_days: ageDays,
    infirmed,
    infirmation_age_days: infirmationAgeDays,
    decay_factor: Number(decayFactor.toFixed(3)),
    ranking_delta: rankingDelta,
    classification,
    confirmation_count: confirmationCount,
    infirmation_count: infirmationCount,
    saved_me_count: savedMeCount,
    misled_me_count: misledMeCount,
  };
}

export interface MemoryLifecycleMetrics {
  total_items: number;
  confirmed_items: number;
  /** items with confirmation_count >= 1 / total_items, in [0, 1]. */
  confirmed_ratio: number;
  /** Mean of `age_days` (anchor-based) across active items. */
  average_age_days: number;
  /** Item id with the largest age_days and confirmation_count === 0; undefined when all items confirmed. */
  oldest_unconfirmed_id?: string;
  oldest_unconfirmed_entity?: MemoryLifecycleEntity;
  oldest_unconfirmed_age_days?: number;
  total_saved_me: number;
  total_misled_me: number;
  total_infirmed_active: number;
  /** Higher = memory earns its keep (saved_me − misled_me, summed). */
  recall_precision_proxy: number;
}

export interface MetricsInputItem {
  entity: MemoryLifecycleEntity;
  id: string;
  created_at: string;
  status?: string;
  last_confirmed_at?: string;
  last_infirmed_at?: string;
  confirmation_count?: number;
  infirmation_count?: number;
  saved_me_count?: number;
  misled_me_count?: number;
}

/**
 * Aggregate lifecycle health across a project's active memory items. Pure
 * function — callers (context.ts workflow hints, reputation.ts dashboard)
 * pass the items they already loaded.
 */
export function buildMemoryLifecycleMetrics(
  items: MetricsInputItem[],
  nowMs = Date.now(),
): MemoryLifecycleMetrics {
  const active = items.filter((item) => !item.status || item.status === 'active');
  const total = active.length;
  if (total === 0) {
    return {
      total_items: 0,
      confirmed_items: 0,
      confirmed_ratio: 0,
      average_age_days: 0,
      total_saved_me: 0,
      total_misled_me: 0,
      total_infirmed_active: 0,
      recall_precision_proxy: 0,
    };
  }

  let confirmed = 0;
  let ageSum = 0;
  let savedMe = 0;
  let misledMe = 0;
  let infirmedActive = 0;
  let oldestUnconfirmed: { id: string; entity: MemoryLifecycleEntity; age: number } | undefined;

  for (const item of active) {
    const stats = getLifecycleStats({
      entity: item.entity,
      created_at: item.created_at,
      last_confirmed_at: item.last_confirmed_at,
      last_infirmed_at: item.last_infirmed_at,
      confirmation_count: item.confirmation_count,
      infirmation_count: item.infirmation_count,
      saved_me_count: item.saved_me_count,
      misled_me_count: item.misled_me_count,
      nowMs,
    });
    if (stats.confirmation_count > 0) confirmed += 1;
    if (stats.infirmed) infirmedActive += 1;
    ageSum += stats.age_days;
    savedMe += stats.saved_me_count;
    misledMe += stats.misled_me_count;
    if (
      stats.confirmation_count === 0
      && (!oldestUnconfirmed || stats.age_days > oldestUnconfirmed.age)
    ) {
      oldestUnconfirmed = { id: item.id, entity: item.entity, age: stats.age_days };
    }
  }

  return {
    total_items: total,
    confirmed_items: confirmed,
    confirmed_ratio: Number((confirmed / total).toFixed(3)),
    average_age_days: Math.round(ageSum / total),
    ...(oldestUnconfirmed ? {
      oldest_unconfirmed_id: oldestUnconfirmed.id,
      oldest_unconfirmed_entity: oldestUnconfirmed.entity,
      oldest_unconfirmed_age_days: oldestUnconfirmed.age,
    } : {}),
    total_saved_me: savedMe,
    total_misled_me: misledMe,
    total_infirmed_active: infirmedActive,
    recall_precision_proxy: savedMe - misledMe,
  };
}

/**
 * Convenience: load state and build the metrics in one call. Used by the
 * curation surfacing in context.ts; tests can prefer the pure variant above.
 */
export function buildMemoryLifecycleMetricsForState(
  state: {
    recent_decisions: Decision[];
    active_constraints: Constraint[];
    known_traps: Trap[];
  },
  nowMs = Date.now(),
): MemoryLifecycleMetrics {
  const items: MetricsInputItem[] = [];
  for (const d of state.recent_decisions) {
    items.push({
      entity: 'decision', id: d.id, created_at: d.created_at,
      last_confirmed_at: d.last_confirmed_at,
      last_infirmed_at: d.last_infirmed_at,
      confirmation_count: d.confirmation_count,
      infirmation_count: d.infirmation_count,
      saved_me_count: d.saved_me_count,
      misled_me_count: d.misled_me_count,
    });
  }
  for (const c of state.active_constraints) {
    items.push({
      entity: 'constraint', id: c.id, created_at: c.created_at, status: c.status,
      last_confirmed_at: c.last_confirmed_at,
      last_infirmed_at: c.last_infirmed_at,
      confirmation_count: c.confirmation_count,
      infirmation_count: c.infirmation_count,
      saved_me_count: c.saved_me_count,
      misled_me_count: c.misled_me_count,
    });
  }
  for (const t of state.known_traps) {
    items.push({
      entity: 'trap', id: t.id, created_at: t.created_at, status: t.status,
      last_confirmed_at: t.last_confirmed_at,
      last_infirmed_at: t.last_infirmed_at,
      confirmation_count: t.confirmation_count,
      infirmation_count: t.infirmation_count,
      saved_me_count: t.saved_me_count,
      misled_me_count: t.misled_me_count,
    });
  }
  return buildMemoryLifecycleMetrics(items, nowMs);
}
