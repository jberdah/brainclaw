/**
 * Event journal v2 — write path (pln#543 step 2).
 *
 * Implements the append side of docs/concepts/event-log-store.md:
 * segmented append-only journal under `.brainclaw/events/`, store-global
 * seq allocated under the store lock (§2.2), single-buffer framed appends
 * with torn-tail adjudication (§2.6), fsync-per-mutation policy (§2.7),
 * and the action-class table with mode-gated validation (§2.1.1, R1).
 *
 * Feature flag: BRAINCLAW_JOURNAL_MODE=off|dual (default off — no behavior
 * change). Config-file wiring lands with the cutover step (plan step 5);
 * primary/registryPrimary modes are declared but resolve to 'dual' with a
 * one-time warning until projections (step 3) and migration (step 4) exist.
 *
 * In dual mode the v1 store remains the source of truth: journal failures
 * are loud (logger.warn + counter) but never fail the mutation. The §2.6
 * "append failures are loud" rule binds at journal-primary, not rehearsal.
 *
 * Checkpoints at segment roll (§2.4) arrive with step 3 (they snapshot
 * projections, which do not exist yet); rolls here create the next segment
 * without one.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { memoryDir, writeFileAtomic } from '../io.js';
import { mutate } from '../mutation-pipeline.js';
import { loadConfig } from '../config.js';
import { nowISO } from '../ids.js';
import { logger } from '../logger.js';
import type { EventAction, EventItemType } from '../event-log.js';

// --- v2 action union (§2.1.1) ---

/** Journal-meta actions — `item_type: "journal"`, meta-schema payloads (§2.1.2). */
export type JournalMetaAction =
  | 'checkpoint_ref'
  | 'journal_note'
  | 'seq_repair'
  | 'federation_apply';

/**
 * Progress-split verbs (§2.1.1 heartbeat/durable resolution, 2026-06-12).
 * Declared now so the frozen union needs no post-freeze extension; the
 * write-path split that emits them lands at phase 1.5.
 */
export type ProgressSplitAction = 'run_progress' | 'assignment_amended' | 'run_amended';

export type EventActionV2 = EventAction | 'backfill' | JournalMetaAction | ProgressSplitAction;

export type EventItemTypeV2 = EventItemType | 'journal';

export type ActionClass =
  | 'entity-state'
  | 'tombstone'
  | 'journal-meta'
  | 'observability'
  | 'registry-lifecycle';

/**
 * Normative class per action (§2.1.1). The class is NEVER serialized —
 * `action` is the only wire discriminant (R1). `satisfies` makes an
 * unclassified 43rd action a compile error instead of a runtime surprise.
 */
export const ACTION_CLASS_BY_ACTION = {
  create: 'entity-state',
  update: 'entity-state',
  accept: 'entity-state',
  reject: 'entity-state',
  claim: 'entity-state',
  release_claim: 'entity-state',
  rollback: 'entity-state',
  upgrade: 'entity-state',
  backfill: 'entity-state',
  delete: 'tombstone',
  checkpoint_ref: 'journal-meta',
  journal_note: 'journal-meta',
  seq_repair: 'journal-meta',
  federation_apply: 'journal-meta',
  session_start: 'observability',
  session_end: 'observability',
  assignment_offered: 'observability',
  assignment_progress: 'observability',
  run_progress: 'observability',
  assignment_created: 'registry-lifecycle',
  assignment_accepted: 'registry-lifecycle',
  assignment_started: 'registry-lifecycle',
  assignment_completed: 'registry-lifecycle',
  assignment_cancelled: 'registry-lifecycle',
  assignment_failed: 'registry-lifecycle',
  assignment_blocked: 'registry-lifecycle',
  assignment_timed_out: 'registry-lifecycle',
  assignment_expired: 'registry-lifecycle',
  assignment_retrying: 'registry-lifecycle',
  assignment_rerouted: 'registry-lifecycle',
  assignment_amended: 'registry-lifecycle',
  run_created: 'registry-lifecycle',
  run_launching: 'registry-lifecycle',
  run_waiting_input: 'registry-lifecycle',
  run_running: 'registry-lifecycle',
  run_blocked: 'registry-lifecycle',
  run_completed: 'registry-lifecycle',
  run_failed: 'registry-lifecycle',
  run_cancelled: 'registry-lifecycle',
  run_timed_out: 'registry-lifecycle',
  run_interrupted: 'registry-lifecycle',
  run_amended: 'registry-lifecycle',
} as const satisfies Record<EventActionV2, ActionClass>;

