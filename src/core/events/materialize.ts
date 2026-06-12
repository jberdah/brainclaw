/**
 * Journal → projection materialization (pln#543 step 3).
 *
 * Rebuilds entity state by replaying the segmented journal's post-images
 * (§2.8 lazy-projection capability). In dual mode this is NOT the hot read
 * path — projections remain the source of truth (§2.7) and reads stay
 * projection-backed. It serves three roles:
 *   1. Verification: `verifyProjectionsAgainstJournal` proves the dual-write
 *      is faithful — the gate that must be green before the primary cutover
 *      (step 5) can trust the journal as the read substrate.
 *   2. Recovery: rebuild a lost/corrupt projection from the journal.
 *   3. The future primary read path (step 5 flips it on).
 *
 * Replay is strictly in (segment, file-line) order; the later post-image of
 * an item wins wholesale (snapshot semantics, §2.2 reducer). A `delete`
 * tombstone removes the entity; a later `create` revives it.
 */
import { ACTION_CLASS_BY_ACTION, readJournalRecords, type EventActionV2, type JournalRecord } from './journal.js';
import { loadState } from '../state.js';
import {
  ConstraintSchema, DecisionSchema, TrapSchema, HandoffSchema, PlanItemSchema,
  type State, type Constraint, type Decision, type Trap, type Handoff, type PlanItem,
} from '../schema.js';
import type { ZodType } from 'zod';

export interface MaterializedEntity {
  item_type: string;
  item_id: string;
  entity_rev?: number;
  payload: Record<string, unknown>;
}

/**
 * Replay the journal into the live set of entities (latest post-image per
 * id, tombstones removed). Keyed by `${item_type}:${item_id}` so the same
 * id under different families never collides.
 */
/**
 * The journal reducer (§2.2): apply records onto a live entity map in
 * (segment, file-line) order — later post-image wins wholesale, tombstone
 * removes. Extracted so the same reducer drives full-journal materialization
 * AND checkpoint+tail replay (pln#566 Inc0) — they can never diverge.
 */
export function applyRecordsToLive(
  records: Iterable<JournalRecord>,
  live: Map<string, MaterializedEntity>,
): Map<string, MaterializedEntity> {
  for (const rec of records) {
    if (!rec.item_id) continue;
    const cls = ACTION_CLASS_BY_ACTION[rec.action as EventActionV2];
    const key = `${rec.item_type}:${rec.item_id}`;
    if (cls === 'tombstone') {
      live.delete(key);
      continue;
    }
    if (cls === 'entity-state' && rec.payload) {
      live.set(key, {
        item_type: rec.item_type,
        item_id: rec.item_id,
        entity_rev: rec.entity_rev,
        payload: rec.payload,
      });
    }
    // observability / registry-lifecycle / journal-meta carry no memory
    // post-image — ignored by state materialization.
  }
  return live;
}

export function materializeEntitiesFromJournal(cwd?: string): Map<string, MaterializedEntity> {
  return applyRecordsToLive(readJournalRecords(cwd), new Map());
}

const MEMORY_FAMILIES: Array<{
  itemType: string;
  schema: ZodType<{ id: string; created_at: string }, unknown>;
  collection: keyof Pick<State, 'active_constraints' | 'recent_decisions' | 'known_traps' | 'open_handoffs' | 'plan_items'>;
}> = [
  { itemType: 'constraint', schema: ConstraintSchema as unknown as ZodType<{ id: string; created_at: string }, unknown>, collection: 'active_constraints' },
  { itemType: 'decision', schema: DecisionSchema as unknown as ZodType<{ id: string; created_at: string }, unknown>, collection: 'recent_decisions' },
  { itemType: 'trap', schema: TrapSchema as unknown as ZodType<{ id: string; created_at: string }, unknown>, collection: 'known_traps' },
  { itemType: 'handoff', schema: HandoffSchema as unknown as ZodType<{ id: string; created_at: string }, unknown>, collection: 'open_handoffs' },
  { itemType: 'plan', schema: PlanItemSchema as unknown as ZodType<{ id: string; created_at: string }, unknown>, collection: 'plan_items' },
];

/**
 * Rebuild the 5 memory-class collections of `State` purely from the journal.
 * Payloads failing schema validation are skipped (mirrors loadState's
 * tolerant read) — verify treats them as drift.
 */
/**
 * Project a materialized live-entity map into the 5 memory-class collections
 * of `State`. Shared by full-journal materialization and checkpoint+tail
 * replay (pln#566 Inc0) so both produce byte-identical state. Payloads failing
 * schema validation are skipped (mirrors loadState's tolerant read).
 */
export function projectLiveToState(live: Map<string, MaterializedEntity>): State {
  const state: State = {
    active_constraints: [], recent_decisions: [], known_traps: [],
    open_handoffs: [], plan_items: [],
  } as unknown as State;

  for (const { itemType, schema, collection } of MEMORY_FAMILIES) {
    const items: Array<{ id: string; created_at: string }> = [];
    for (const entity of live.values()) {
      if (entity.item_type !== itemType) continue;
      const parsed = schema.safeParse(entity.payload);
      if (parsed.success) items.push(parsed.data);
    }
    items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    (state[collection] as unknown[]) = items;
  }
  return state;
}

export function materializeMemoryStateFromJournal(cwd?: string): State {
  return projectLiveToState(materializeEntitiesFromJournal(cwd));
}

export type DriftKind = 'missing_in_journal' | 'missing_in_projection' | 'mismatch';

export interface ProjectionDrift {
  item_type: string;
  item_id: string;
  kind: DriftKind;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

/**
 * Compare projection-read state (the truth in dual mode) against the
 * journal-materialized state. Empty drift = the dual-write is faithful and
 * the journal can be trusted as a read substrate. This is the step-5
 * cutover gate, exposed for a doctor check and the step-3 tests.
 */
export function verifyProjectionsAgainstJournal(cwd?: string): ProjectionDrift[] {
  const projection = loadState(cwd);
  const journal = materializeMemoryStateFromJournal(cwd);
  const drift: ProjectionDrift[] = [];

  for (const { itemType, collection } of MEMORY_FAMILIES) {
    const projItems = new Map((projection[collection] as Array<{ id: string }>).map(i => [i.id, i]));
    const jrnItems = new Map((journal[collection] as Array<{ id: string }>).map(i => [i.id, i]));
    for (const [id, projItem] of projItems) {
      const jrnItem = jrnItems.get(id);
      if (!jrnItem) drift.push({ item_type: itemType, item_id: id, kind: 'missing_in_journal' });
      else if (stable(projItem) !== stable(jrnItem)) drift.push({ item_type: itemType, item_id: id, kind: 'mismatch' });
    }
    for (const id of jrnItems.keys()) {
      if (!projItems.has(id)) drift.push({ item_type: itemType, item_id: id, kind: 'missing_in_projection' });
    }
  }
  return drift;
}

// Re-export for callers that want the raw replay (recovery tooling, step 4).
export type { JournalRecord };
