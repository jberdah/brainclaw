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
  forceAppendJournalRecords, journalDir, readJournalRecords,
  type JournalAppendInput, type EventItemTypeV2,
} from './journal.js';

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
  const genesisSeq = written[0]?.seq;
  logger.debug(`journal genesis: ${total} entities backfilled at seq ${genesisSeq}, backup ${backupPath}`);

  return { status: 'migrated', genesis_seq: genesisSeq, backfilled: total, backup_path: backupPath, per_family: perFamily };
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
