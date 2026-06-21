import fs from 'node:fs';
import path from 'node:path';
import { type ZodType } from 'zod';
import { type State, ConstraintSchema, DecisionSchema, TrapSchema, HandoffSchema, PlanItemSchema } from './schema.js';
import { ensureMemoryDir, resolveEntityDir, writeFileAtomic } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { commitMemoryChange } from './memory-git.js';
import { appendEvent, type EventItemType } from './event-log.js';
import { appendJournalRecords, resolveJournalMode, resolveCheckpointRead, type JournalAppendInput } from './events/journal.js';
import { materializeStateFromCheckpoint } from './events/checkpoint.js';
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

  // pln#566 Inc0 s2 — checkpointRead fast path. OFF by default (dual/off mode):
  // projection files remain the read substrate. When the capability is enabled
  // (primary soak) AND a verified journal-derived checkpoint exists, serve from
  // checkpoint + sealed tail instead of reading every projection file. ANY
  // failure (no checkpoint, failed verification, replay error) falls through to
  // the projection read below — the checkpoint is never the sole truth.
  if (resolveCheckpointRead(effectiveCwd)) {
    try {
      const fast = materializeStateFromCheckpoint(effectiveCwd);
      // Merge over emptyState so the served State carries the same envelope
      // fields (version/write_version) a projection read produces; the
      // checkpoint only materializes the 5 entity collections. Already sorted
      // by projectLiveToState.
      if (fast) return { ...emptyState(), ...fast };
    } catch { /* fall through to projection read */ }
  }

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

/**
 * A computed-but-not-yet-applied projection sync for one entity dir (pln#566
 * F1). Splitting plan (pure compute) from apply (the actual writes/unlinks)
 * lets persist emit + fsync the journal BEFORE touching projection files, so a
 * crash can only leave the journal AHEAD of projections (the recoverable
 * direction the lazy-reconcile assumes), never projections ahead.
 */
interface SyncPlan<T> {
  dirPath: string;
  /** Pre-serialized bytes ready to write (dirty-tracking already applied). */
  writes: Array<{ filepath: string; desired: string; item: T; created: boolean }>;
  /** Files to unlink (intentional removals). */
  deletes: Array<{ filepath: string; id: string }>;
}

/**
 * Pure planning pass: compute which projection files WOULD change, without
 * writing anything. Same dirty-tracking + canonical-compare + parseable-guard
 * logic as the old syncDirectory; only the IO is deferred to applySyncPlan.
 */
function planSyncDirectory<T extends { id: string }>(
  dirPath: string,
  items: T[],
  documentType: VersionedDocumentType,
  schema: ZodType<T, unknown>,
  deleteMissing: boolean,
): SyncPlan<T> {
  const plan: SyncPlan<T> = { dirPath, writes: [], deletes: [] };

  // Write only the items whose on-disk bytes would change (dirty-tracking,
  // pln#543 step 3). The comparison uses the writer's own serializer so a
  // "skip" can never diverge from what saveVersionedJsonFile would produce.
  // Safe against trp#126: a missing/byte-different file never matches, so an
  // in-state entity whose projection is absent/corrupt is always rewritten.
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
    // Semantic (canonical, sorted-key) compare, not byte compare: loadState
    // re-parses through zod which can reorder keys; a byte compare would
    // rewrite the whole store every persist. Unparseable bytes never match
    // → rewrite (keeps trp#126 safety).
    if (existing !== undefined && canonicalJson(existing) === canonicalJson(desired)) {
      persistWriteStats.skippedUnchanged += 1;
      continue;
    }
    plan.writes.push({ filepath, desired, item, created: existing === undefined });
  }

  if (!deleteMissing) return plan;

  // Plan removals of files no longer in state. CRITICAL: distinguish an
  // intentional drop from a file silently dropped by loadDirectoryItems on a
  // schema.parse throw (deleting the second kind corrupts data — trp#126). Only
  // parseable + not-in-state files are unlinked; unparseable are preserved.
  const files = fs.existsSync(dirPath)
    ? fs.readdirSync(dirPath).filter(f => f.endsWith('.json'))
    : [];
  for (const file of files) {
    const id = file.replace('.json', '');
    if (currentIds.has(id)) continue;

    const filepath = path.join(dirPath, file);
    try {
      schema.parse(loadVersionedJsonFile<T>(documentType, filepath).document);
    } catch {
      // Already logged by loadDirectoryItems — leave the file in place.
      continue;
    }
    plan.deletes.push({ filepath, id });
  }
  return plan;
}

/** Apply a planned sync: the actual projection-file writes/unlinks (the IO that
 * must happen AFTER the journal append+fsync). Returns the dirty result. */
