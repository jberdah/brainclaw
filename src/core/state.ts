import fs from 'node:fs';
import path from 'node:path';
import { type ZodType, type ZodTypeDef } from 'zod';
import { type State, ConstraintSchema, DecisionSchema, TrapSchema, HandoffSchema, PlanItemSchema } from './schema.js';
import { memoryDir, ensureMemoryDir, resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { commitMemoryChange } from './memory-git.js';
import { appendEvent } from './event-log.js';
import { loadVersionedJsonFile, saveVersionedJsonFile, type VersionedDocumentType } from './migration.js';
import { rebuildProjectMd } from './markdown.js';
import { refreshLiveCompanions } from '../commands/export.js';
import { logger } from './logger.js';
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

function loadDirectoryItems<T>(
  dirPath: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  documentType: VersionedDocumentType,
): T[] {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  const items: T[] = [];
  for (const file of files) {
    try {
      items.push(schema.parse(loadVersionedJsonFile<T>(documentType, path.join(dirPath, file)).document));
    } catch (error) {
      // Record-level schema failure. We preserve the file on disk (see syncDirectory)
      // so nothing is silently lost, but surface the drift so operators can repair.
      logger.warn(`Invalid ${documentType} file ${file} in ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return items;
}

export function loadState(cwd?: string): State {
  // Load from entity-aligned directories (with legacy fallback)
  const effectiveCwd = cwd ?? process.cwd();
  const state = emptyState();

  state.active_constraints = loadDirectoryItems(resolveEntityDir('constraints', effectiveCwd, 'read'), ConstraintSchema, 'constraint');
  state.recent_decisions = loadDirectoryItems(resolveEntityDir('decisions', effectiveCwd, 'read'), DecisionSchema, 'decision');
  state.known_traps = loadDirectoryItems(resolveEntityDir('traps', effectiveCwd, 'read'), TrapSchema, 'trap');
  state.open_handoffs = loadDirectoryItems(resolveEntityDir('handoffs', effectiveCwd, 'read'), HandoffSchema, 'handoff');
  state.plan_items = loadDirectoryItems(resolveEntityDir('plans', effectiveCwd, 'read'), PlanItemSchema, 'plan');
  
  // Sort them by creation date for consistency
  state.active_constraints.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.recent_decisions.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.known_traps.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.open_handoffs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.plan_items.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return state;
}

function syncDirectory<T extends { id: string }>(
  dirPath: string,
  items: T[],
  documentType: VersionedDocumentType,
  schema: ZodType<T, ZodTypeDef, unknown>,
) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // Write all current items
  const currentIds = new Set<string>();
  for (const item of items) {
    currentIds.add(item.id);
    const filepath = path.join(dirPath, `${item.id}.json`);
    saveVersionedJsonFile(documentType, filepath, item);
  }

  // Remove files that are no longer in the state (e.g. if deleted/pruned).
  // CRITICAL: we must distinguish "file dropped from state intentionally" from
  // "file silently dropped by loadDirectoryItems because its schema.parse threw".
  // Deleting the second kind corrupts data (see trap: silent-data-loss via
  // load-swallow + write-sync-GC). So before unlinking, we re-validate the file
  // against the schema. Parseable + not in state = intentional remove → unlink.
  // Unparseable = preserved, operator can inspect/repair.
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const id = file.replace('.json', '');
    if (currentIds.has(id)) continue;

    const filepath = path.join(dirPath, file);
    let parseable = false;
    try {
      schema.parse(loadVersionedJsonFile<T>(documentType, filepath).document);
      parseable = true;
    } catch {
      // Already logged by loadDirectoryItems — leave the file in place.
    }
    if (parseable) {
      fs.unlinkSync(filepath);
    }
  }
}

export function saveState(state: State, cwd?: string): void {
  persistState(state, cwd, { writeProjectMarkdown: false });
}

interface PersistStateOptions {
  writeProjectMarkdown?: boolean;
  eventAction?: 'update' | 'upgrade' | 'rollback';
  eventSummary?: string;
  commitMessage?: string;
}

function persistStateUnlocked(state: State, cwd: string, options: PersistStateOptions = {}): void {
  writeStateDirectories(state, cwd);
  if (options.writeProjectMarkdown ?? true) {
    rebuildProjectMd(state, cwd);
  }
  appendEvent({
    action: options.eventAction ?? 'update',
    item_type: 'state',
    agent: 'system',
    summary: options.eventSummary,
  }, cwd);
  commitMemoryChange(options.commitMessage ?? 'state update', cwd);

  // Auto-refresh live companion files (Tier B/C agents) after state mutations.
  // Non-fatal: failures are logged but don't break the mutation.
  try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
}

function cleanupLegacyDir<T extends { id: string }>(
  entityName: string,
  currentIds: Set<string>,
  cwd: string,
  documentType: VersionedDocumentType,
  schema: ZodType<T, ZodTypeDef, unknown>,
): void {
  const writeDir = resolveEntityDir(entityName, cwd, 'write');
  const readDir = resolveEntityDir(entityName, cwd, 'read');
  // If read resolves to a different (legacy) directory, clean orphans there too.
  // Match syncDirectory's safety condition: only delete parseable records that
  // are absent from the current state. Schema-invalid legacy files may be drifted
  // data that operators still need to inspect or repair.
  if (readDir !== writeDir && fs.existsSync(readDir)) {
    const files = fs.readdirSync(readDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace('.json', '');
      if (currentIds.has(id)) continue;
      const filepath = path.join(readDir, file);
      let parseable = false;
      try {
        schema.parse(loadVersionedJsonFile<T>(documentType, filepath).document);
        parseable = true;
      } catch {
        logger.warn(`Preserving unparseable legacy ${entityName} file ${file}`);
        continue;
      }
      if (parseable) {
        fs.unlinkSync(filepath);
      }
    }
  }
}

function writeStateDirectories(state: State, cwd?: string): void {
  ensureMemoryDir(cwd);
  const effectiveCwd = cwd ?? process.cwd();

  const entities: Array<{
    name: string;
    items: { id: string }[];
    docType: VersionedDocumentType;
    schema: ZodType<{ id: string }, ZodTypeDef, unknown>;
  }> = [
    { name: 'constraints', items: state.active_constraints, docType: 'constraint', schema: ConstraintSchema as unknown as ZodType<{ id: string }, ZodTypeDef, unknown> },
    { name: 'decisions', items: state.recent_decisions, docType: 'decision', schema: DecisionSchema as unknown as ZodType<{ id: string }, ZodTypeDef, unknown> },
    { name: 'traps', items: state.known_traps, docType: 'trap', schema: TrapSchema as unknown as ZodType<{ id: string }, ZodTypeDef, unknown> },
    { name: 'handoffs', items: state.open_handoffs, docType: 'handoff', schema: HandoffSchema as unknown as ZodType<{ id: string }, ZodTypeDef, unknown> },
    { name: 'plans', items: state.plan_items, docType: 'plan', schema: PlanItemSchema as unknown as ZodType<{ id: string }, ZodTypeDef, unknown> },
  ];

  for (const { name, items, docType, schema } of entities) {
    const writeDir = resolveEntityDir(name, effectiveCwd, 'write');
    syncDirectory(writeDir, items, docType, schema);
    const currentIds = new Set(items.map(item => item.id));
    cleanupLegacyDir(name, currentIds, effectiveCwd, docType, schema);
  }
}

export function persistState(state: State, cwd?: string, options: PersistStateOptions = {}): void {
  const effectiveCwd = cwd ?? process.cwd();
  mutate({ cwd: effectiveCwd }, () => {
    persistStateUnlocked(state, effectiveCwd, options);
  });
}

export function mutateState<T>(
  mutateFn: (state: State) => T,
  cwd?: string,
  options: PersistStateOptions = {},
): T {
  const effectiveCwd = cwd ?? process.cwd();
  return mutate({ cwd: effectiveCwd }, () => {
    const state = loadState(effectiveCwd);
    const result = mutateFn(state);
    persistStateUnlocked(state, effectiveCwd, options);
    return result;
  });
}
