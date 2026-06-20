/**
 * Code Map per-project lock (spec §5.8 + §6 rule 1).
 *
 * Distinct from the generic advisory lock in `src/core/lock.ts` because the
 * Code Map lock carries rich metadata (owner_agent, pid, operation, scope,
 * heartbeat_at, stale_after_ms) and implements operator-free abandoned-lock
 * auto-recovery. It follows the same discipline as `withLock`:
 *
 *  - exclusive create with the `wx` open flag — creating an already-existing
 *    lock must NOT truncate it;
 *  - heartbeat refresh during a long operation;
 *  - only a *live* lock blocks; an *abandoned* lock (dead pid OR stale
 *    heartbeat, with no store file changed since) is reclaimed via an
 *    atomic-rename takeover, logging the prior owner's metadata.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../io.js';
import { logger } from '../logger.js';
import { CODE_MAP_SCHEMA_VERSION, CodeLockSchema, type CodeLock } from './types.js';
import { codeMapDir, lockPath } from './paths.js';

/** Default lock validity window before a silent owner is treated as abandoned. */
export const DEFAULT_STALE_AFTER_MS = 60_000;

export interface AcquireCodeLockInput {
  cwd?: string;
  preferredDirName?: string;
  projectId?: string | null;
  worktreeId?: string | null;
  ownerAgent?: string | null;
  ownerAgentId?: string | null;
  operation?: string;
  scope?: string;
  staleAfterMs?: number;
  /** Test seam: override the alive check (default = process.kill(pid, 0)). */
  isPidAlive?: (pid: number) => boolean;
  /** Test seam: clock. */
  now?: () => number;
}

export interface CodeLockHandle {
  lock: CodeLock;
  lockPath: string;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(p: string): CodeLock | null {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = CodeLockSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Most recent mtime of any file under the store dir (excluding the lock itself). */
function latestStoreMtimeMs(storeDir: string, lockFile: string): number {
  let latest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (full === lockFile) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Ignore non-authoritative litter: writeFileAtomic temp files and the
      // advisory lock-of-the-lock it creates. They are not store content and
      // must not falsely register as "the store changed after the heartbeat"
      // (which would wrongly block an otherwise-valid abandoned-lock reclaim).
      const name = entry.name;
      if (name.endsWith('.tmp') || name.endsWith('.lock')) continue;
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > latest) latest = m;
      } catch {
        /* skip */
      }
    }
  };
  walk(storeDir);
  return latest;
}

/**
 * Evaluate the spec §5.8 abandoned conditions:
 *  - the owner `pid` is no longer alive (definitive — the writer is gone), OR
 *  - `heartbeat_at` is older than `stale_after_ms` AND no file under the store
 *    changed after the last heartbeat (a silent-but-alive pid might still be
 *    mid-operation, so the store-change guard protects only this path).
 *
 * IMPORTANT: the store-change guard must NOT gate the dead-pid path. A process
 * that crashed mid-refresh after writing a shard (store mtime > heartbeat) is
 * still definitively dead; gating it would freeze Code Map until an operator
 * intervened, violating the operator-free crash-recovery guarantee (§6 rule 1,
 * §12.3).
 */
export function isLockAbandoned(
  existing: CodeLock,
  opts: { now: number; isPidAlive: (pid: number) => boolean; storeDir: string; lockFile: string },
): boolean {
  const pidDead = !opts.isPidAlive(existing.pid);
  // Dead owner → reclaim unconditionally. No live writer can exist.
  if (pidDead) return true;

  const heartbeatMs = Date.parse(existing.heartbeat_at);
  const heartbeatStale =
    Number.isFinite(heartbeatMs) && opts.now - heartbeatMs > existing.stale_after_ms;
  if (!heartbeatStale) return false;

  // Stale heartbeat but the pid is (or appears) alive: if the store changed
  // after the last heartbeat, a writer may still be mid-operation despite an
  // old heartbeat timestamp — do not reclaim.
  const latestChange = latestStoreMtimeMs(opts.storeDir, opts.lockFile);
  if (latestChange > heartbeatMs) return false;

  return true;
}