const ALL_V2_ACTIONS = Object.keys(ACTION_CLASS_BY_ACTION) as [EventActionV2, ...EventActionV2[]];

// --- v2 record envelope (§2.1) ---

export const JournalRecordSchema = z.object({
  v: z.literal(2),
  seq: z.number().int().positive(),
  ts: z.string(),
  writer: z.string().min(1),
  agent: z.string().min(1),
  agent_id: z.string().optional(),
  session_id: z.string().optional(),
  user: z.string().optional(),
  action: z.enum(ALL_V2_ACTIONS),
  item_type: z.string().min(1),
  item_id: z.string().optional(),
  entity_rev: z.number().int().positive().optional(),
  summary: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  /** §2.10 — declared for forward-compat; the externalization path is phase 1. */
  payload_ref: z.object({ sha256: z.string(), bytes: z.number().int().positive() }).optional(),
});

export type JournalRecord = z.infer<typeof JournalRecordSchema>;

/** Caller-facing input: the envelope minus what the journal assigns. */
export interface JournalAppendInput {
  action: EventActionV2;
  item_type: EventItemTypeV2;
  item_id?: string;
  agent?: string;
  agent_id?: string;
  session_id?: string;
  user?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  ts?: string;
}

// --- Mode flag ---

export type JournalMode = 'off' | 'dual' | 'primary' | 'registryPrimary';

let warnedUnsupportedMode = false;

function coerceMode(raw: string | undefined): JournalMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'dual') return 'dual';
  if (v === 'primary' || v === 'registryprimary') {
    if (!warnedUnsupportedMode) {
      warnedUnsupportedMode = true;
      logger.warn(`journal mode "${v}" not available until the primary cutover (pln#543 step 5) — running dual`);
    }
    return 'dual';
  }
  return undefined; // unrecognized → let the next source decide
}

/** Read the persisted journal mode from config.yaml (best-effort, off on any failure). */
function configJournalMode(cwd?: string): JournalMode | undefined {
  try {
    return coerceMode(loadConfig(cwd).store?.journal?.mode);
  } catch {
    return undefined; // uninitialized / unreadable config → no opinion
  }
}

/**
 * Resolve the journal mode. Precedence: the BRAINCLAW_JOURNAL_MODE env var
 * (a per-process override — tests and one-off runs use it) wins when set;
 * otherwise the persisted config.yaml `store.journal.mode`; otherwise off.
 * Config is read live (not cached) so a flip in config.yaml is picked up by a
 * running MCP server on its next mutation — no restart, unlike an env change
 * (trp#522 cold-start). Mutations are human-paced, so the small config read is
 * negligible next to the persist it gates.
 */
export function resolveJournalMode(cwd?: string): JournalMode {
  return coerceMode(process.env.BRAINCLAW_JOURNAL_MODE) ?? configJournalMode(cwd) ?? 'off';
}

type FsyncPolicy = 'mutation' | 'never';

function resolveFsyncPolicy(cwd?: string): FsyncPolicy {
  if (process.env.BRAINCLAW_JOURNAL_FSYNC?.trim() === 'never') return 'never';
  try {
    if (loadConfig(cwd).store?.journal?.fsync === 'never') return 'never';
  } catch { /* no config → default */ }
  return 'mutation';
}

/**
 * Phase-3 primary capability: serve cold reads from a journal-derived
 * checkpoint + sealed tail instead of reading every projection file (pln#566
 * Inc0 s2). OFF by default and ONLY in a primary-family mode — in dual/off the
 * projection files remain the read substrate, so this is a no-op until a soak
 * explicitly enables it. A truthy boolean here is necessary but not sufficient:
 * the read path still verifies the checkpoint and falls back on any failure.
 */
export function resolveCheckpointRead(cwd?: string): boolean {
  const env = process.env.BRAINCLAW_PRIMARY_CHECKPOINT_READ?.trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'on') return true;
  if (env === '0' || env === 'false' || env === 'off') return false;
  try {
    return loadConfig(cwd).store?.journal?.primary?.checkpointRead === true;
  } catch {
    return false;
  }
}

// --- Writer identity (§2.1: pid + start-nonce, never bare pid) ---

