/**
 * Journal genesis migration + rollback (pln#543 step 4, spec §4 phase 1).
 *
 * Genesis seeds the v2 journal from the current v1 projection store: one
 * `journal_note` kind `genesis` followed by one `backfill` record per live
 * memory entity (entity_rev 1), all under a single lock hold. It is the
 * baseline the journal grows from and that materialize/verify check against.
 *
 * Discipline (matches the house upgrade rule, feedback_no_init_force):
 *   - MANDATORY backup before writing — projections copied to a timestamped
 *     park dir; nothing is ever deleted.
 *   - Refuses to clobber an existing genesis unless `force` (which parks the
 *     prior journal first — park-don't-delete).
 *   - Rollback parks the journal directory; projections are untouched (in
 *     dual mode they were always the source of truth), so it is a safe,
 *     reversible "stop using the journal" operation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from '../io.js';
import { loadState } from '../state.js';
import { preparePersistedDocument, type VersionedDocumentType } from '../migration.js';
import { nowISO } from '../ids.js';
import { logger } from '../logger.js';
import {
  forceAppendJournalRecords, journalDir, readJournalRecords, resolveJournalMode,
  type JournalAppendInput, type EventItemTypeV2,
} from './journal.js';
import { REGISTRY_FAMILIES, type RegistryFamily } from './registry-post-image.js';
import { listClaims } from '../claims.js';
import { listAssignments } from '../assignments.js';
import { listAgentRuns } from '../agentruns.js';
import { listActionRequired } from '../actions.js';
import { listCandidates } from '../candidates.js';
import { listSequences } from '../sequence.js';
import { listSharedJournaledRuntimeNotes } from '../runtime.js';

const MEMORY_FAMILIES: Array<{ collection: 'active_constraints' | 'recent_decisions' | 'known_traps' | 'open_handoffs' | 'plan_items'; itemType: EventItemTypeV2 }> = [
  { collection: 'active_constraints', itemType: 'constraint' },
  { collection: 'recent_decisions', itemType: 'decision' },
  { collection: 'known_traps', itemType: 'trap' },
  { collection: 'open_handoffs', itemType: 'handoff' },
  { collection: 'plan_items', itemType: 'plan' },
];

export interface GenesisResult {
  status: 'migrated' | 'already_present' | 'dry_run';
  genesis_seq?: number;
  backfilled: number;
  backup_path?: string;
  per_family: Record<string, number>;
}

/** True once a `journal_note` kind `genesis` exists in the journal. */
export function hasGenesis(cwd?: string): boolean {
  return readJournalRecords(cwd).some(
    r => r.action === 'journal_note' && (r.payload as { kind?: string } | undefined)?.kind === 'genesis',
  );
}

/**
 * Copy the live projection store to a timestamped park dir. Returns the path.
 * `ts` is injected (the codebase forbids Date.now()/new Date() in some layers;
 * callers pass nowISO()-derived stamps) — defaults to a lexically-sortable ISO.
 */