function buildLock(input: AcquireCodeLockInput, nowMs: number): CodeLock {
  const iso = new Date(nowMs).toISOString();
  return CodeLockSchema.parse({
    schema_version: CODE_MAP_SCHEMA_VERSION,
    lock_id: `lock_${crypto.randomBytes(8).toString('hex')}`,
    project_id: input.projectId ?? null,
    worktree_id: input.worktreeId ?? null,
    owner_agent: input.ownerAgent ?? null,
    owner_agent_id: input.ownerAgentId ?? null,
    pid: process.pid,
    operation: input.operation ?? 'refresh',
    scope: input.scope ?? 'changed',
    created_at: iso,
    heartbeat_at: iso,
    stale_after_ms: input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  });
}

/**
 * Acquire the Code Map lock. Returns a handle on success, or `null` when a
 * *live* lock is held by another owner.
 *
 * Exclusive-create path: `open(...'wx')` fails with EEXIST if a lock already
 * exists, which guarantees we never truncate a competitor's live lock.
 */
export function acquireCodeLock(input: AcquireCodeLockInput = {}): CodeLockHandle | null {
  const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
  const now = input.now ?? Date.now;
  const storeDir = codeMapDir(input.cwd, input.preferredDirName);
  const lockFile = lockPath(input.cwd, input.preferredDirName);
  if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });

  const lock = buildLock(input, now());
  const serialized = JSON.stringify(lock, null, 2);

  // 1. Exclusive create. 'wx' never truncates an existing file (spec §6 rule 1).
  try {
    fs.writeFileSync(lockFile, serialized, { encoding: 'utf-8', flag: 'wx' });
    return { lock, lockPath: lockFile };
  } catch (err: unknown) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw err;
  }

  // 2. A lock exists — read it and evaluate abandonment.
  const existing = readLock(lockFile);
  if (!existing) {
    // Unreadable/corrupt lock — treat as abandoned and take over atomically.
    writeFileAtomic(lockFile, serialized);
    logger.debug(`code-map lock: reclaimed unreadable lock at ${lockFile}`);
    return { lock, lockPath: lockFile };
  }

  // Re-entrant: same process already owns it -> refresh heartbeat, reuse.
  if (existing.pid === process.pid) {
    const refreshed = { ...existing, heartbeat_at: new Date(now()).toISOString() };
    writeFileAtomic(lockFile, JSON.stringify(refreshed, null, 2));
    return { lock: refreshed, lockPath: lockFile };
  }

  const abandoned = isLockAbandoned(existing, { now: now(), isPidAlive, storeDir, lockFile });
  if (!abandoned) {
    // Live lock blocks.
    return null;
  }

  // 3. Abandoned takeover via atomic rename (writeFileAtomic does temp+rename
  // with EPERM/EBUSY backoff — the NTFS-safe path).
  writeFileAtomic(lockFile, serialized);
  logger.debug(
    `code-map lock: reclaimed abandoned lock (prior owner agent=${existing.owner_agent ?? 'unknown'} ` +
      `pid=${existing.pid} operation=${existing.operation} heartbeat_at=${existing.heartbeat_at})`,
  );
  return { lock, lockPath: lockFile };
}

/** Refresh the heartbeat on a held lock (spec §6 rule 2 — at least every 10s). */
export function heartbeatCodeLock(
  handle: CodeLockHandle,
  now: () => number = Date.now,
): CodeLockHandle {
  const current = readLock(handle.lockPath);
  // Only refresh if we still own it (pid match).
  if (!current || current.pid !== process.pid) return handle;
  const refreshed = { ...current, heartbeat_at: new Date(now()).toISOString() };
  writeFileAtomic(handle.lockPath, JSON.stringify(refreshed, null, 2));
  return { lock: refreshed, lockPath: handle.lockPath };
}

/** Release a held lock. Only removes the file if this process still owns it. */
export function releaseCodeLock(handle: CodeLockHandle): void {
  const current = readLock(handle.lockPath);
  if (current && current.pid !== process.pid) return; // someone reclaimed it; leave it.
  try {
    fs.unlinkSync(handle.lockPath);
  } catch {
    /* already gone */
  }
}

/** Read the current lock, if any (for status / doctor). */
export function readCodeLock(cwd?: string, preferredDirName?: string): CodeLock | null {
  return readLock(lockPath(cwd, preferredDirName));
}
