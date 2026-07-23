import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { memoryDir } from '../io.js';
import { nowISO } from '../ids.js';
import { LoopEventSchema, LoopThreadSchema, type LoopEvent, type LoopThread } from './types.js';

/**
 * WAL commit-intent for atomic, crash-consistent, idempotent loop turn
 * completion (pln#630 PR1b, dec#137 — converged in ideation loop
 * lop_96d5324865a4c580, codex critique art_d28f55adf6b6, verdict GO-WITH-CHANGES).
 *
 * PROBLEM (codex r4): complete_turn writes journal events then the thread
 * projection in two steps (verbs.ts:705-706). A crash between them either loses
 * the visible verdict (thread stale, journal ahead) or — with the reverse
 * ordering elsewhere — exposes a projection ahead of the durable journal
 * (trp_8b17c2d0). Neither is crash-safe.
 *
 * SOLUTION: stage the whole mutation as ONE durable intent file BEFORE touching
 * the journal/thread. The intent is the source of truth until fully applied.
 * Apply is idempotent by IDENTITY (frozen event_ids), not by `seq > max`
 * (which a bypassing writer could defeat). fsync order is intent → journal →
 * projection → marker, so a projection is never trusted ahead of the durable
 * journal. The `.intent → .applied` rename is the positive done-marker.
 *
 * RECOVERY runs at the loop-lock entry boundary (NOT inside getLoop — the loop
 * lock is not re-entrant and verbs call getLoop while already locked). Reads
 * that cannot take the lock reconstruct a consistent in-memory view from any
 * pending intent without persisting (persistence happens at the next lock entry).
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

/* ============================ fsync helpers ============================== */

/** fsync a directory (best-effort — Windows does not support directory fsync). */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* directory fsync unsupported (Windows) or racing — best-effort */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Write a file durably: temp write + fsync(file) + atomic rename + fsync(dir). */
function writeFileDurable(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  fsyncDir(dir);
}

/** Append lines to the journal durably (fsync the fd after append). */
function appendJournalDurable(loopId: string, lines: string[], cwd?: string): void {
  const p = eventsPath(loopId, cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'a');
  try {
    for (const line of lines) fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/* ============================ journal identity =========================== */

function readJournalEvents(loopId: string, cwd?: string): LoopEvent[] {
  const p = eventsPath(loopId, cwd);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => LoopEventSchema.parse(JSON.parse(line)));
}

function readThreadVersion(loopId: string, cwd?: string): number | undefined {
  const p = threadPath(loopId, cwd);
  if (!fs.existsSync(p)) return undefined;
  try {
    return LoopThreadSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8'))).version;
  } catch {
    return undefined;
  }
}

/* ============================ intent lifecycle =========================== */

/**
 * Stage a mutation as a durable intent. Returns the intent_id. MUST be called
 * under the loop lock (the caller owns serialization). Nothing is applied yet.
 */
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
  writeFileDurable(intentPath(intent.loop_id, intent.intent_id, cwd), `${JSON.stringify(intent, null, 2)}\n`);
  return intent;
}

/**
 * Apply a staged intent idempotently. Ordering: journal append (fsync) → thread
 * projection (fsync) → `.intent → .applied` rename. Identity-based replay:
 *  - already-applied (all event_ids present) → skip to marker;
 *  - clean contiguous tail (journal max seq === first planned seq - 1) → append;
 *  - foreign overlap at the planned seqs (different event_ids) → CONFLICT (stale
 *    intent; never appended), renamed to `.conflict`.
 *
 * `faultAt` simulates a crash after the named step (tests only).
 */
