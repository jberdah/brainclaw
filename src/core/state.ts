import fs from 'node:fs';
import path from 'node:path';
import { type ZodType } from 'zod';
import { type State, ConstraintSchema, DecisionSchema, TrapSchema, HandoffSchema, PlanItemSchema } from './schema.js';
import { memoryDir, ensureMemoryDir, resolveEntityDir, writeFileAtomic } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { commitMemoryChange } from './memory-git.js';
import { appendEvent, type EventItemType } from './event-log.js';
import { appendJournalRecords, resolveJournalMode, type JournalAppendInput } from './events/journal.js';
import { loadVersionedJsonFile, serializeVersionedJson, preparePersistedDocument, type VersionedDocumentType } from './migration.js';
import { rebuildProjectMd } from './markdown.js';
import { refreshLiveCompanions } from '../commands/export.js';
import { logger } from './logger.js';

export interface LoadValidationWarning {
  entity_id: string;
  validation_errors: string[];
  path: string;
}
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
  schema: ZodType<T, unknown>,
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

const ENTITY_LOAD_CONFIG = {
  constraint: { subdir: 'constraints', documentType: 'constraint', recursive: false },
  decision: { subdir: 'decisions', documentType: 'decision', recursive: false },
  trap: { subdir: 'traps', documentType: 'trap', recursive: false },
  handoff: { subdir: 'handoffs', documentType: 'handoff', recursive: false },
  plan: { subdir: 'plans', documentType: 'plan', recursive: false },
  candidate: { subdir: 'inbox', documentType: 'candidate', recursive: false },
  claim: { subdir: 'claims', documentType: 'claim', recursive: false },
  assignment: { subdir: 'assignments', documentType: 'assignment', recursive: false },
  agent_run: { subdir: 'runs', documentType: 'agent_run', recursive: false },
  action: { subdir: 'actions', documentType: 'action_required', recursive: false },
  runtime_note: { subdir: 'runtime', documentType: 'runtime_note', recursive: true },
} as const satisfies Record<string, { subdir: string; documentType: VersionedDocumentType; recursive: boolean }>;

type LoadableEntityName = keyof typeof ENTITY_LOAD_CONFIG;

function listJsonFiles(dirPath: string, recursive: boolean): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath).sort()) {
    const fullPath = path.join(dirPath, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (recursive) files.push(...listJsonFiles(fullPath, true));
      continue;
    }
    if (entry.endsWith('.json')) files.push(fullPath);
  }
  return files;
}

