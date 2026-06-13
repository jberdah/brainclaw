/**
 * Observer journal consumer (pln#560 step 2, slice 1).
 *
 * A PURE, read-only consumer of the brainclaw event journal per
 * docs/concepts/observer-protocol.md: tails `.brainclaw/events/seg-*.jsonl`
 * from a seq watermark, projects board state in memory by applying each record
 * by its action CLASS, and never writes inside `.brainclaw/` or acquires a
 * lock. This module is self-contained (no MCP, no store lock) so it can be
 * wired into the tree provider (slice 2) to replace the polling display path.
 *
 * @module
 */
import * as fs from 'fs';
import * as path from 'path';

/** Action → class. Mirror of ACTION_CLASS_BY_ACTION in the core event-log
 *  (observer-protocol.md §2). Verbs not listed are resolved by prefix
 *  (assignment_* / run_* = registry-lifecycle) or treated as unknown. */
export type EventClass = 'entity-state' | 'tombstone' | 'journal-meta' | 'observability' | 'registry-lifecycle';

const ACTION_CLASS: Readonly<Record<string, EventClass>> = {
  create: 'entity-state', update: 'entity-state', accept: 'entity-state', reject: 'entity-state',
  claim: 'entity-state', release_claim: 'entity-state', rollback: 'entity-state', upgrade: 'entity-state',
  backfill: 'entity-state',
  delete: 'tombstone',
  checkpoint_ref: 'journal-meta', journal_note: 'journal-meta', seq_repair: 'journal-meta', federation_apply: 'journal-meta',
  session_start: 'observability', session_end: 'observability',
  assignment_offered: 'observability', assignment_progress: 'observability', run_progress: 'observability',
};

/** Resolve the class of an action, or `undefined` when unknown (forward-compat). */
export function classifyAction(action: string): EventClass | undefined {
  const known = ACTION_CLASS[action];
  if (known) { return known; }
  if (/^assignment_/.test(action) || /^run_/.test(action)) { return 'registry-lifecycle'; }
  return undefined;
}

