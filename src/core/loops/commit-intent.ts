import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { memoryDir } from '../io.js';
import { nowISO } from '../ids.js';
import { logger } from '../logger.js';
import { LoopEventSchema, LoopThreadSchema, type LoopEvent, type LoopThread } from './types.js';

/**
 * WAL commit-intent for atomic, crash-consistent, idempotent loop turn
 * completion (pln#630 PR1b, dec#137 — converged in ideation loop
 * lop_96d5324865a4c580; hardened per the symmetric review of PR #102).
 *
 * Stage the whole mutation as ONE durable intent BEFORE touching journal/thread.
 * The intent is the source of truth until fully applied. Apply is idempotent by
 * IDENTITY — each planned event must occupy its planned seq with its planned
 * event_id (not merely "present somewhere", not "seq > max"). fsync order is
 * intent → journal → projection → marker, and directory publication is fsynced
 * up the parent chain, so a projection is never trusted ahead of the durable
 * journal (trp_8b17c2d0) and a freshly-created commits/ dir is durable at the
 * after_intent crash point.
 *
 * RECOVERY runs at the loop-lock entry boundary and FAILS CLOSED: any error
 * other than a quarantined conflict propagates so a mutation never proceeds
 * against a torn/unreadable journal. A torn trailing journal record (partial
 * append at power loss) is truncated under the lock before replay.
 */

export const COMMIT_INTENT_KIND = 'complete_turn' as const;

export interface LoopCommitIntent {
  intent_id: string; // persisted UUID — the idempotency key for this staged mutation
  loop_id: string;
  kind: typeof COMMIT_INTENT_KIND;
  /** thread.version BEFORE this mutation (the CAS base). */
  base_version: number;
  /** Frozen events to append, in seq order, each carrying its final event_id + seq. */
  events: LoopEvent[];
  /** The full next thread projection (version === base_version + 1). */
  thread_snapshot: LoopThread;
  created_at: string;
}

/** Injectable crash point for fault-injection tests (simulates process death mid-apply). */
export type IntentFaultPoint = 'after_intent' | 'after_journal' | 'after_thread' | 'before_marker';

export class IntentConflictError extends Error {
  constructor(
    public readonly intent_id: string,
    public readonly loop_id: string,
    message: string,
  ) {
    super(message);
    this.name = 'IntentConflictError';
  }
}

class SimulatedCrash extends Error {
  constructor(public readonly at: IntentFaultPoint) {
    super(`simulated crash at ${at}`);
    this.name = 'SimulatedCrash';
  }
}

/* ============================ paths ====================================== */

function loopsDir(cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops');
}
function commitsDir(loopId: string, cwd?: string): string {
  return path.join(loopsDir(cwd), 'commits', loopId);
}
function threadPath(loopId: string, cwd?: string): string {
  return path.join(loopsDir(cwd), 'threads', `${loopId}.json`);
}
function eventsPath(loopId: string, cwd?: string): string {
  return path.join(loopsDir(cwd), 'events', `${loopId}.jsonl`);
}
function intentPath(loopId: string, intentId: string, cwd?: string): string {
  return path.join(commitsDir(loopId, cwd), `${intentId}.intent.json`);
}
function appliedPath(loopId: string, intentId: string, cwd?: string): string {
  return path.join(commitsDir(loopId, cwd), `${intentId}.applied.json`);
}
function conflictPath(loopId: string, intentId: string, cwd?: string): string {
  return path.join(commitsDir(loopId, cwd), `${intentId}.conflict.json`);
}
function corruptPath(loopId: string, intentId: string, cwd?: string): string {
  return path.join(commitsDir(loopId, cwd), `${intentId}.corrupt.json`);
}

/* ============================ fsync helpers ============================== */

// Directory fsync is a POSIX durability primitive; Windows does not support it
// (and does not need it for our atomic-rename visibility). On POSIX a genuine
// I/O error must FAIL CLOSED — swallowing it was the review's CRITICAL finding.
const DIR_FSYNC_SUPPORTED = process.platform !== 'win32';

