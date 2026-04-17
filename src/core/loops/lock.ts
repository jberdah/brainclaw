import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { memoryDir } from '../io.js';
import { nowISO } from '../ids.js';

/**
 * Per-loop exclusive lock + idempotency + fencing helpers.
 *
 * Implements the commit protocol from docs/concepts/loop-engine.md §Persistence.
 * For synchronous MVP mutations, the lock window is short (< 100ms typically) so
 * lease renewal via an internal heartbeat is not yet wired up; the hard_deadline
 * is still recorded in the lock blob and used by the stale-lock recovery rules.
 */

export const LOCK_BACKOFF_BASE_MS = 10;
export const LOCK_BACKOFF_TOTAL_MS = 500;
export const LEASE_WINDOW_MS = 60_000;
export const LEASE_RENEWAL_INTERVAL_MS = 30_000;
export const LEASE_GRACE_MS = 30_000;

export const DEFAULT_MAX_MUTATION_DURATION_MS: Record<string, number> = {
  open: 30_000,
  turn: 30_000,
  advance: 30_000,
  pause: 30_000,
  resume: 30_000,
  close: 30_000,
  add_artifact: 60_000,
  complete_turn: 60_000,
};

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface LockBlob {
  pid: number;
  host_id: string;
  agent_id: string;
  acquired_at: string;
  lease_until: string;
  hard_deadline: string;
  mutation_id: string;
}

export class LockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super(`lock_timeout at ${lockPath}`);
    this.name = 'LockTimeoutError';
  }
}

export class LockLostError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly expected: string,
    public readonly actual: string | null,
  ) {
    super(`lock_lost: expected mutation_id=${expected}, found=${actual ?? 'missing'} at ${lockPath}`);
    this.name = 'LockLostError';
  }
}

export class VersionConflictError extends Error {
  constructor(
    public readonly loopId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`version_conflict on ${loopId}: expected ${expected}, actual ${actual}`);
    this.name = 'VersionConflictError';
  }
}

export class IdempotencyKeyReusedError extends Error {
  constructor(
    public readonly storedHash: string,
    public readonly submittedHash: string,
  ) {
    super('idempotency_key_reused_with_different_body');
    this.name = 'IdempotencyKeyReusedError';
  }
}

/* ============================ path resolution ============================= */

function loopsRoot(cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops');
}

function locksDir(cwd?: string): string {
  return path.join(loopsRoot(cwd), 'locks');
}

function openLocksDir(cwd?: string): string {
  return path.join(locksDir(cwd), 'open');
}

function idempotencyDir(loopId: string, cwd?: string): string {
  return path.join(loopsRoot(cwd), 'idempotency', loopId);
}

function idempotencyOpenDir(agentId: string, cwd?: string): string {
  return path.join(loopsRoot(cwd), 'idempotency-open', agentId);
}

function conflictsDir(cwd?: string): string {
  return path.join(loopsRoot(cwd), 'conflicts');
}

function loopLockPath(loopId: string, cwd?: string): string {
  return path.join(locksDir(cwd), `${loopId}.lock`);
}

function openLockPath(agentId: string, clientRequestId: string, cwd?: string): string {
  return path.join(openLocksDir(cwd), agentId, `${clientRequestId}.lock`);
}

function ensureDirFor(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ============================== JSON helpers ============================= */

function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDirFor(filePath);
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/* =============================== idempotency ============================= */

export interface IdempotencyRecord<R = unknown> {
  response: R;
  request_hash: string;
  stored_at: string;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      canonical[key] = canonicalizeJson(record[key]);
    }
    return canonical;
  }
  return value;
}

