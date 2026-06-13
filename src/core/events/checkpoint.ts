/**
 * Journal-derived checkpoints (pln#543 Phase 3 / pln#566 Inc0, slice 1).
 *
 * A checkpoint is a snapshot of the materialized live-entity set at a covered
 * `head_seq`, plus a manifest that BINDS it to the journal lineage. Per the
 * round-3 review (NF1): checkpoints are derived from the JOURNAL ONLY — never
 * from projection files, never consulting `projection_watermark` — so the
 * journal is the single root of trust and there is no checkpoint↔watermark
 * cycle. The cold-read fast path (a later slice) loads a checkpoint + replays
 * only the sealed tail (head_seq+1..tail); on ANY trust-chain failure it falls
 * back to projection files.
 *
 * This slice is strictly ADDITIVE: it builds/verifies/replays checkpoints but
 * is not yet wired into the read path, so it carries zero read-path risk.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { journalDir, readJournalRecords, journalHeadSeq, type JournalRecord } from './journal.js';
import { applyRecordsToLive, projectLiveToState, type MaterializedEntity } from './materialize.js';
import { loadConfig } from '../config.js';
import { writeFileAtomic } from '../io.js';
import { nowISO } from '../ids.js';
import type { State } from '../schema.js';

const CHECKPOINT_SCHEMA_VERSION = 1 as const;

/**
 * The capability vector a checkpoint was built under (pln#566 F5). Serving a
 * checkpoint requires the manifest's vector to be compatible with the active
 * flags per the monotonicity table (enforced by the read path in a later
 * slice). Recorded now so checkpoints built today remain self-describing.
 */
export interface CheckpointCapabilityVector {
  checkpointRead: boolean;
  readReconcile: boolean;
  tombstoneDelete: boolean;
  perEntityPatch: boolean;
}

export const BASELINE_CAPABILITIES: CheckpointCapabilityVector = {
  checkpointRead: false,
  readReconcile: false,
  tombstoneDelete: false,
  perEntityPatch: false,
};

export interface CheckpointManifest {
  schema_version: typeof CHECKPOINT_SCHEMA_VERSION;
  /** Binds the checkpoint to a store identity (rejects copied/wrong-branch checkpoints). */
  store_id: string;
  /** The seq actually materialized into the snapshot (never an assumed tail). */
  head_seq: number;
  /** sha256 of the covered head record's identity tuple — binds to journal lineage. */
  head_identity: string;
  /** sha256 of the snapshot blob bytes — integrity. */
  snapshot_sha256: string;
  entity_count: number;
  capability_vector: CheckpointCapabilityVector;
  created_at: string;
}

function checkpointsDir(cwd?: string): string {
  return path.join(journalDir(cwd), 'checkpoints');
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * pln#566 F4 guard: materialize (the reducer behind both checkpoint build and
 * checkpoint+tail replay) only consumes inline `rec.payload`; it does NOT yet
 * dereference `payload_ref`. So if ANY journal record externalized its payload,
 * a checkpoint built/served from the journal would silently DROP that entity.
 * Until payload_ref dereference lands, refuse to build or serve a checkpoint
 * when externalized payloads exist — the read path falls back to projection
 * files, which always carry the full content. Conservative (whole-journal, not
 * just memory-tier) and cheap.
 */
function journalHasExternalizedPayload(records: JournalRecord[]): boolean {
  return records.some(r => r.payload_ref != null);
}

/** Identity of a record for journal-lineage binding: stable across reads, changes if the head record changes. */
function recordIdentity(rec: JournalRecord): string {
  return sha256(`${rec.seq}|${rec.writer}|${rec.ts}|${rec.action}|${rec.item_type}|${rec.item_id ?? ''}`);
}

/** The record carrying the maximum seq (the covered head). Undefined for an empty journal. */
function headRecord(records: JournalRecord[]): JournalRecord | undefined {
  let head: JournalRecord | undefined;
  for (const rec of records) {
    if (!head || rec.seq > head.seq) head = rec;
  }
  return head;
}

function manifestPath(cwd: string | undefined, headSeq: number): string {
  return path.join(checkpointsDir(cwd), `${String(headSeq).padStart(12, '0')}.manifest.json`);
}
function snapshotPath(cwd: string | undefined, headSeq: number): string {
  return path.join(checkpointsDir(cwd), `${String(headSeq).padStart(12, '0')}.snapshot.json`);
}

export interface CreateCheckpointResult {
  created: boolean;
  manifest?: CheckpointManifest;
  reason?: string;
}