export interface JournalRecord {
  v: number;
  seq: number;
  ts?: string;
  writer?: string;
  agent?: string;
  action: string;
  item_type: string;
  item_id?: string;
  entity_rev?: number;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface ProjectionEntry {
  item_type: string;
  item_id: string;
  entity_rev?: number;
  payload: Record<string, unknown>;
}

/** In-memory board projection keyed by `${item_type}:${item_id}`. */
export type Projection = Map<string, ProjectionEntry>;

/** Cursor lives OUTSIDE the store (client storage), keyed by project_id (§3). */
export interface ObserverCursor {
  seq: number;
  checkpoint_seq: number;
}

export function cursorKey(projectId: string): string {
  return `bclaw.observer.cursor.${projectId}`;
}

/**
 * Apply ONE record to the projection by class (§2). Returns the affected
 * item_type when the record changed state (for section-scoped refresh), else
 * undefined (observability / journal-meta / payload-less are activity-only).
 */
export function applyRecord(projection: Projection, rec: JournalRecord): string | undefined {
  if (!rec.item_id) { return undefined; }
  const cls = classifyAction(rec.action);
  const key = `${rec.item_type}:${rec.item_id}`;

  if (cls === 'tombstone') {
    return projection.delete(key) ? rec.item_type : undefined;
  }
  // entity-state and registry-lifecycle upsert when a payload is present;
  // an unknown action with a payload is applied as a state upsert too
  // (forward-compatible — never crash on a new verb, observer-protocol §2).
  const upsertClass = cls === 'entity-state' || cls === 'registry-lifecycle' || cls === undefined;
  // Inline payload-object check so TS narrows rec.payload to a defined object.
  if (upsertClass && rec.payload && typeof rec.payload === 'object' && !Array.isArray(rec.payload)) {
    projection.set(key, { item_type: rec.item_type, item_id: rec.item_id, entity_rev: rec.entity_rev, payload: rec.payload });
    return rec.item_type;
  }
  // observability, journal-meta, payload-less registry signals → activity only.
  return undefined;
}

// 8-digit zero-pad is NORMATIVE (observer-protocol §2): only that fixed width
// makes a lexicographic directory sort match numeric seq order. Reject any
// other width (seg-2.jsonl / seg-10.jsonl would mis-sort); a future >8-digit
// widening is a coordinated migration, not an incidental accept.
const SEGMENT_RE = /^seg-\d{8}\.jsonl$/;

/** List segment files in (numeric first-seq) order — the canonical replay order. */
export function listSegments(eventsDir: string): string[] {
  let entries: string[];
  try { entries = fs.readdirSync(eventsDir); } catch { return []; }
  return entries.filter((f) => SEGMENT_RE.test(f)).sort(); // 8-digit zero-pad => lex sort == numeric (protocol §2)
}

/**
 * Tail every record with seq > fromSeq across segments in (segment, file-line)
 * order. Torn/unparseable lines (crash residue mid-write) are SKIPPED, never
 * thrown on (§5). Records below/at fromSeq are ignored (already applied).
 */
export function tailRecords(eventsDir: string, fromSeq: number): JournalRecord[] {
  const out: JournalRecord[] = [];
  for (const seg of listSegments(eventsDir)) {
    let content: string;
    try { content = fs.readFileSync(path.join(eventsDir, seg), 'utf-8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line) { continue; }
      let rec: JournalRecord;
      try { rec = JSON.parse(line) as JournalRecord; } catch { continue; } // torn tail / partial line
      // Stricter than "is a number": a corrupt-but-parseable fractional/huge seq
      // must NOT advance the cursor past later valid records (applyTail takes the
      // max accepted seq). Keep unknown ACTION strings allowed (forward-compat).
      if (rec.v !== 2) { continue; }
      if (!Number.isSafeInteger(rec.seq) || rec.seq <= 0) { continue; }
      if (typeof rec.action !== 'string' || !rec.action) { continue; }
      if (typeof rec.item_type !== 'string' || !rec.item_type) { continue; }
      if (rec.payload !== undefined && (typeof rec.payload !== 'object' || rec.payload === null || Array.isArray(rec.payload))) { continue; }
      if (rec.seq > fromSeq) { out.push(rec); }
    }
  }
  return out;
}

export interface TailResult {
  applied: number;
  cursor: ObserverCursor;
  /** item_types whose section changed — drives section-scoped refresh (slice 2). */
  affectedTypes: Set<string>;
}

/**
 * Apply the journal tail (records past cursor.seq) to the projection in place.
 * Returns the advanced cursor + the set of affected item_types. No checkpoint
 * branch yet — the writer does not emit checkpoints today (protocol §5), so the
 * primary path is empty-seed + full tail from cursor.seq.
 */
export function applyTail(projection: Projection, eventsDir: string, cursor: ObserverCursor): TailResult {
  const records = tailRecords(eventsDir, cursor.seq);
  const affectedTypes = new Set<string>();
  let maxSeq = cursor.seq;
  for (const rec of records) {
    const affected = applyRecord(projection, rec);
    if (affected) { affectedTypes.add(affected); }
    if (rec.seq > maxSeq) { maxSeq = rec.seq; }
  }
  return { applied: records.length, cursor: { seq: maxSeq, checkpoint_seq: cursor.checkpoint_seq }, affectedTypes };
}

/** Group the projection into board sections keyed by item_type (for the tree). */
export function projectSections(projection: Projection): Map<string, ProjectionEntry[]> {
  const sections = new Map<string, ProjectionEntry[]>();
  for (const entry of projection.values()) {
    const list = sections.get(entry.item_type) ?? [];
    list.push(entry);
    sections.set(entry.item_type, list);
  }
  return sections;
}