export function applyIntent(intent: LoopCommitIntent, cwd?: string, faultAt?: IntentFaultPoint): void {
  const journal = readJournalEvents(intent.loop_id, cwd);
  const presentIds = new Set(journal.map((e) => e.event_id));
  const maxSeq = journal.reduce((m, e) => Math.max(m, e.seq), 0);

  const planned = intent.events;
  const allPresent = planned.every((e) => presentIds.has(e.event_id));
  const nonePresent = planned.every((e) => !presentIds.has(e.event_id));

  if (allPresent) {
    // Journal side already durable — only the thread/marker may be pending.
  } else if (nonePresent) {
    const firstSeq = planned[0]?.seq;
    if (firstSeq === undefined) {
      // No events to append (shouldn't happen for complete_turn) — treat as journal-done.
    } else if (maxSeq === firstSeq - 1) {
      // Clean contiguous tail — safe to append the whole plan.
      appendJournalDurable(intent.loop_id, planned.map((e) => JSON.stringify(e)), cwd);
    } else {
      // Foreign writer occupies the planned seq range — this intent is stale.
      fs.renameSync(intentPath(intent.loop_id, intent.intent_id, cwd), conflictPath(intent.loop_id, intent.intent_id, cwd));
      fsyncDir(commitsDir(intent.loop_id, cwd));
      throw new IntentConflictError(
        intent.intent_id,
        intent.loop_id,
        `applyIntent: planned seq ${firstSeq} conflicts with journal max ${maxSeq} (foreign overlap) — intent superseded`,
      );
    }
  } else {
    // Partial identity overlap: some planned events present, some not — a torn
    // append. Append only the missing suffix IFF it is a contiguous tail; else conflict.
    const missing = planned.filter((e) => !presentIds.has(e.event_id));
    const firstMissingSeq = missing[0]?.seq;
    if (firstMissingSeq !== undefined && maxSeq === firstMissingSeq - 1) {
      appendJournalDurable(intent.loop_id, missing.map((e) => JSON.stringify(e)), cwd);
    } else {
      fs.renameSync(intentPath(intent.loop_id, intent.intent_id, cwd), conflictPath(intent.loop_id, intent.intent_id, cwd));
      fsyncDir(commitsDir(intent.loop_id, cwd));
      throw new IntentConflictError(
        intent.intent_id,
        intent.loop_id,
        `applyIntent: torn journal state cannot be reconciled from intent (partial overlap, non-contiguous) — intent superseded`,
      );
    }
  }

  if (faultAt === 'after_journal') throw new SimulatedCrash('after_journal');

  // Thread projection: write iff the on-disk version is behind the snapshot.
  const onDiskVersion = readThreadVersion(intent.loop_id, cwd);
  if (onDiskVersion === undefined || onDiskVersion < intent.thread_snapshot.version) {
    writeFileDurable(threadPath(intent.loop_id, cwd), `${JSON.stringify(intent.thread_snapshot, null, 2)}\n`);
  }

  if (faultAt === 'after_thread') throw new SimulatedCrash('after_thread');
  if (faultAt === 'before_marker') throw new SimulatedCrash('before_marker');

  // Positive done-marker: rename .intent → .applied (idempotent if already gone).
  const ip = intentPath(intent.loop_id, intent.intent_id, cwd);
  if (fs.existsSync(ip)) {
    fs.renameSync(ip, appliedPath(intent.loop_id, intent.intent_id, cwd));
    fsyncDir(commitsDir(intent.loop_id, cwd));
  }
}

/**
 * The full staged commit: write the intent durably, then apply it. This is the
 * primitive complete_turn uses. `faultAt='after_intent'` stops right after the
 * intent is durable (before any journal/thread write) to test pure recovery.
 */
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
 * Recover any pending (un-applied) intents for a loop. MUST run at loop-lock
 * entry, before load/version-check/seq-allocation. Idempotent. A stale intent
 * (foreign overlap) is quarantined to `.conflict` and does not block others.
 * Returns { applied, conflicted } counts.
 */
export function recoverPendingIntents(loopId: string, cwd?: string): { applied: number; conflicted: number } {
  let applied = 0;
  let conflicted = 0;
  for (const file of listPendingIntentFiles(loopId, cwd)) {
    let intent: LoopCommitIntent;
    try {
      intent = JSON.parse(fs.readFileSync(path.join(commitsDir(loopId, cwd), file), 'utf8')) as LoopCommitIntent;
    } catch {
      continue; // malformed/racing — leave for diagnostics
    }
    try {
      applyIntent(intent, cwd);
      applied += 1;
    } catch (e) {
      if (e instanceof IntentConflictError) conflicted += 1;
      else throw e;
    }
  }
  return { applied, conflicted };
}

/**
 * Non-persisting consistent read: if a pending intent exists whose snapshot is
 * ahead of the on-disk thread, return the snapshot (the mutation is durable in
 * the intent; the on-disk thread just hasn't caught up). Used by read paths that
 * do not hold the loop lock. Ignores conflicted intents.
 */
export function reconstructConsistentThread(loopId: string, onDisk: LoopThread | undefined, cwd?: string): LoopThread | undefined {
  let best = onDisk;
  for (const file of listPendingIntentFiles(loopId, cwd)) {
    try {
      const intent = JSON.parse(
        fs.readFileSync(path.join(commitsDir(loopId, cwd), file), 'utf8'),
      ) as LoopCommitIntent;
      const snap = LoopThreadSchema.parse(intent.thread_snapshot);
      if (!best || snap.version > best.version) best = snap;
    } catch {
      /* skip malformed */
    }
  }
  return best;
}

export function hasPendingIntent(loopId: string, cwd?: string): boolean {
  return listPendingIntentFiles(loopId, cwd).length > 0;
}

/** Bounded GC of `.applied` / `.conflict` markers older than maxAgeMs. */
export function gcCommitMarkers(loopId: string, maxAgeMs: number, cwd?: string): number {
  const dir = commitsDir(loopId, cwd);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.applied.json') && !file.endsWith('.conflict.json')) continue;
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
