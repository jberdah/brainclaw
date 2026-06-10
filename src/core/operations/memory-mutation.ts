/**
 * Pure business logic for updating and deleting memory items across store chains.
 *
 * Handles constraint, decision, and trap mutations with store chain resolution.
 * No console.log, no process.exit, no MCP formatting.
 *
 * @module
 */
import path from 'node:path';
import { loadState, mutateState } from '../state.js';
import { resolveStoreChain, resolveTargetStore, type StoreRef, type StoreTarget } from '../store-resolution.js';
import type { Constraint, Decision, Trap } from '../schema.js';

export type MemoryItemType = 'constraint' | 'decision' | 'trap';

// ── Find item in store chain ─────────────────────────────────

export interface FoundMemoryItem {
  item: Constraint | Decision | Trap;
  store: StoreRef;
  itemType: MemoryItemType;
}

type MemoryState = ReturnType<typeof loadState>;

function bucketFor(state: MemoryState, itemType: MemoryItemType): Array<Constraint | Decision | Trap> {
  if (itemType === 'constraint') return state.active_constraints;
  if (itemType === 'decision') return state.recent_decisions;
  return state.known_traps;
}

function findInState(
  state: MemoryState,
  itemId: string,
  itemType: MemoryItemType,
): Constraint | Decision | Trap | undefined {
  return bucketFor(state, itemType).find((item) => item.id === itemId || item.short_label === itemId);
}

function replaceInState(
  state: MemoryState,
  itemId: string,
  itemType: MemoryItemType,
  item: Constraint | Decision | Trap,
): boolean {
  const bucket = bucketFor(state, itemType);
  const idx = bucket.findIndex((entry) => entry.id === itemId || entry.short_label === itemId);
  if (idx < 0) return false;
  bucket[idx] = item;
  return true;
}

function removeFromState(state: MemoryState, itemId: string, itemType: MemoryItemType): boolean {
  const bucket = bucketFor(state, itemType);
  const before = bucket.length;
  const filtered = bucket.filter((item) => item.id !== itemId && item.short_label !== itemId);
  if (itemType === 'constraint') state.active_constraints = filtered as Constraint[];
  if (itemType === 'decision') state.recent_decisions = filtered as Decision[];
  if (itemType === 'trap') state.known_traps = filtered as Trap[];
  return filtered.length !== before;
}

function applyMemoryPatch(
  item: Constraint | Decision | Trap,
  input: UpdateMemoryInput,
): Constraint | Decision | Trap {
  const next = { ...item } as Constraint | Decision | Trap;
  if (input.text) next.text = input.text;
  if (input.tags) next.tags = input.tags;
  if (input.status && input.type === 'trap') {
    (next as Trap).status = input.status as Trap['status'];
  }
  if (input.patch) {
    Object.assign(next, input.patch);
  }
  return next;
}

/**
 * Walk the store chain to find a memory item by type and id.
 * Searches by both id and short_label.
 */
export function findMemoryItemInChain(
  itemId: string,
  itemType: MemoryItemType,
  cwd: string,
): FoundMemoryItem | undefined {
  const chain = resolveStoreChain(cwd);

  for (const store of chain) {
    const state = loadState(store.cwd);
    let item: Constraint | Decision | Trap | undefined;

    if (itemType === 'constraint') {
      item = state.active_constraints.find((c) => c.id === itemId || c.short_label === itemId);
    } else if (itemType === 'decision') {
      item = state.recent_decisions.find((d) => d.id === itemId || d.short_label === itemId);
    } else if (itemType === 'trap') {
      item = state.known_traps.find((t) => t.id === itemId || t.short_label === itemId);
    }

    if (item) {
      return { item, store, itemType };
    }
  }

  return undefined;
}

// ── Delete memory item ───────────────────────────────────────

export interface DeleteMemoryResult {
  deletedId: string;
  itemType: MemoryItemType;
  storeRole: string;
}

export function deleteMemoryItem(
  itemId: string,
  itemType: MemoryItemType,
  cwd: string,
): DeleteMemoryResult {
  const found = findMemoryItemInChain(itemId, itemType, cwd);
  if (!found) {
    throw new Error(`${itemType} with id '${itemId}' not found in any store`);
  }

  mutateState((state) => {
    if (!removeFromState(state, itemId, itemType)) {
      throw new Error(`${itemType} with id '${itemId}' not found in ${found.store.role} store`);
    }
  }, found.store.cwd);

  return {
    deletedId: itemId,
    itemType,
    storeRole: found.store.role,
  };
}

// ── Update memory item ───────────────────────────────────────

export interface UpdateMemoryInput {
  id: string;
  type: MemoryItemType;
  text?: string;
  tags?: string[];
  status?: string;
  moveToStore?: StoreTarget;
  /**
   * Generic patch escape-hatch for fields declared in EntityRegistry.updatable
   * but not exposed via the typed surface (severity, scope, related_paths,
   * expires_at, outcome, category, platform_scope, …). Applied last via
   * Object.assign so explicit typed fields take precedence.
   */
  patch?: Partial<Constraint | Decision | Trap>;
}

export interface UpdateMemoryResult {
  updatedId: string;
  itemType: MemoryItemType;
  previousStore: string;
  newStore?: string;
}

export function updateMemoryItem(
  input: UpdateMemoryInput,
  cwd: string,
): UpdateMemoryResult {
  const found = findMemoryItemInChain(input.id, input.type, cwd);
  if (!found) {
    throw new Error(`${input.type} with id '${input.id}' not found in any store`);
  }

  const { store: sourceStore } = found;
  const previousStore = sourceStore.role;

  if (input.moveToStore) {
    const targetCwd = resolveTargetStore(cwd, input.moveToStore);
    if (path.resolve(targetCwd) === path.resolve(sourceStore.cwd)) {
      mutateState((state) => {
        const current = findInState(state, input.id, input.type);
        if (!current) {
          throw new Error(`${input.type} with id '${input.id}' not found in ${sourceStore.role} store`);
        }
        replaceInState(state, input.id, input.type, applyMemoryPatch(current, input));
      }, sourceStore.cwd);
      return {
        updatedId: input.id,
        itemType: input.type,
        previousStore,
        newStore: input.moveToStore,
      };
    }
    const movedItem = mutateState((state) => {
      const current = findInState(state, input.id, input.type);
      if (!current) {
        throw new Error(`${input.type} with id '${input.id}' not found in ${sourceStore.role} store`);
      }
      return applyMemoryPatch(current, input);
    }, sourceStore.cwd);

    // Write target before deleting source. A failure can leave a duplicate, but
    // not silent data loss.
    mutateState((state) => {
      if (!replaceInState(state, input.id, input.type, movedItem)) {
        bucketFor(state, input.type).push(movedItem);
      }
    }, targetCwd);

    mutateState((state) => {
      removeFromState(state, input.id, input.type);
    }, sourceStore.cwd);
  } else {
    mutateState((state) => {
      const current = findInState(state, input.id, input.type);
      if (!current) {
        throw new Error(`${input.type} with id '${input.id}' not found in ${sourceStore.role} store`);
      }
      replaceInState(state, input.id, input.type, applyMemoryPatch(current, input));
    }, sourceStore.cwd);
  }

  return {
    updatedId: input.id,
    itemType: input.type,
    previousStore,
    newStore: input.moveToStore,
  };
}
