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

export const MEMORY_FAMILIES: Array<{
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

/**
 * Journal item_types of the registry / coordination families (pln#568). Their
 * post-images are entity-state records (emitRegistryPostImage) the reducer
 * already upserts, so no reducer change is needed to project them. NOTE
 * action_required journals under item_type `state` (the slot board-projection
 * reserved for it), not `action`.
 */
export const REGISTRY_ITEM_TYPES = ['claim', 'assignment', 'agent_run', 'state', 'candidate', 'runtime_note', 'sequence'] as const;

/**
 * Materialize the registry / coordination families from the journal: the latest
 * post-image per id (tombstones removed), grouped by journal item_type. Drives
 * registry verification (verify.ts) and journal-only recovery of these
 * families. The memory store-marker (`journal_note`, no item_id) never enters
 * the live map, so a `state` group here is purely action_required post-images.
 */
export function materializeRegistryFromJournal(cwd?: string): Map<string, MaterializedEntity[]> {
  const registry = new Set<string>(REGISTRY_ITEM_TYPES);
  const byType = new Map<string, MaterializedEntity[]>();
  for (const entity of materializeEntitiesFromJournal(cwd).values()) {
    if (!registry.has(entity.item_type)) continue;
    const group = byType.get(entity.item_type);
    if (group) group.push(entity);
    else byType.set(entity.item_type, [entity]);
  }
  return byType;
}

// verifyProjectionsAgainstJournal moved to events/verify.ts (pln#566 Inc0 s2)
// to break the materialize -> state import edge: the checkpoint read path
// imports materialize, and state imports checkpoint, so a materialize -> state
// edge would form a state <-> checkpoint <-> materialize cycle (TDZ class,
// trp_187e42e9). verify.ts is imported by doctor/tests, never by state.

// Re-export for callers that want the raw replay (recovery tooling, step 4).
export type { JournalRecord };