/**
 * Build a journal-derived checkpoint at the current journal head. Materializes
 * the live entity set from the journal (NOT from projections), writes the
 * snapshot blob, then publishes the manifest (the manifest is the commit
 * point — an orphan snapshot without a manifest is ignored).
 *
 * NOTE (F6): this slice materializes from the full journal on demand. The
 * incremental "latest verified checkpoint + sealed tail, built outside the hot
 * lock" optimization is a later slice; on-demand build here is not on the hot
 * write path.
 */
export function createCheckpoint(cwd?: string, capabilities: CheckpointCapabilityVector = BASELINE_CAPABILITIES): CreateCheckpointResult {
  // Cap to the COMMITTED head (meta.next_seq-1, published after fsync). The
  // raw segment read is lock-free, so a concurrent append may have written —
  // but not yet fsync'd/published — records beyond the committed head; excluding
  // them keeps the manifest bound to durable journal state (codex review MED).
  const committedHead = journalHeadSeq(cwd);
  const records = readJournalRecords(cwd).filter(r => r.seq <= committedHead);
  const head = headRecord(records);
  if (!head) return { created: false, reason: 'empty journal — nothing to checkpoint' };
  if (journalHasExternalizedPayload(records)) {
    return { created: false, reason: 'journal has externalized payload_ref records; materialize cannot dereference them yet (pln#566 F4)' };
  }

  const live = applyRecordsToLive(records, new Map());
  const entities = [...live.values()];
  const snapshot = JSON.stringify(entities);
  const manifest: CheckpointManifest = {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    store_id: loadConfig(cwd).project_id ?? 'unknown',
    head_seq: head.seq,
    head_identity: recordIdentity(head),
    snapshot_sha256: sha256(snapshot),
    entity_count: entities.length,
    capability_vector: capabilities,
    created_at: nowISO(),
  };

  const dir = checkpointsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  // Snapshot first, manifest last (commit point).
  writeFileAtomic(snapshotPath(cwd, head.seq), snapshot);
  writeFileAtomic(manifestPath(cwd, head.seq), JSON.stringify(manifest));
  return { created: true, manifest };
}

/** Default: create a fresh checkpoint once the journal has grown this many
 *  records past the last checkpoint head. Bounds the sealed tail so
 *  checkpointRead's gap-replay stays cheap, without checkpointing every persist. */
export const DEFAULT_CHECKPOINT_INTERVAL = 500;

export interface MaybeCheckpointResult {
  created: boolean;
  /** Records the journal grew since the last checkpoint (drove the decision). */
  gap: number;
  reason?: string;
}

/**
 * Create a checkpoint ONLY if the journal has grown >= interval records past
 * the last checkpoint head (cheap head-seq check; no full scan unless building).
 * Intended for off-hot-path callers (session-start maintenance). Journal-derived
 * (F6). No-op when the journal is off/empty or hasn't grown enough.
 */
export function maybeCreateCheckpoint(cwd?: string, interval = DEFAULT_CHECKPOINT_INTERVAL): MaybeCheckpointResult {
  const head = journalHeadSeq(cwd);
  if (head === 0) return { created: false, gap: 0, reason: 'journal empty/off' };
  const last = loadLatestCheckpointManifest(cwd)?.head_seq ?? 0;
  const gap = head - last;
  if (gap < interval) return { created: false, gap, reason: `gap ${gap} < interval ${interval}` };
  const res = createCheckpoint(cwd);
  return { created: res.created, gap, reason: res.reason };
}

/**
 * Highest-head_seq manifest on disk, or undefined if none. Selects by NUMERIC
 * head_seq parsed from the filename — lexicographic order on the 12-zero-pad
 * breaks once seq exceeds 12 digits (codex review LOW).
 */
export function loadLatestCheckpointManifest(cwd?: string): CheckpointManifest | undefined {
  const dir = checkpointsDir(cwd);
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.manifest.json'))
    .sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0)); // numeric desc on the seq prefix
  for (const f of files) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as CheckpointManifest;
    } catch { /* skip corrupt manifest, try the next */ }
  }
  return undefined;
}

export interface CheckpointVerification {
  valid: boolean;
  reason?: string;
}

function isMaterializedEntityArray(v: unknown): v is MaterializedEntity[] {
  return Array.isArray(v) && v.every(e =>
    !!e && typeof e === 'object'
    && typeof (e as MaterializedEntity).item_type === 'string'
    && typeof (e as MaterializedEntity).item_id === 'string'
    && !!(e as MaterializedEntity).payload && typeof (e as MaterializedEntity).payload === 'object');
}

