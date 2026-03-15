import fs from 'node:fs';
import path from 'node:path';
import { type State, ConstraintSchema, DecisionSchema, TrapSchema, HandoffSchema, PlanItemSchema } from './schema.js';
import { memoryDir, ensureMemoryDir, writeFileAtomic } from './io.js';
export function emptyState(): State {
  return {
    version: 1,
    write_version: 1,
    active_constraints: [],
    recent_decisions: [],
    known_traps: [],
    open_handoffs: [],
    plan_items: [],
  };
}

function loadDirectoryItems<T>(dirPath: string, schema: { parse: (data: unknown) => T }): T[] {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  const items: T[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      items.push(schema.parse(JSON.parse(raw)));
    } catch {
      // skip invalid files
    }
  }
  return items;
}

export function loadState(cwd?: string): State {
  // Load from directories
  const mDir = memoryDir(cwd);
  const state = emptyState();
  
  state.active_constraints = loadDirectoryItems(path.join(mDir, 'constraints'), ConstraintSchema);
  state.recent_decisions = loadDirectoryItems(path.join(mDir, 'decisions'), DecisionSchema);
  state.known_traps = loadDirectoryItems(path.join(mDir, 'traps'), TrapSchema);
  state.open_handoffs = loadDirectoryItems(path.join(mDir, 'handoffs'), HandoffSchema);
  state.plan_items = loadDirectoryItems(path.join(mDir, 'plans'), PlanItemSchema);
  
  // Sort them by creation date for consistency
  state.active_constraints.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.recent_decisions.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.known_traps.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.open_handoffs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.plan_items.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return state;
}

function syncDirectory<T extends { id: string }>(dirPath: string, items: T[]) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // Write all current items
  const currentIds = new Set<string>();
  for (const item of items) {
    currentIds.add(item.id);
    const filepath = path.join(dirPath, `${item.id}.json`);
    writeFileAtomic(filepath, JSON.stringify(item, null, 2) + '\n');
  }

  // Remove files that are no longer in the state (e.g. if deleted/pruned)
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const id = file.replace('.json', '');
    if (!currentIds.has(id)) {
      fs.unlinkSync(path.join(dirPath, file));
    }
  }
}

export function saveState(state: State, cwd?: string): void {
  ensureMemoryDir(cwd);
  const mDir = memoryDir(cwd);

  // Distribute entities to separate files
  syncDirectory(path.join(mDir, 'constraints'), state.active_constraints);
  syncDirectory(path.join(mDir, 'decisions'), state.recent_decisions);
  syncDirectory(path.join(mDir, 'traps'), state.known_traps);
  syncDirectory(path.join(mDir, 'handoffs'), state.open_handoffs);
  syncDirectory(path.join(mDir, 'plans'), state.plan_items);
}