function validationErrorsFrom(error: unknown): string[] {
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    return ((error as { issues: Array<{ path?: unknown[]; message?: string }> }).issues).map((issue) => {
      const issuePath = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${issuePath}${issue.message ?? 'validation failed'}`;
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}

export function collectLoadValidationWarnings(entity: string, cwd?: string): LoadValidationWarning[] {
  const config = ENTITY_LOAD_CONFIG[entity as LoadableEntityName];
  if (!config) return [];
  const effectiveCwd = cwd ?? process.cwd();
  const dirPath = resolveEntityDir(config.subdir, effectiveCwd, 'read');
  return listJsonFiles(dirPath, config.recursive).flatMap((filepath) => {
    try {
      loadVersionedJsonFile(config.documentType, filepath);
      return [];
    } catch (error) {
      return [{
        entity_id: path.basename(filepath, '.json'),
        validation_errors: validationErrorsFrom(error),
        path: filepath,
      }];
    }
  });
}

export function findLoadValidationWarning(entity: string, id: string, cwd?: string): LoadValidationWarning | undefined {
  return collectLoadValidationWarnings(entity, cwd).find((warning) => warning.entity_id === id);
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

/**
 * Counters for the dirty-tracking persist path (pln#543 step 3). Observable
 * so the perf benchmark suite (step 4) can assert the full-rewrite is off the
 * hot path: a single-entity mutation should write 1 file, not N.
 */
export interface PersistWriteStats {
  written: number;
  skippedUnchanged: number;
}
const persistWriteStats: PersistWriteStats = { written: 0, skippedUnchanged: 0 };

export function readPersistWriteStats(): PersistWriteStats {
  return { ...persistWriteStats };
}
export function resetPersistWriteStats(): void {
  persistWriteStats.written = 0;
  persistWriteStats.skippedUnchanged = 0;
}

/**
 * Order-insensitive canonical form of a JSON document, for the dirty-tracking
 * skip compare. Recursively sorts object keys; returns the raw input on parse
 * failure so corrupt/non-JSON bytes never compare equal to a valid desired doc.
 */
function canonicalJson(raw: string): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sortKeys(v)]),
      );
    }
    return value;
  };
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)));
  } catch {
    return raw; // unparseable → never equals a canonical desired doc
  }
}

interface SyncResult<T> {
  /** Items whose file was actually (re)written this sync, with create-vs-update. */
  written: Array<{ item: T; created: boolean }>;
  /** Ids whose projection file was unlinked (intentional removals). */
  deleted: string[];
}

function syncDirectory<T extends { id: string }>(
  dirPath: string,
  items: T[],
  documentType: VersionedDocumentType,
  schema: ZodType<T, unknown>,
  deleteMissing: boolean,
): SyncResult<T> {
  const result: SyncResult<T> = { written: [], deleted: [] };
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // Write only the items whose on-disk bytes would change (dirty-tracking,
  // pln#543 step 3). The full-store rewrite on every mutation was the hot-path
  // cost syncDirectory imposed; comparing the would-be content against what is
  // on disk skips the unchanged majority. The comparison uses the writer's own
  // serializer (serializeVersionedJson) so a "skip" can never diverge from what
  // saveVersionedJsonFile would have produced. Safe against the trp#126
  // silent-data-loss class: a missing or byte-different file never matches, so
  // an in-state entity whose projection is absent/corrupt is always rewritten.
  const currentIds = new Set<string>();
  for (const item of items) {
    currentIds.add(item.id);
    const filepath = path.join(dirPath, `${item.id}.json`);
    const desired = serializeVersionedJson(documentType, item);
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(filepath, 'utf-8');
    } catch {
      existing = undefined; // missing/unreadable → write
    }
    // Skip when the on-disk content is SEMANTICALLY identical, not just
    // byte-identical: loadState re-parses through zod, which can reorder keys
    // (e.g. schema_version migrates to the front). A byte compare would then
    // see every reloaded entity as "changed" and rewrite the whole store on
    // every persist — defeating dirty-tracking. The canonical (sorted-key)
    // compare treats order-only differences as unchanged; genuinely changed
    // content always differs. Unparseable on-disk bytes never match → rewrite
    // (keeps the trp#126 safety: a corrupt/missing projection is always
    // re-materialized from in-state truth).
    if (existing !== undefined && canonicalJson(existing) === canonicalJson(desired)) {
      persistWriteStats.skippedUnchanged += 1;
      continue;
    }
    writeFileAtomic(filepath, desired);
    persistWriteStats.written += 1;
    result.written.push({ item, created: existing === undefined });
  }

  if (!deleteMissing) return result;

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
      result.deleted.push(id);
    }
  }
  return result;
}

export function saveState(state: State, cwd?: string): void {
  persistState(state, cwd, { writeProjectMarkdown: false });
}

interface PersistStateOptions {
  writeProjectMarkdown?: boolean;
  eventAction?: 'update' | 'upgrade' | 'rollback';
  eventSummary?: string;
  commitMessage?: string;
  deleteMissing?: boolean;
}

function persistStateUnlocked(state: State, cwd: string, options: PersistStateOptions = {}): void {
  const dirty = writeStateDirectories(state, cwd, options.deleteMissing ?? false);
  if (options.writeProjectMarkdown ?? true) {
    rebuildProjectMd(state, cwd);
  }
  // v1 events.jsonl: keep the coarse store event for existing consumers, but
  // suppress its envelope-only journal dual-write — persist is the §2.8 "diff
  // choke point" and emits the rich per-entity post-images below instead.
  appendEvent({
    action: options.eventAction ?? 'update',
    item_type: 'state',
    agent: 'system',
    summary: options.eventSummary,
  }, cwd, { journalDualWrite: false });
  emitPerEntityJournalRecords(dirty, options.eventAction, cwd);
  // NOTE (pln#558 step 2): the git commit and refreshLiveCompanions used to
  // run here, INSIDE the mutation lock. A single persistState was holding
  // the lock for >5s on Juan's machine (full-store rewrite + git add -A +
  // git commit + live-companion refresh), which serialized every other
  // writer. They are now invoked by persistState / mutateState AFTER the
  // lock releases — see runPostWriteHooks below. The critical section is
  // now writes-only; commit / companion-refresh are best-effort observers.
}

function runPostWriteHooks(cwd: string, commitMessage: string): void {
  // git add + git commit. Safe outside the lock because (a) git itself
  // serializes concurrent index access via .git/index.lock, (b) the
  // implementation already swallows failures (see memory-git.ts), and
  // (c) the commit is an audit trail, not the data itself.
  try { commitMemoryChange(commitMessage, cwd); } catch { /* best-effort */ }
  // Live companion files (Tier B/C agent surfaces). Already best-effort.
  try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
}

function cleanupLegacyDir<T extends { id: string }>(
  entityName: string,
  currentIds: Set<string>,
  cwd: string,
  documentType: VersionedDocumentType,
  schema: ZodType<T, unknown>,
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

/**
 * Per-entity-type dirty set produced by a persist, consumed by the journal
 * post-image emission. `itemType` is the EventItemType for the family.
 */
interface DirtyEntities {
  itemType: EventItemType;
  written: Array<{ item: { id: string }; created: boolean }>;
  deleted: string[];
}

function writeStateDirectories(state: State, cwd?: string, deleteMissing = false): DirtyEntities[] {
  ensureMemoryDir(cwd);
  const effectiveCwd = cwd ?? process.cwd();

  const entities: Array<{
    name: string;
    itemType: EventItemType;
    items: { id: string }[];
    docType: VersionedDocumentType;
    schema: ZodType<{ id: string }, unknown>;
  }> = [
    { name: 'constraints', itemType: 'constraint', items: state.active_constraints, docType: 'constraint', schema: ConstraintSchema as unknown as ZodType<{ id: string }, unknown> },
    { name: 'decisions', itemType: 'decision', items: state.recent_decisions, docType: 'decision', schema: DecisionSchema as unknown as ZodType<{ id: string }, unknown> },
    { name: 'traps', itemType: 'trap', items: state.known_traps, docType: 'trap', schema: TrapSchema as unknown as ZodType<{ id: string }, unknown> },
    { name: 'handoffs', itemType: 'handoff', items: state.open_handoffs, docType: 'handoff', schema: HandoffSchema as unknown as ZodType<{ id: string }, unknown> },
    { name: 'plans', itemType: 'plan', items: state.plan_items, docType: 'plan', schema: PlanItemSchema as unknown as ZodType<{ id: string }, unknown> },
  ];

  const dirty: DirtyEntities[] = [];
  for (const { name, itemType, items, docType, schema } of entities) {
    const writeDir = resolveEntityDir(name, effectiveCwd, 'write');
    const result = syncDirectory(writeDir, items, docType, schema, deleteMissing);
    dirty.push({ itemType, written: result.written, deleted: result.deleted });
    const currentIds = new Set(items.map(item => item.id));
    if (deleteMissing) {
      cleanupLegacyDir(name, currentIds, effectiveCwd, docType, schema);
    }
  }
  return dirty;
}

/**
 * Emit one journal record per dirty entity with its full post-image
 * (entity-state class, §2.1.1 / §2.8): the persist path is where the store's
 * source-of-truth events are minted, because only it holds the entity docs.
 * No-op when the journal flag is off. Failures are swallowed inside
 * appendJournalRecords (dual mode: v1 projections remain the truth).
 */
function emitPerEntityJournalRecords(
  dirty: DirtyEntities[],
  storeAction: PersistStateOptions['eventAction'],
  cwd: string,
): void {
  if (resolveJournalMode() === 'off') return;
  const records: JournalAppendInput[] = [];
  for (const { itemType, written, deleted } of dirty) {
    for (const { item, created } of written) {
      // Post-image = the prepared document (with schema_version), so the
      // journal record is byte-faithful to the projection: materialize can
      // reconstruct an identical file, and verify compares like-for-like.
      records.push({
        action: storeAction && storeAction !== 'update' ? storeAction : (created ? 'create' : 'update'),
        item_type: itemType,
        item_id: item.id,
        agent: 'system',
        payload: preparePersistedDocument(itemType as VersionedDocumentType, item) as Record<string, unknown>,
      });
    }
    for (const id of deleted) {
      records.push({ action: 'delete', item_type: itemType, item_id: id, agent: 'system' });
    }
  }
  if (records.length > 0) appendJournalRecords(records, cwd);
}

export function persistState(state: State, cwd?: string, options: PersistStateOptions = {}): void {
  const effectiveCwd = cwd ?? process.cwd();
  mutate({ cwd: effectiveCwd }, () => {
    persistStateUnlocked(state, effectiveCwd, options);
  });
  runPostWriteHooks(effectiveCwd, options.commitMessage ?? 'state update');
}

export function mutateState<T>(
  mutateFn: (state: State) => T,
  cwd?: string,
  options: PersistStateOptions = {},
): T {
  const effectiveCwd = cwd ?? process.cwd();
  const result = mutate({ cwd: effectiveCwd }, () => {
    const state = loadState(effectiveCwd);
    const value = mutateFn(state);
    persistStateUnlocked(state, effectiveCwd, { ...options, deleteMissing: true });
    return value;
  });
  runPostWriteHooks(effectiveCwd, options.commitMessage ?? 'state update');
  return result;
}