interface CheckpointVerificationInternal extends CheckpointVerification {
  /** The validated snapshot entities, so the caller need not re-parse unchecked bytes. */
  entities?: MaterializedEntity[];
}

/**
 * Verify a checkpoint against an ALREADY-READ record set — never throws,
 * validates snapshot SHAPE (not just sha256), and binds to the SAME journal
 * view the caller will serve from (no verify/serve TOCTOU). WITHOUT reading
 * projection files (F3). Returns the parsed entities when valid.
 */
function verifyCheckpointAgainstRecords(
  manifest: CheckpointManifest, snapshotRaw: string, records: JournalRecord[], cwd?: string,
): CheckpointVerificationInternal {
  try {
    if (manifest.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
      return { valid: false, reason: `unsupported checkpoint schema_version ${manifest.schema_version}` };
    }
    if (sha256(snapshotRaw) !== manifest.snapshot_sha256) {
      return { valid: false, reason: 'snapshot sha256 mismatch (corrupt/tampered blob)' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(snapshotRaw); } catch { return { valid: false, reason: 'snapshot is not valid JSON' }; }
    if (!isMaterializedEntityArray(parsed)) return { valid: false, reason: 'snapshot is not a MaterializedEntity[]' };
    const expectedStore = loadConfig(cwd).project_id ?? 'unknown';
    if (manifest.store_id !== expectedStore) {
      return { valid: false, reason: `store_id mismatch (manifest ${manifest.store_id} vs ${expectedStore}) — copied/wrong-branch checkpoint` };
    }
    const head = records.find(r => r.seq === manifest.head_seq);
    if (!head) return { valid: false, reason: `head_seq ${manifest.head_seq} not found in journal` };
    if (recordIdentity(head) !== manifest.head_identity) {
      return { valid: false, reason: 'head record identity mismatch — journal lineage diverged from checkpoint' };
    }
    return { valid: true, entities: parsed };
  } catch (err) {
    return { valid: false, reason: `verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Public no-throw verification: snapshot integrity + shape, store binding, and
 * journal-lineage binding. Reads the journal once. Returns valid:false on any
 * failure (never throws) so callers fall back.
 */
export function verifyCheckpoint(manifest: CheckpointManifest, snapshotRaw: string, cwd?: string): CheckpointVerification {
  let records: JournalRecord[];
  try { records = readJournalRecords(cwd); } catch (err) {
    return { valid: false, reason: `journal read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const r = verifyCheckpointAgainstRecords(manifest, snapshotRaw, records, cwd);
  return { valid: r.valid, reason: r.reason };
}

/**
 * Materialize state from the latest VERIFIED checkpoint + the sealed tail
 * (records with seq > head_seq), using the same reducer + projector as
 * full-journal materialization. Reads the journal exactly ONCE and uses that
 * single view for verification, the F4 payload_ref guard, and the tail replay
 * (no TOCTOU). Returns null on any failure (caller falls back to projections).
 */
export function materializeStateFromCheckpoint(cwd?: string): State | null {
  const manifest = loadLatestCheckpointManifest(cwd);
  if (!manifest) return null;
  let snapshotRaw: string;
  try {
    snapshotRaw = fs.readFileSync(snapshotPath(cwd, manifest.head_seq), 'utf-8');
  } catch {
    return null; // orphan manifest without a readable snapshot
  }
  let records: JournalRecord[];
  // Same committed-head cap as the build path: only durable records (seq <=
  // meta.next_seq-1) drive verification, the F4 guard, and the tail replay.
  try {
    const committedHead = journalHeadSeq(cwd);
    records = readJournalRecords(cwd).filter(r => r.seq <= committedHead);
  } catch { return null; }

  const verdict = verifyCheckpointAgainstRecords(manifest, snapshotRaw, records, cwd);
  if (!verdict.valid || !verdict.entities) return null;
  // F4 guard: an externalized payload (which materialize can't deref) means the
  // checkpoint/tail would drop entities — refuse to serve, fall back.
  if (journalHasExternalizedPayload(records)) return null;

  const live = new Map<string, MaterializedEntity>();
  for (const e of verdict.entities) live.set(`${e.item_type}:${e.item_id}`, e);
  // Replay only the sealed tail (head_seq+1..end) from the SAME record view.
  applyRecordsToLive(records.filter(r => r.seq > manifest.head_seq), live);
  return projectLiveToState(live);
}
