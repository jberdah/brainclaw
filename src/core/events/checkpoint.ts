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
import { journalDir, readJournalRecords, type JournalRecord } from './journal.js';
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
  const records = readJournalRecords(cwd);
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

/** Highest-head_seq manifest on disk, or undefined if none. */
export function loadLatestCheckpointManifest(cwd?: string): CheckpointManifest | undefined {
  const dir = checkpointsDir(cwd);
  if (!fs.existsSync(dir)) return undefined;
  const manifests = fs.readdirSync(dir).filter(f => f.endsWith('.manifest.json')).sort();
  for (let i = manifests.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, manifests[i]!), 'utf-8')) as CheckpointManifest;
    } catch { /* skip corrupt manifest, try the next-oldest */ }
  }
  return undefined;
}

export interface CheckpointVerification {
  valid: boolean;
  reason?: string;
}

/**
 * Verify a checkpoint is trustworthy WITHOUT reading projection files (F3):
 * snapshot integrity (sha256), store binding, journal-lineage binding (the
 * covered head record still exists in the journal with the same identity), and
 * schema support. Returns valid:false (never throws) so callers fall back.
 */
export function verifyCheckpoint(manifest: CheckpointManifest, snapshotRaw: string, cwd?: string): CheckpointVerification {
  if (manifest.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
    return { valid: false, reason: `unsupported checkpoint schema_version ${manifest.schema_version}` };
  }
  if (sha256(snapshotRaw) !== manifest.snapshot_sha256) {
    return { valid: false, reason: 'snapshot sha256 mismatch (corrupt/tampered blob)' };
  }
  const expectedStore = loadConfig(cwd).project_id ?? 'unknown';
  if (manifest.store_id !== expectedStore) {
    return { valid: false, reason: `store_id mismatch (manifest ${manifest.store_id} vs ${expectedStore}) — copied/wrong-branch checkpoint` };
  }
  // Journal-lineage binding: the covered head record must still be present with the same identity.
  const head = readJournalRecords(cwd).find(r => r.seq === manifest.head_seq);
  if (!head) return { valid: false, reason: `head_seq ${manifest.head_seq} not found in journal` };
  if (recordIdentity(head) !== manifest.head_identity) {
    return { valid: false, reason: 'head record identity mismatch — journal lineage diverged from checkpoint' };
  }
  return { valid: true };
}

/**
 * Materialize state from the latest VERIFIED checkpoint + the sealed tail
 * (records with seq > head_seq), using the same reducer + projector as
 * full-journal materialization. Returns null when there is no verified
 * checkpoint (caller falls back to a full journal replay or projection files).
 * This is the substrate for the cold-read fast path (later slice).
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
  if (!verifyCheckpoint(manifest, snapshotRaw, cwd).valid) return null;

  // F4 guard: if any record (snapshot-era or tail) externalized its payload,
  // materialize would drop it — refuse to serve, fall back to projections.
  const records = readJournalRecords(cwd);
  if (journalHasExternalizedPayload(records)) return null;

  const entities = JSON.parse(snapshotRaw) as MaterializedEntity[];
  const live = new Map<string, MaterializedEntity>();
  for (const e of entities) live.set(`${e.item_type}:${e.item_id}`, e);

  // Replay only the sealed tail (head_seq+1..end) — the gap since the checkpoint.
  applyRecordsToLive(records.filter(r => r.seq > manifest.head_seq), live);
  return projectLiveToState(live);
}