function fsyncDirOne(dir: string): void {
  if (!DIR_FSYNC_SUPPORTED) return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Benign only: raced-away dir, or a filesystem that cannot fsync a dir.
    if (code === 'ENOENT' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EISDIR' || code === 'EACCES') return;
    throw err; // EIO / ENOSPC / … → fail closed
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Durably publish `dir` and every ancestor up to (and including) the loops
 * root, so a newly-created commits/<loop> directory survives a crash. */
function fsyncDirChain(dir: string, cwd?: string): void {
  const root = loopsDir(cwd);
  let cur = dir;
  for (let i = 0; i < 24; i++) {
    fsyncDirOne(cur);
    if (cur === root) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

/** Write a file durably: temp write + fsync(file) + atomic rename + fsync(dir chain). */
function writeFileDurable(filePath: string, contents: string, cwd?: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const buf = Buffer.from(contents, 'utf8');
  const fd = fs.openSync(tmp, 'w');
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  fsyncDirChain(dir, cwd);
}

/** Append newline-delimited lines to the journal durably, looping each write to
 * completion (a short/torn write is never left behind), then fsync the fd. */
function appendJournalDurable(loopId: string, lines: string[], cwd?: string): void {
  const p = eventsPath(loopId, cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'a');
  try {
    for (const line of lines) {
      const buf = Buffer.from(`${line}\n`, 'utf8');
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/* ============================ journal identity =========================== */

interface JournalRead {
  events: LoopEvent[];
  /** true when the final line was a non-empty unparseable fragment (torn append). */
  tornTail: boolean;
}

/**
 * Tolerant journal read. Parses complete newline-delimited records; a non-empty
 * UNPARSEABLE FINAL line is treated as an uncommitted torn-append fragment and
 * dropped (never a mid-file parse — a torn record can only ever be the tail of
 * an append). Any earlier unparseable line is a real corruption and throws.
 */
function readJournalTolerant(loopId: string, cwd?: string): JournalRead {
  const p = eventsPath(loopId, cwd);
  if (!fs.existsSync(p)) return { events: [], tornTail: false };
  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split('\n');
  // A trailing '\n' yields a final '' element; the last real line is at len-2
  // when complete. Track the last NON-empty line index to detect a torn tail.
  const nonEmpty: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) nonEmpty.push({ idx: i, text: lines[i] });
  }
  const events: LoopEvent[] = [];
  let tornTail = false;
  for (let k = 0; k < nonEmpty.length; k++) {
    const { text } = nonEmpty[k];
    const isLast = k === nonEmpty.length - 1;
    try {
      events.push(LoopEventSchema.parse(JSON.parse(text)));
    } catch (err) {
      if (isLast) { tornTail = true; break; }
      throw new Error(
        `readJournalTolerant: corrupt journal record (not the tail) in ${p}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  return { events, tornTail };
}

/** Truncate a torn trailing record from the journal, durably, under the caller's
 * lock. Rewrites the file to only its complete records + trailing newline. */
function repairTornJournalTail(loopId: string, cwd?: string): void {
  const { events } = readJournalTolerant(loopId, cwd);
  const rebuilt = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  const p = eventsPath(loopId, cwd);
  const tmp = `${p}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const buf = Buffer.from(rebuilt, 'utf8');
  const fd = fs.openSync(tmp, 'w');
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  fsyncDirChain(path.dirname(p), cwd);
}

function readThreadOnDisk(loopId: string, cwd?: string): LoopThread | undefined {
  const p = threadPath(loopId, cwd);
  if (!fs.existsSync(p)) return undefined;
  try {
    return LoopThreadSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return undefined;
  }
}

/* ============================ intent lifecycle =========================== */

export function writeIntent(
  input: Omit<LoopCommitIntent, 'intent_id' | 'kind' | 'created_at'> & { intent_id?: string },
  cwd?: string,
): LoopCommitIntent {
  const intent: LoopCommitIntent = {
    intent_id: input.intent_id ?? crypto.randomUUID(),
    loop_id: input.loop_id,
    kind: COMMIT_INTENT_KIND,
    base_version: input.base_version,
    events: input.events.map((e) => LoopEventSchema.parse(e)),
    thread_snapshot: LoopThreadSchema.parse(input.thread_snapshot),
    created_at: nowISO(),
  };
  writeFileDurable(intentPath(intent.loop_id, intent.intent_id, cwd), `${JSON.stringify(intent, null, 2)}\n`, cwd);
  return intent;
}

/**
 * Apply a staged intent idempotently, by IDENTITY. Ordering: (repair torn tail)
 * → journal append (fsync) → thread projection (fsync) → `.intent → .applied`.
 *
 * Identity rules (review MEDIUM):
 *  - a planned event counts as present only if the journal has its event_id AT
 *    its planned seq;
 *  - all planned present → journal already applied;
 *  - none present + journal max seq === first planned seq - 1 → clean contiguous
 *    append; otherwise → CONFLICT (foreign occupant / hole), quarantined;
 *  - the thread projection is written unless the on-disk thread already carries
 *    the snapshot's mutation_id; an equal/newer version with a DIFFERENT
 *    mutation_id is a CONFLICT (divergent projection), not a silent skip.
 */
export function applyIntent(intent: LoopCommitIntent, cwd?: string, faultAt?: IntentFaultPoint): void {
  // Repair a torn trailing record before we reason about the journal (review HIGH).
  const firstRead = readJournalTolerant(intent.loop_id, cwd);
  if (firstRead.tornTail) repairTornJournalTail(intent.loop_id, cwd);

  const journal = readJournalTolerant(intent.loop_id, cwd).events;
  const seqOfId = new Map<string, number>();
  for (const e of journal) seqOfId.set(e.event_id, e.seq);
  const idAtSeq = new Map<number, string>();
  for (const e of journal) idAtSeq.set(e.seq, e.event_id);
  const maxSeq = journal.reduce((m, e) => Math.max(m, e.seq), 0);

  const planned = intent.events;
  const presentAtPlannedSeq = (e: LoopEvent): boolean => seqOfId.get(e.event_id) === e.seq;
  const allPresent = planned.every(presentAtPlannedSeq);

  const quarantine = (why: string): never => {
    const ip = intentPath(intent.loop_id, intent.intent_id, cwd);
    if (fs.existsSync(ip)) {
      fs.renameSync(ip, conflictPath(intent.loop_id, intent.intent_id, cwd));
      fsyncDirChain(commitsDir(intent.loop_id, cwd), cwd);
    }
    throw new IntentConflictError(intent.intent_id, intent.loop_id, `applyIntent: ${why} — intent superseded`);
  };

  if (!allPresent) {
    const missing = planned.filter((e) => !presentAtPlannedSeq(e));
    // A planned seq already occupied by a DIFFERENT event_id → foreign overlap.
    for (const e of missing) {
      const occupant = idAtSeq.get(e.seq);
      if (occupant !== undefined && occupant !== e.event_id) {
        quarantine(`planned seq ${e.seq} occupied by foreign event ${occupant}`);
      }
    }
    const firstMissingSeq = missing[0]?.seq;
    if (firstMissingSeq === undefined) {
      // nothing to append (defensive; shouldn't happen)
    } else if (maxSeq === firstMissingSeq - 1) {
      appendJournalDurable(intent.loop_id, missing.map((e) => JSON.stringify(e)), cwd);
    } else {
      quarantine(`missing planned seq ${firstMissingSeq} is not a contiguous tail (journal max ${maxSeq})`);
    }
  }

  if (faultAt === 'after_journal') throw new SimulatedCrash('after_journal');

  // Thread projection — validate by identity, not bare version (review MEDIUM).
  const onDisk = readThreadOnDisk(intent.loop_id, cwd);
  if (onDisk?.mutation_id === intent.thread_snapshot.mutation_id) {
    // already applied — skip
  } else if (onDisk && onDisk.version >= intent.thread_snapshot.version) {
    quarantine(
      `on-disk thread version ${onDisk.version} (mutation ${onDisk.mutation_id}) diverges from staged snapshot version ${intent.thread_snapshot.version} (mutation ${intent.thread_snapshot.mutation_id})`,
    );
  } else {
    writeFileDurable(threadPath(intent.loop_id, cwd), `${JSON.stringify(intent.thread_snapshot, null, 2)}\n`, cwd);
  }

  if (faultAt === 'after_thread') throw new SimulatedCrash('after_thread');
  if (faultAt === 'before_marker') throw new SimulatedCrash('before_marker');

  const ip = intentPath(intent.loop_id, intent.intent_id, cwd);
  if (fs.existsSync(ip)) {
    fs.renameSync(ip, appliedPath(intent.loop_id, intent.intent_id, cwd));
    fsyncDirChain(commitsDir(intent.loop_id, cwd), cwd);
  }
  // Bounded audit-marker GC so the commits dir does not grow without bound
  // (review LOW): keep markers for a short window for forensics, drop older.
  gcCommitMarkers(intent.loop_id, 60 * 60 * 1000, cwd);
}

export function commitViaIntent(
  input: Omit<LoopCommitIntent, 'intent_id' | 'kind' | 'created_at'> & { intent_id?: string },
  cwd?: string,
  faultAt?: IntentFaultPoint,
): LoopCommitIntent {
  const intent = writeIntent(input, cwd);
  if (faultAt === 'after_intent') throw new SimulatedCrash('after_intent');
  applyIntent(intent, cwd, faultAt);
  return intent;
}

/* ============================ recovery =================================== */

function listPendingIntentFiles(loopId: string, cwd?: string): string[] {
  const dir = commitsDir(loopId, cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.intent.json')).sort();
}

/**
 * Recover any pending intents for a loop. MUST run at loop-lock entry, before
 * load/version-check/seq-allocation. FAILS CLOSED (review HIGH): a genuine apply
 * error (torn/unreadable journal, I/O) propagates so the mutation does not
 * proceed against corrupt state. A quarantined conflict is counted, not thrown.
 * A malformed intent file is quarantined to `.corrupt` (visible), not silently
 * skipped. Returns { applied, conflicted, corrupt }.
 */
export function recoverPendingIntents(loopId: string, cwd?: string): { applied: number; conflicted: number; corrupt: number } {
  let applied = 0;
  let conflicted = 0;
  let corrupt = 0;
  for (const file of listPendingIntentFiles(loopId, cwd)) {
    const full = path.join(commitsDir(loopId, cwd), file);
    let intent: LoopCommitIntent | undefined;
    try {
      intent = JSON.parse(fs.readFileSync(full, 'utf8')) as LoopCommitIntent;
    } catch (err) {
      const intentId = file.replace(/\.intent\.json$/, '');
      try {
        fs.renameSync(full, corruptPath(loopId, intentId, cwd));
        fsyncDirChain(commitsDir(loopId, cwd), cwd);
      } catch { /* racing — leave for next pass */ }
      logger.warn(`recoverPendingIntents: quarantined malformed intent ${file} for loop ${loopId}: ${err instanceof Error ? err.message : String(err)}`);
      corrupt += 1;
      continue;
    }
    try {
      applyIntent(intent, cwd);
      applied += 1;
    } catch (e) {
      if (e instanceof IntentConflictError) { conflicted += 1; continue; }
      throw e; // fail closed on genuine apply errors
    }
  }
  return { applied, conflicted, corrupt };
}

/**
 * Non-persisting consistent read: if a pending intent exists whose snapshot is
 * ahead of the on-disk thread, return the snapshot. Used by read paths that do
 * not hold the loop lock. Ignores conflicted/corrupt intents.
 */
export function reconstructConsistentThread(loopId: string, onDisk: LoopThread | undefined, cwd?: string): LoopThread | undefined {
  let best = onDisk;
  for (const file of listPendingIntentFiles(loopId, cwd)) {
    try {
      const intent = JSON.parse(fs.readFileSync(path.join(commitsDir(loopId, cwd), file), 'utf8')) as LoopCommitIntent;
      const snap = LoopThreadSchema.parse(intent.thread_snapshot);
      if (!best || snap.version > best.version) best = snap;
    } catch {
      /* skip malformed — recovery quarantines it at the next lock entry */
    }
  }
  return best;
}

export function hasPendingIntent(loopId: string, cwd?: string): boolean {
  return listPendingIntentFiles(loopId, cwd).length > 0;
}

/** Bounded GC of `.applied` / `.conflict` / `.corrupt` markers older than maxAgeMs. */
export function gcCommitMarkers(loopId: string, maxAgeMs: number, cwd?: string): number {
  const dir = commitsDir(loopId, cwd);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(applied|conflict|corrupt)\.json$/.test(file)) continue;
    const fp = path.join(dir, file);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed += 1;
      }
    } catch {
      /* racing unlink — skip */
    }
  }
  return removed;
}
