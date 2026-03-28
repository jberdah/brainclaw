/**
 * Pure business logic for updating and deleting memory items across store chains.
 *
 * Handles constraint, decision, and trap mutations with store chain resolution.
 * No console.log, no process.exit, no MCP formatting.
 *
 * @module
 */
import { loadState, persistState } from '../state.js';
import { resolveStoreChain, resolveTargetStore, type StoreRef, type StoreTarget } from '../store-resolution.js';
import type { Constraint, Decision, Trap } from '../schema.js';

export type MemoryItemType = 'constraint' | 'decision' | 'trap';

// ── Find item in store chain ─────────────────────────────────

export interface FoundMemoryItem {
  item: Constraint | Decision | Trap;
  store: StoreRef;
  itemType: MemoryItemType;
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

  const state = loadState(found.store.cwd);

  if (itemType === 'constraint') {
    state.active_constraints = state.active_constraints.filter(
      (c) => c.id !== itemId && c.short_label !== itemId,
    );
  } else if (itemType === 'decision') {
    state.recent_decisions = state.recent_decisions.filter(
      (d) => d.id !== itemId && d.short_label !== itemId,
    );
  } else if (itemType === 'trap') {
    state.known_traps = state.known_traps.filter(
      (t) => t.id !== itemId && t.short_label !== itemId,
    );
  }

  persistState(state, found.store.cwd);

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

  const { item, store: sourceStore } = found;
  const previousStore = sourceStore.role;

  // Apply field updates
  if (input.text) item.text = input.text;
  if (input.tags) item.tags = input.tags;
  if (input.status && input.type === 'trap') {
    (item as Trap).status = input.status as Trap['status'];
  }

  if (input.moveToStore) {
    const targetCwd = resolveTargetStore(cwd, input.moveToStore);

    // Delete from source
    const sourceState = loadState(sourceStore.cwd);
    if (input.type === 'constraint') {
      sourceState.active_constraints = sourceState.active_constraints.filter((c) => c.id !== input.id);
    } else if (input.type === 'decision') {
      sourceState.recent_decisions = sourceState.recent_decisions.filter((d) => d.id !== input.id);
    } else if (input.type === 'trap') {
      sourceState.known_traps = sourceState.known_traps.filter((t) => t.id !== input.id);
    }
    persistState(sourceState, sourceStore.cwd);

    // Add to target
    const targetState = loadState(targetCwd);
    if (input.type === 'constraint') {
      targetState.active_constraints.push(item as Constraint);
    } else if (input.type === 'decision') {
      targetState.recent_decisions.push(item as Decision);
    } else if (input.type === 'trap') {
      targetState.known_traps.push(item as Trap);
    }
    persistState(targetState, targetCwd);
  } else {
    // Update in place
    const state = loadState(sourceStore.cwd);
    if (input.type === 'constraint') {
      const idx = state.active_constraints.findIndex((c) => c.id === input.id);
      if (idx >= 0) state.active_constraints[idx] = item as Constraint;
    } else if (input.type === 'decision') {
      const idx = state.recent_decisions.findIndex((d) => d.id === input.id);
      if (idx >= 0) state.recent_decisions[idx] = item as Decision;
    } else if (input.type === 'trap') {
      const idx = state.known_traps.findIndex((t) => t.id === input.id);
      if (idx >= 0) state.known_traps[idx] = item as Trap;
    }
    persistState(state, sourceStore.cwd);
  }

  return {
    updatedId: input.id,
    itemType: input.type,
    previousStore,
    newStore: input.moveToStore,
  };
}