export function backupStore(cwd: string, stamp: string): string {
  const base = memoryDir(cwd);
  const memorySrc = path.join(base, 'memory');
  const safeStamp = stamp.replace(/[:.]/g, '-');
  const backupDir = path.join(base, 'migration-backups', `genesis-${safeStamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(memorySrc)) {
    fs.cpSync(memorySrc, path.join(backupDir, 'memory'), { recursive: true });
  }
  return backupDir;
}

export interface GenesisOptions {
  /** Park any existing journal + re-seed. Default false (refuse if genesis present). */
  force?: boolean;
  /** Plan the migration without writing. */
  dryRun?: boolean;
  cwd?: string;
}

export function runGenesisMigration(options: GenesisOptions = {}): GenesisResult {
  const cwd = options.cwd ?? process.cwd();
  const state = loadState(cwd);

  const perFamily: Record<string, number> = {};
  const backfill: JournalAppendInput[] = [];
  for (const { collection, itemType } of MEMORY_FAMILIES) {
    const items = state[collection] as Array<{ id: string }>;
    perFamily[itemType] = items.length;
    for (const item of items) {
      backfill.push({
        action: 'backfill',
        item_type: itemType,
        item_id: item.id,
        agent: 'system',
        payload: preparePersistedDocument(itemType as VersionedDocumentType, item) as Record<string, unknown>,
      });
    }
  }
  const total = backfill.length;

  if (options.dryRun) {
    return { status: 'dry_run', backfilled: total, per_family: perFamily };
  }

  if (hasGenesis(cwd)) {
    if (!options.force) {
      return { status: 'already_present', backfilled: 0, per_family: perFamily };
    }
    parkJournal(cwd, nowISO());
  }

  // Genesis is the phase-1 (dual) seed (spec §4). Running it with the flag
  // off lays the seed but mutations after will not dual-write — the journal
  // then silently diverges from projections until BRAINCLAW_JOURNAL_MODE is
  // flipped to dual. Warn so the operator flips the flag (or accepts the
  // seed-then-flip sequence deliberately).
  if (resolveJournalMode(cwd) === 'off') {
    logger.warn(
      'runGenesisMigration: BRAINCLAW_JOURNAL_MODE=off — genesis will seed the journal, but subsequent mutations will not dual-write, so the journal will diverge from projections until you set BRAINCLAW_JOURNAL_MODE=dual.',
    );
  }

  const backupPath = backupStore(cwd, nowISO());

  // genesis note first, then the backfill batch — all under one lock hold via
  // a single forced append call (appendLocked stamps them with consecutive seqs).
  const genesisNote: JournalAppendInput = {
    action: 'journal_note',
    item_type: 'journal',
    agent: 'system',
    payload: {
      kind: 'genesis',
      migrated_from: 'v1',
      backfill_count: total,
      per_family: perFamily,
      backup_path: backupPath,
      at: nowISO(),
    },
  };
  const written = forceAppendJournalRecords([genesisNote, ...backfill], cwd);
  // Locate the genesis note by action+kind, not array position: appendLocked
  // can prepend a `seq_repair` or `journal_note kind torn_tail_adjudicated`
  // when meta is stale or the prior segment tail is torn, which would shift
  // written[0] off the genesis note and report the wrong genesis_seq.
  const genesisSeq = written.find(
    r => r.action === 'journal_note' && (r.payload as { kind?: string } | undefined)?.kind === 'genesis',
  )?.seq;
  logger.debug(`journal genesis: ${total} entities backfilled at seq ${genesisSeq}, backup ${backupPath}`);

  return { status: 'migrated', genesis_seq: genesisSeq, backfilled: total, backup_path: backupPath, per_family: perFamily };
}

// ── Registry genesis supplement (pln#568 slice 3 — cutover signal O2) ──────

/**
 * The registry / coordination families backfilled by the registry genesis
 * supplement, each mapped to its projection reader. Mirrors verify.ts's
 * VERIFIED_REGISTRY_FAMILIES so a supplemented store passes `doctor
 * --verify-journal` with zero registry drift. Runtime notes are shared-only
 * (private/machine never enter the shared journal, pln#568).
 */
const REGISTRY_GENESIS_FAMILIES: Array<{ family: RegistryFamily; list: (cwd?: string) => Array<{ id: string }> }> = [
  { family: 'claim', list: listClaims },
  { family: 'assignment', list: listAssignments },
  { family: 'agent_run', list: listAgentRuns },
  { family: 'action', list: listActionRequired },
  { family: 'candidate', list: (cwd) => listCandidates('pending', cwd) },
  { family: 'runtime_note', list: listSharedJournaledRuntimeNotes },
  { family: 'sequence', list: listSequences },
];

export interface RegistryGenesisResult {
  status: 'migrated' | 'already_present' | 'dry_run';
  backfilled: number;
  per_family: Record<string, number>;
}

/** True once a `journal_note` kind `registry_genesis` exists — the cutover
 *  signal (O2) the observer reads to trust the journal as AUTHORITATIVE for the
 *  registry families (drop the board_summary MCP seed). */
export function hasRegistryGenesis(cwd?: string): boolean {
  return readJournalRecords(cwd).some(
    r => r.action === 'journal_note' && (r.payload as { kind?: string } | undefined)?.kind === 'registry_genesis',
  );
}

/**
 * Backfill the registry / coordination families into the journal and emit the
 * `registry_genesis` cutover marker (pln#568 slice 3). INCREMENTAL by design:
 * it appends to the existing journal (preserving the memory genesis + all
 * accumulated post-image history) rather than parking/re-seeding — a re-genesis
 * would reset seq to 1 and break live observers' seq cursors. Idempotent: a
 * second run no-ops once the marker is present.
 *
 * The marker is the safe authority signal: an observer must not switch a
 * registry family from the MCP seed to the journal until EVERY pre-existing
 * entity has a post-image, else it undercounts (the trp#559 badge regression).
 * This backfill establishes that guarantee, then the marker announces it.
 */
export function runRegistryGenesisSupplement(options: GenesisOptions = {}): RegistryGenesisResult {
  const cwd = options.cwd ?? process.cwd();

  const perFamily: Record<string, number> = {};
  const backfill: JournalAppendInput[] = [];
  for (const { family, list } of REGISTRY_GENESIS_FAMILIES) {
    const spec = REGISTRY_FAMILIES[family];
    const items = list(cwd);
    perFamily[spec.journalItemType] = items.length;
    for (const item of items) {
      backfill.push({
        action: 'backfill',
        item_type: spec.journalItemType,
        item_id: item.id,
        agent: 'system',
        payload: preparePersistedDocument(spec.docType, item) as Record<string, unknown>,
      });
    }
  }
  const total = backfill.length;

  if (options.dryRun) {
    return { status: 'dry_run', backfilled: total, per_family: perFamily };
  }
  if (hasRegistryGenesis(cwd)) {
    return { status: 'already_present', backfilled: 0, per_family: perFamily };
  }

  const marker: JournalAppendInput = {
    action: 'journal_note',
    item_type: 'journal',
    agent: 'system',
    payload: { kind: 'registry_genesis', backfill_count: total, per_family: perFamily, at: nowISO() },
  };
  forceAppendJournalRecords([marker, ...backfill], cwd);
  logger.debug(`registry genesis: ${total} registry entities backfilled, cutover marker emitted`);
  return { status: 'migrated', backfilled: total, per_family: perFamily };
}

/**
 * Park the journal directory (events/) to a timestamped archive — the
 * reversible "stop using the journal" operation. Projections are untouched.
 * Returns the park path, or undefined if there was no journal.
 */
export function parkJournal(cwd: string, stamp: string): string | undefined {
  const dir = journalDir(cwd);
  if (!fs.existsSync(dir)) return undefined;
  const safeStamp = stamp.replace(/[:.]/g, '-');
  const parked = path.join(memoryDir(cwd), 'migration-backups', `journal-parked-${safeStamp}`);
  fs.mkdirSync(path.dirname(parked), { recursive: true });
  fs.renameSync(dir, parked);
  return parked;
}

export interface RollbackResult {
  status: 'rolled_back' | 'nothing_to_roll_back';
  parked_path?: string;
}

export function rollbackJournal(options: { cwd?: string } = {}): RollbackResult {
  const cwd = options.cwd ?? process.cwd();
  const parked = parkJournal(cwd, nowISO());
  return parked
    ? { status: 'rolled_back', parked_path: parked }
    : { status: 'nothing_to_roll_back' };
}