function applySyncPlan<T extends { id: string }>(plan: SyncPlan<T>): SyncResult<T> {
  const result: SyncResult<T> = { written: [], deleted: [] };
  // Create the entity dir unconditionally (matches the pre-split syncDirectory,
  // which always ensured the dir even for an empty/unchanged collection).
  if (!fs.existsSync(plan.dirPath)) {
    fs.mkdirSync(plan.dirPath, { recursive: true });
  }
  for (const { filepath, desired, item, created } of plan.writes) {
    writeFileAtomic(filepath, desired);
    persistWriteStats.written += 1;
    result.written.push({ item, created });
  }
  for (const { filepath, id } of plan.deletes) {
    fs.unlinkSync(filepath);
    result.deleted.push(id);
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
  ensureMemoryDir(cwd);
  const effectiveCwd = cwd ?? process.cwd();
  // pln#566 F1 — JOURNAL BEFORE PROJECTIONS (invariant I2). Persist now runs in
  // three ordered phases so the journal can never lag the projections: a crash
  // mid-persist leaves the journal AHEAD (the only direction lazy-reconcile can
  // recover), never projections ahead (which materialize/verify could not
  // explain). Phase 1 PLAN (pure compute, no IO) → Phase 2 emit+fsync the
  // per-entity post-images to the journal → Phase 3 APPLY projection writes.
  const { plans, legacyDeletes, dirty } = planStateDirectories(state, effectiveCwd, options.deleteMissing ?? false);
  emitPerEntityJournalRecords(dirty, options.eventAction, effectiveCwd);
  faultPoint('after_journal'); // test-only: crash AFTER journal, BEFORE projections
  applyStatePlans(plans, legacyDeletes);
  faultPoint('after_projection'); // test-only: crash AFTER projections written
  if (options.writeProjectMarkdown ?? true) {
    rebuildProjectMd(state, effectiveCwd);
  }
  // v1 events.jsonl: keep the coarse store event for existing consumers, but
  // suppress its envelope-only journal dual-write — the v2 per-entity emit
  // above is the authoritative §2.8 diff choke point.
  appendEvent({
    action: options.eventAction ?? 'update',
    item_type: 'state',
    agent: 'system',
    summary: options.eventSummary,
  }, effectiveCwd, { journalDualWrite: false });
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

/**
 * Test-only crash injection (pln#566 F1). No-op unless BRAINCLAW_FAULT_POINT
 * matches the label — then it throws, simulating a process death at that exact
 * point in the persist pipeline so crash-ordering invariants can be tested
 * deterministically without racing a real SIGKILL.
 */
function faultPoint(label: string): void {
  if (process.env.BRAINCLAW_FAULT_POINT === label) {
    throw new Error(`fault-injection: crashed at "${label}" (BRAINCLAW_FAULT_POINT)`);
  }
}

/**
 * Plan (do not apply) the removal of legacy-dir orphans. Read-only: matches
 * syncDirectory's safety condition (only parseable records absent from state
 * are deletable; unparseable are preserved for inspection/repair). The actual
 * unlink is deferred to applyStatePlans so it lands AFTER the journal append.
 */
function planCleanupLegacyDir<T extends { id: string }>(
  entityName: string,
  currentIds: Set<string>,
  cwd: string,
  documentType: VersionedDocumentType,
  schema: ZodType<T, unknown>,
): Array<{ filepath: string; id: string }> {
  const out: Array<{ filepath: string; id: string }> = [];
  const writeDir = resolveEntityDir(entityName, cwd, 'write');
  const readDir = resolveEntityDir(entityName, cwd, 'read');
  if (readDir !== writeDir && fs.existsSync(readDir)) {
    const files = fs.readdirSync(readDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace('.json', '');
      if (currentIds.has(id)) continue;
      const filepath = path.join(readDir, file);
      try {
        schema.parse(loadVersionedJsonFile<T>(documentType, filepath).document);
      } catch {
        logger.warn(`Preserving unparseable legacy ${entityName} file ${file}`);
        continue;
      }
      out.push({ filepath, id }); // O3: surfaced so a delete tombstone is emitted
    }
  }
  return out;
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

interface StatePlan {
  plans: SyncPlan<{ id: string }>[];
  legacyDeletes: Array<{ filepath: string; id: string }>;
  /** Derived from the plan (not the apply) so the journal can be emitted first. */
  dirty: DirtyEntities[];
}

/**
 * Phase 1 of persist: compute every projection change WITHOUT writing. The
 * returned `dirty` (post-images + tombstone ids) lets the journal be emitted +
 * fsync'd before applyStatePlans touches any file (pln#566 F1 / I2).
 */
function planStateDirectories(state: State, cwd: string, deleteMissing: boolean): StatePlan {
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

  const plans: SyncPlan<{ id: string }>[] = [];
  const legacyDeletes: Array<{ filepath: string; id: string }> = [];
  const dirty: DirtyEntities[] = [];
  for (const { name, itemType, items, docType, schema } of entities) {
    const writeDir = resolveEntityDir(name, cwd, 'write');
    const plan = planSyncDirectory(writeDir, items, docType, schema, deleteMissing);
    plans.push(plan);
    const deleted = plan.deletes.map(d => d.id);
    if (deleteMissing) {
      // O3: legacy-dir orphans must also emit a delete tombstone.
      const legacy = planCleanupLegacyDir(name, new Set(items.map(i => i.id)), cwd, docType, schema);
      for (const l of legacy) { legacyDeletes.push(l); deleted.push(l.id); }
    }
    dirty.push({ itemType, written: plan.writes.map(w => ({ item: w.item, created: w.created })), deleted });
  }
  return { plans, legacyDeletes, dirty };
}

/** Phase 3 of persist: apply the planned projection writes/unlinks (the IO that
 * must follow the journal append+fsync). */
function applyStatePlans(plans: SyncPlan<{ id: string }>[], legacyDeletes: Array<{ filepath: string; id: string }>): void {
  for (const plan of plans) applySyncPlan(plan);
  for (const { filepath } of legacyDeletes) {
    try { fs.unlinkSync(filepath); } catch { /* already gone — idempotent */ }
  }
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
  if (resolveJournalMode(cwd) === 'off') return;
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