export function hashRequest(payload: unknown): string {
  const canonical = JSON.stringify(canonicalizeJson(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function loadIdempotencyRecord<R>(
  kind: 'loop' | 'open',
  key: { loopId?: string; agentId?: string; clientRequestId: string },
  cwd?: string,
): { path: string; record: IdempotencyRecord<R> | undefined } {
  let filePath: string;
  if (kind === 'loop') {
    if (!key.loopId) throw new Error('loadIdempotencyRecord: loopId required for loop kind');
    filePath = path.join(idempotencyDir(key.loopId, cwd), `${key.clientRequestId}.json`);
  } else {
    if (!key.agentId) throw new Error('loadIdempotencyRecord: agentId required for open kind');
    filePath = path.join(idempotencyOpenDir(key.agentId, cwd), `${key.clientRequestId}.json`);
  }
  const record = readJsonIfExists<IdempotencyRecord<R>>(filePath);
  if (record && Date.parse(record.stored_at) + IDEMPOTENCY_TTL_MS < Date.now()) {
    return { path: filePath, record: undefined };
  }
  return { path: filePath, record };
}

/* =============================== lock I/O ================================ */

function readLockBlob(lockPath: string): LockBlob | null {
  return readJsonIfExists<LockBlob>(lockPath) ?? null;
}

function writeLockAtomic(lockPath: string, blob: LockBlob): void {
  writeJsonAtomic(lockPath, blob);
}

function processIsAlive(pid: number): boolean {
  try {
    // Signal 0 just checks for the process's existence without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function lockIsStale(blob: LockBlob, now: number): boolean {
  if (now > Date.parse(blob.hard_deadline)) return true;
  if (blob.host_id === os.hostname() && !processIsAlive(blob.pid)) return true;
  if (now > Date.parse(blob.lease_until) + LEASE_GRACE_MS) return true;
  return false;
}

function acquireRaw(lockPath: string, blob: LockBlob): boolean {
  ensureDirFor(lockPath);
  const tmp = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(blob, null, 2));
  try {
    // fs.renameSync is atomic on POSIX but will overwrite on Windows. We want exclusive:
    // use link(tmp, lockPath) + unlink(tmp) which is atomic + fails on EEXIST.
    fs.linkSync(tmp, lockPath);
    fs.unlinkSync(tmp);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (code === 'EEXIST') return false;
    throw err;
  }
}

export interface AcquireLockOptions {
  lockPath: string;
  agentId: string;
  intent: string;
  maxMutationDurationMs?: number;
  /** Total acquisition timeout in ms, default LOCK_BACKOFF_TOTAL_MS. */
  timeoutMs?: number;
}

export interface AcquiredLock {
  path: string;
  blob: LockBlob;
  release(): void;
  fenceCheck(): void;
}

export function acquireLock(options: AcquireLockOptions): AcquiredLock {
  const durationMs =
    options.maxMutationDurationMs ?? DEFAULT_MAX_MUTATION_DURATION_MS[options.intent] ?? 30_000;
  const timeoutMs = options.timeoutMs ?? LOCK_BACKOFF_TOTAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const existing = readLockBlob(options.lockPath);
    if (existing) {
      if (lockIsStale(existing, Date.now())) {
        try {
          fs.unlinkSync(options.lockPath);
        } catch {
          /* race with another reaper; retry */
        }
      }
    }

    const nowIso = nowISO();
    const nowMs = Date.now();
    const blob: LockBlob = {
      pid: process.pid,
      host_id: os.hostname(),
      agent_id: options.agentId,
      acquired_at: nowIso,
      lease_until: new Date(nowMs + LEASE_WINDOW_MS).toISOString(),
      hard_deadline: new Date(nowMs + durationMs).toISOString(),
      mutation_id: crypto.randomUUID().replace(/-/g, ''),
    };
    if (acquireRaw(options.lockPath, blob)) {
      const lockPath = options.lockPath;
      return {
        path: lockPath,
        blob,
        release() {
          try {
            const current = readLockBlob(lockPath);
            if (current && current.mutation_id === blob.mutation_id) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            /* best-effort */
          }
        },
        fenceCheck() {
          const current = readLockBlob(lockPath);
          if (!current || current.mutation_id !== blob.mutation_id) {
            throw new LockLostError(lockPath, blob.mutation_id, current?.mutation_id ?? null);
          }
        },
      };
    }

    // Jittered backoff.
    const base = Math.min(LOCK_BACKOFF_BASE_MS * 2, 80);
    const jitter = crypto.randomInt(0, base);
    const sleepMs = Math.min(deadline - Date.now(), base + jitter);
    if (sleepMs <= 0) break;
    sleepSync(sleepMs);
  }
  throw new LockTimeoutError(options.lockPath);
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // Tight but cheap busy wait for short backoffs.
  while (Date.now() < end) {
    // Yield via SharedArrayBuffer wait if available; otherwise busy-loop.
    try {
      const sab = new SharedArrayBuffer(4);
      const view = new Int32Array(sab);
      Atomics.wait(view, 0, 0, end - Date.now());
      break;
    } catch {
      /* fallback */
    }
  }
}

/* =============================== withLoopLock ============================= */

export interface WithLoopLockOptions<R> {
  cwd?: string;
  intent: string;
  agentId: string;
  /** Either an existing loopId (most intents) or the `open`-idempotent scope. */
  scope:
    | { kind: 'loop'; loopId: string }
    | { kind: 'open_idempotency'; clientRequestId: string };
  clientRequestId?: string;
  requestPayload?: unknown;
  expectedVersion?: number;
  /** Runs inside the lock. Receives fenceCheck to call before committing I/O. */
  work: (ctx: { fenceCheck: () => void; mutationId: string }) => R;
  /** Extract the current version of a loop for CAS check. */
  currentVersion?: () => number;
  loopIdForIdempotency?: string;
}

export function withLoopLock<R>(options: WithLoopLockOptions<R>): R {
  const lockPath =
    options.scope.kind === 'loop'
      ? loopLockPath(options.scope.loopId, options.cwd)
      : openLockPath(options.agentId, options.scope.clientRequestId, options.cwd);

  const acquired = acquireLock({
    lockPath,
    agentId: options.agentId,
    intent: options.intent,
  });

  try {
    // Idempotency short-circuit (inside lock).
    if (options.clientRequestId && options.requestPayload !== undefined) {
      const loopIdForKey =
        options.scope.kind === 'loop'
          ? options.scope.loopId
          : options.loopIdForIdempotency;
      const { path: idPath, record } = loadIdempotencyRecord<R>(
        loopIdForKey ? 'loop' : 'open',
        loopIdForKey
          ? { loopId: loopIdForKey, clientRequestId: options.clientRequestId }
          : { agentId: options.agentId, clientRequestId: options.clientRequestId },
        options.cwd,
      );
      const submittedHash = hashRequest(options.requestPayload);
      if (record) {
        if (record.request_hash !== submittedHash) {
          throw new IdempotencyKeyReusedError(record.request_hash, submittedHash);
        }
        return record.response;
      }

      // CAS check (after idempotency short-circuit).
      if (options.expectedVersion !== undefined && options.currentVersion) {
        const actual = options.currentVersion();
        if (actual !== options.expectedVersion) {
          recordConflict({
            loopId: loopIdForKey ?? 'unknown',
            attemptedBy: options.agentId,
            expectedVersion: options.expectedVersion,
            actualVersion: actual,
            rejectedIntent: options.intent,
            clientRequestId: options.clientRequestId,
            cwd: options.cwd,
          });
          throw new VersionConflictError(loopIdForKey ?? 'unknown', options.expectedVersion, actual);
        }
      }

      const result = options.work({ fenceCheck: acquired.fenceCheck, mutationId: acquired.blob.mutation_id });
      const storeRecord: IdempotencyRecord<R> = {
        response: result,
        request_hash: submittedHash,
        stored_at: nowISO(),
      };
      writeJsonAtomic(idPath, storeRecord);
      return result;
    }

    // No idempotency key — still honor CAS if supplied.
    if (options.expectedVersion !== undefined && options.currentVersion && options.scope.kind === 'loop') {
      const actual = options.currentVersion();
      if (actual !== options.expectedVersion) {
        recordConflict({
          loopId: options.scope.loopId,
          attemptedBy: options.agentId,
          expectedVersion: options.expectedVersion,
          actualVersion: actual,
          rejectedIntent: options.intent,
          clientRequestId: options.clientRequestId,
          cwd: options.cwd,
        });
        throw new VersionConflictError(options.scope.loopId, options.expectedVersion, actual);
      }
    }

    return options.work({ fenceCheck: acquired.fenceCheck, mutationId: acquired.blob.mutation_id });
  } finally {
    acquired.release();
  }
}

/* ============================= conflict log =============================== */

export interface RecordConflictInput {
  loopId: string;
  attemptedBy: string;
  expectedVersion: number;
  actualVersion: number;
  rejectedIntent: string;
  clientRequestId?: string;
  cwd?: string;
}

export function recordConflict(input: RecordConflictInput): void {
  const filePath = path.join(conflictsDir(input.cwd), `${input.loopId}.jsonl`);
  ensureDirFor(filePath);
  const entry = {
    conflict_id: crypto.randomUUID(),
    loop_id: input.loopId,
    at: nowISO(),
    attempted_by: input.attemptedBy,
    expected_version: input.expectedVersion,
    actual_version: input.actualVersion,
    rejected_intent: input.rejectedIntent,
    client_request_id: input.clientRequestId,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}