const WRITER_ID = `w_${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

export function journalWriterId(): string {
  return WRITER_ID;
}

// --- Layout (§2.3) ---

const SEGMENT_PREFIX = 'seg-';
const SEGMENT_PAD = 8;
const DEFAULT_SEGMENT_ROLL_BYTES = 10 * 1024 * 1024;

function segmentRollBytes(): number {
  const raw = Number(process.env.BRAINCLAW_JOURNAL_SEGMENT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SEGMENT_ROLL_BYTES;
}

export function journalDir(cwd?: string): string {
  return path.join(memoryDir(cwd), 'events');
}

function metaPath(cwd?: string): string {
  return path.join(journalDir(cwd), 'meta.json');
}

function segmentName(firstSeq: number): string {
  return `${SEGMENT_PREFIX}${String(firstSeq).padStart(SEGMENT_PAD, '0')}.jsonl`;
}

function listSegments(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(SEGMENT_PREFIX) && f.endsWith('.jsonl'))
    .sort();
}

/**
 * Read every valid v2 record across all segments in (segment, file-line)
 * order — the canonical replay order (§2.2: never sorted by seq). Torn or
 * schema-invalid lines are skipped per the §2.6 reader rules. This is the
 * substrate for journal→projection materialization (materialize.ts).
 */
export function readJournalRecords(cwd?: string): JournalRecord[] {
  const dir = journalDir(cwd);
  const records: JournalRecord[] = [];
  for (const seg of listSegments(dir)) {
    const lines = fs.readFileSync(path.join(dir, seg), 'utf-8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      const rec = parseRecordLine(line);
      if (rec) records.push(rec);
    }
  }
  return records;
}

// --- Meta (rebuildable cache, §2.3) ---

interface JournalMeta {
  next_seq: number;
  active_segment: string;
  /** Per-entity monotonic revision counter (§2.1 entity_rev). */
  entity_revs: Record<string, number>;
}

function freshMeta(): JournalMeta {
  return { next_seq: 1, active_segment: segmentName(1), entity_revs: {} };
}

function parseRecordLine(line: string): JournalRecord | undefined {
  try {
    const parsed = JournalRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rebuild meta from the segment listing + a full scan (§2.3: meta is a
 * cache; the journal is the truth). Scan cost is bounded by retention and
 * paid only on missing/corrupt meta.
 */
function rebuildMeta(dir: string): JournalMeta {
  const segments = listSegments(dir);
  if (segments.length === 0) return freshMeta();

  const meta: JournalMeta = { next_seq: 1, active_segment: segments[segments.length - 1], entity_revs: {} };
  for (const seg of segments) {
    const lines = fs.readFileSync(path.join(dir, seg), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const rec = parseRecordLine(line);
      if (!rec) continue;
      if (rec.seq >= meta.next_seq) meta.next_seq = rec.seq + 1;
      if (rec.item_id && rec.entity_rev !== undefined) {
        const prev = meta.entity_revs[rec.item_id] ?? 0;
        if (rec.entity_rev > prev) meta.entity_revs[rec.item_id] = rec.entity_rev;
      }
    }
  }
  return meta;
}

function loadOrRebuildMeta(dir: string): JournalMeta {
  const fp = path.join(dir, 'meta.json');
  if (fs.existsSync(fp)) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<JournalMeta>;
      if (typeof raw.next_seq === 'number' && raw.next_seq >= 1 && typeof raw.active_segment === 'string') {
        return { next_seq: raw.next_seq, active_segment: raw.active_segment, entity_revs: raw.entity_revs ?? {} };
      }
    } catch { /* fall through to rebuild */ }
  }
  return rebuildMeta(dir);
}

function saveMeta(dir: string, meta: JournalMeta): void {
  writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

/**
 * Highest DURABLE seq present in the journal, cheaply — META-CACHE ONLY (no
 * rebuild). meta.next_seq is published AFTER the append fsync, so next_seq-1 is
 * the last committed record. Returns 0 on absent/corrupt/invalid meta — never
 * falls back to a full segment scan (the whole point: the "should I checkpoint
 * yet?" gate must stay O(1), pln#566 Inc0; codex review MED). Callers that need
 * exact recovery use loadOrRebuildMeta on the writer/status path instead.
 */
export function journalHeadSeq(cwd?: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath(cwd), 'utf-8')) as Partial<JournalMeta>;
    if (typeof raw.next_seq === 'number' && Number.isFinite(raw.next_seq) && raw.next_seq >= 1) {
      return raw.next_seq - 1;
    }
  } catch { /* absent/corrupt/unreadable meta → 0 (no scan) */ }
  return 0;
}

// --- Tail validation + torn-tail adjudication (§2.2, §2.6) ---

interface TailInspection {
  /** Highest seq parsed from the segment tail; 0 when none. */
  tailSeq: number;
  /** Unterminated or unparseable final line, if any. */
  tornFragment?: { byte_start: number; byte_end: number; sha256: string };
}

function inspectTail(segPath: string): TailInspection {
  if (!fs.existsSync(segPath)) return { tailSeq: 0 };
  const content = fs.readFileSync(segPath, 'utf-8');
  if (content.length === 0) return { tailSeq: 0 };

  const lines = content.split('\n');
  const terminated = content.endsWith('\n');
  let tailSeq = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    const rec = parseRecordLine(lines[i]);
    if (rec) { tailSeq = rec.seq; break; }
    // keep scanning past trailing garbage to find the last valid record
  }

  const lastNonEmpty = [...lines].reverse().find(l => l.length > 0);
  if (lastNonEmpty && (!terminated || !parseRecordLine(lastNonEmpty))) {
    const fragBytes = Buffer.byteLength(lastNonEmpty, 'utf-8');
    const total = Buffer.byteLength(content, 'utf-8');
    const end = terminated ? total - 1 : total;
    return {
      tailSeq,
      tornFragment: {
        byte_start: end - fragBytes,
        byte_end: end,
        sha256: crypto.createHash('sha256').update(lastNonEmpty).digest('hex'),
      },
    };
  }
  return { tailSeq };
}

// --- Validation (mode-gated, §2.1.1 + R1) ---

export interface RecordViolation {
  seq: number;
  action: EventActionV2;
  rule: string;
}

function classViolations(record: JournalRecord): string[] {
  const cls = ACTION_CLASS_BY_ACTION[record.action as EventActionV2];
  const issues: string[] = [];
  switch (cls) {
    case 'entity-state':
      if (!record.item_id) issues.push('entity-state requires item_id');
      if (record.entity_rev === undefined) issues.push('entity-state requires entity_rev');
      if (!record.payload && !record.payload_ref) issues.push('entity-state requires payload (post-image)');
      break;
    case 'tombstone':
      if (!record.item_id) issues.push('tombstone requires item_id');
      if (record.payload) issues.push('tombstone forbids payload');
      break;
    case 'journal-meta':
      if (record.item_type !== 'journal') issues.push('journal-meta requires item_type "journal"');
      if (record.item_id) issues.push('journal-meta forbids item_id');
      if (!record.payload) issues.push('journal-meta requires payload');
      break;
    case 'observability':
      if (record.payload) issues.push('observability forbids payload');
      break;
    case 'registry-lifecycle':
      if (!record.item_id) issues.push('registry-lifecycle requires item_id');
      // payload OPTIONAL until phase 1.5 (J4) — no rule here in dual.
      break;
  }
  return issues;
}

// --- Append path ---

let violationCount = 0;
let failureCount = 0;

export interface JournalStatus {
  mode: JournalMode;
  next_seq: number;
  segments: number;
  violations: number;
  failures: number;
  writer: string;
}

export function journalStatus(cwd?: string): JournalStatus {
  const dir = journalDir(cwd);
  const meta = fs.existsSync(dir) ? loadOrRebuildMeta(dir) : freshMeta();
  return {
    mode: resolveJournalMode(cwd),
    next_seq: meta.next_seq,
    segments: listSegments(dir).length,
    violations: violationCount,
    failures: failureCount,
    writer: WRITER_ID,
  };
}

/**
 * Append a batch of records to the journal. Seq allocation, segment
 * resolution, and the write all happen under the store-wide mutation lock
 * (§2.2: no lockless append path). The lock is reentrant in-process, so
 * calling this from inside persistState/mutateState costs a counter bump.
 *
 * Dual-mode posture: any failure is logged and counted, never thrown —
 * the v1 store is still the source of truth during rehearsal.
 *
 * Returns the appended records (empty when mode=off or on failure).
 */
export function appendJournalRecords(inputs: JournalAppendInput[], cwd?: string): JournalRecord[] {
  const mode = resolveJournalMode(cwd);
  if (mode === 'off' || inputs.length === 0) return [];

  try {
    return mutate({ cwd: cwd ?? process.cwd() }, (resolvedCwd) => appendLocked(inputs, resolvedCwd));
  } catch (err) {
    failureCount += 1;
    logger.warn('journal append failed (dual mode, v1 store unaffected):', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Append regardless of the journal mode flag — for explicit operations that
 * seed or repair the journal itself (genesis migration, doctor repair). The
 * mode flag gates the automatic dual-write from mutations, not deliberate
 * journal-authoring tools. Throws on failure (unlike the dual-write path,
 * the operator wants to know a migration write failed).
 */
export function forceAppendJournalRecords(inputs: JournalAppendInput[], cwd?: string): JournalRecord[] {
  if (inputs.length === 0) return [];
  return mutate({ cwd: cwd ?? process.cwd() }, (resolvedCwd) => appendLocked(inputs, resolvedCwd));
}

function appendLocked(inputs: JournalAppendInput[], cwd: string): JournalRecord[] {
  const dir = journalDir(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const meta = loadOrRebuildMeta(dir);
  let segPath = path.join(dir, meta.active_segment);

  // Tail validation (§2.2): re-derive next_seq from the journal; meta is a cache.
  const tail = inspectTail(segPath);
  const metaWasBehind = tail.tailSeq >= meta.next_seq;
  let nextSeq = Math.max(meta.next_seq, tail.tailSeq + 1);

  const pending: JournalRecord[] = [];
  const stamp = (input: JournalAppendInput): JournalRecord => {
    const cls = ACTION_CLASS_BY_ACTION[input.action];
    const bumpsRev = cls === 'entity-state' || cls === 'tombstone';
    let entityRev: number | undefined;
    if (bumpsRev && input.item_id) {
      entityRev = (meta.entity_revs[input.item_id] ?? 0) + 1;
      meta.entity_revs[input.item_id] = entityRev;
    }
    const record: JournalRecord = {
      v: 2,
      seq: nextSeq++,
      ts: input.ts ?? nowISO(),
      writer: WRITER_ID,
      agent: input.agent ?? 'unknown',
      agent_id: input.agent_id,
      session_id: input.session_id ?? (process.env.BRAINCLAW_SESSION_ID?.trim() || undefined),
      user: input.user ?? process.env.USER ?? process.env.USERNAME,
      action: input.action,
      item_type: input.item_type,
      item_id: input.item_id,
      entity_rev: entityRev,
      summary: input.summary,
      payload: input.payload,
    };
    return record;
  };

  if (metaWasBehind) {
    pending.push(stamp({
      action: 'seq_repair',
      item_type: 'journal',
      agent: 'system',
      payload: { meta_next_seq: meta.next_seq, tail_seq: tail.tailSeq, repaired_next_seq: tail.tailSeq + 1 },
    }));
  }
  if (tail.tornFragment) {
    pending.push(stamp({
      action: 'journal_note',
      item_type: 'journal',
      agent: 'system',
      payload: { kind: 'torn_tail_adjudicated', segment: meta.active_segment, ...tail.tornFragment },
    }));
  }
  for (const input of inputs) {
    pending.push(stamp(input));
  }

  for (const record of pending) {
    for (const rule of classViolations(record)) {
      violationCount += 1;
      logger.debug(`journal dual-mode violation seq=${record.seq} ${record.action}: ${rule}`);
    }
  }

  // Segment roll (§2.3) — checkpoint at roll arrives with step 3.
  try {
    if (fs.existsSync(segPath) && fs.statSync(segPath).size >= segmentRollBytes()) {
      meta.active_segment = segmentName(pending[0].seq);
      segPath = path.join(dir, meta.active_segment);
    }
  } catch { /* roll check best-effort; appends continue on the current segment */ }

  // Single-buffer framed write (§2.6): leading \n caps torn-write damage
  // at one record; short write throws (caught by the dual-mode boundary).
  const buffer = Buffer.from('\n' + pending.map(r =>
    JSON.stringify(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)))
  ).join('\n') + '\n', 'utf-8');

  const fd = fs.openSync(segPath, 'a');
  try {
    const written = fs.writeSync(fd, buffer, 0, buffer.length);
    if (written !== buffer.length) {
      throw new Error(`short write: ${written}/${buffer.length} bytes`);
    }
    if (resolveFsyncPolicy(cwd) === 'mutation') {
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }

  meta.next_seq = nextSeq;
  saveMeta(dir, meta);
  return pending;
}
