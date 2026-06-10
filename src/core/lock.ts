import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_EXPIRY_MS = 10000;
const LOCK_REFRESH_INTERVAL_MS = Math.max(1000, Math.floor(LOCK_EXPIRY_MS / 3));
const heldLocks = new Map<string, HeldLock>();

interface LockData {
  pid: number;
  timestamp: number;
  token?: string;
}

interface HeldLock {
  count: number;
  token: string;
  refreshTimer?: ReturnType<typeof setInterval>;
}

function lockFilePath(targetPath: string): string {
  return targetPath + '.lock';
}

/**
 * Review follow-up O3 (lop_e2d566765b8b4ce3): the re-entrancy map key must be
 * canonical, or two spellings of the same store path (relative vs absolute,
 * Windows drive-letter case) miss each other in `heldLocks` and the nested
 * acquire self-deadlocks for the full timeout. Resolve + case-fold (win32) for
 * the KEY only — the filesystem path used for I/O keeps its original spelling.
 */
function lockKey(lockPath: string): string {
  const resolved = path.resolve(lockPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockData(lockPath: string): LockData | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    return JSON.parse(raw) as LockData;
  } catch {
    return null;
  }
}

function randomToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sameLockData(left: LockData | null, right: LockData | null): boolean {
  if (!left || !right) return false;
  return left.pid === right.pid
    && left.timestamp === right.timestamp
    && (left.token ?? '') === (right.token ?? '');
}

function lockIsOwnedByCurrentProcess(data: LockData | null, token: string): boolean {
  return Boolean(data && data.pid === process.pid && data.token === token);
}

function writeLockData(lockPath: string, data: LockData, flag: string): void {
  fs.writeFileSync(lockPath, JSON.stringify(data), { encoding: 'utf-8', flag });
}

function tryCreateLock(lockPath: string): string | null {
  const token = randomToken();
  const data: LockData = { pid: process.pid, timestamp: Date.now(), token };
  try {
    writeLockData(lockPath, data, 'wx');
    return token;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
        return null;
      }
    }
    throw err;
  }
}

function lockFileIsOld(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > LOCK_EXPIRY_MS;
  } catch {
    return false;
  }
}

function canBreakLock(lockPath: string, data: LockData | null): boolean {
  if (!data) return lockFileIsOld(lockPath);
  if (data.pid === process.pid) return false;
  if (isProcessAlive(data.pid)) return false;
  return true;
}

/**
 * Review follow-up O2 (lop_e2d566765b8b4ce3) — accepted residual risk: a
 * microsecond TOCTOU remains between the second read and the rename, where a
 * third process can break+reacquire and the renamer steals a live lock. The
 * restore branch covers it unless a FOURTH process acquires inside that gap.
 * Decision (sprint 1.5): not closing it. The full fix is an O_EXCL token
 * handshake protocol — a coordinated change to every lock consumer — and the
 * residual window requires 4 racing processes inside microseconds on a lock
 * whose owner is already dead. Strictly better than the old unlink-based break.
 */
function tryBreakLock(lockPath: string): boolean {
  const observed = readLockData(lockPath);
  if (!canBreakLock(lockPath, observed)) return false;

  const current = readLockData(lockPath);
  if (!sameLockData(observed, current) && (observed || current)) return false;
  if (!canBreakLock(lockPath, current)) return false;

  // Dot-separated suffix with pid 4th-from-end so cleanOrphanFiles/tempOwnerPid
  // can reclaim tombstones from crashed breakers (dash-separated names were
  // unparseable and accumulated forever).
  const tombstone = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch {
    return false;
  }

  try {
    const moved = readLockData(tombstone);
    if ((observed || moved) && !sameLockData(observed, moved)) {
      try {
        if (!fs.existsSync(lockPath)) fs.renameSync(tombstone, lockPath);
      } catch {
        // If another process already acquired the lock path, leave the
        // mismatched tombstone for orphan cleanup instead of deleting live data.
      }
      return false;
    }

    const token = tryCreateLock(lockPath);
    try { fs.unlinkSync(tombstone); } catch { /* best effort */ }
    if (token) {
      startHeldLock(lockPath, token);
      return true;
    }
    return false;
  } catch {
    try {
      if (!fs.existsSync(lockPath)) fs.renameSync(tombstone, lockPath);
    } catch {
      // Best effort recovery; acquisition will retry.
    }
    return false;
  }
}

function refreshLock(lockPath: string, token: string): void {
  const current = readLockData(lockPath);
  if (!lockIsOwnedByCurrentProcess(current, token)) return;
  try {
    // 'r+' writes in place without truncating. Pad with trailing spaces (valid
    // JSON whitespace) so a payload shorter than the on-disk file can never
    // leave trailing garbage that would corrupt the lock for readers.
    let payload = JSON.stringify({ ...current!, timestamp: Date.now() });
    try {
      const existingSize = fs.statSync(lockPath).size;
      if (Buffer.byteLength(payload, 'utf-8') < existingSize) {
        payload = payload.padEnd(payload.length + (existingSize - Buffer.byteLength(payload, 'utf-8')), ' ');
      }
    } catch { /* stat failed — write unpadded */ }
    fs.writeFileSync(lockPath, payload, { encoding: 'utf-8', flag: 'r+' });
  } catch {
    // A failed refresh is not fatal; contenders still respect pid liveness.
  }
}

function startHeldLock(lockPath: string, token: string): void {
  const refreshTimer = setInterval(() => refreshLock(lockPath, token), LOCK_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
  heldLocks.set(lockKey(lockPath), { count: 1, token, refreshTimer });
}

export function acquireLock(targetPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): boolean {
  const lockPath = lockFilePath(targetPath);
  const held = heldLocks.get(lockKey(lockPath));
  if (held) {
    held.count += 1;
    refreshLock(lockPath, held.token);
    return true;
  }
  const deadline = Date.now() + timeoutMs;

  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  while (Date.now() < deadline) {
    const token = tryCreateLock(lockPath);
    if (token) {
      startHeldLock(lockPath, token);
      return true;
    }
    if (tryBreakLock(lockPath)) {
      return true;
    }
    syncSleep(Math.min(LOCK_RETRY_INTERVAL_MS, deadline - Date.now()));
  }

  return false;
}

export function releaseLock(targetPath: string): void {
  const lockPath = lockFilePath(targetPath);
  const held = heldLocks.get(lockKey(lockPath));
  if (held && held.count > 1) {
    held.count -= 1;
    return;
  }
  heldLocks.delete(lockKey(lockPath));
  if (held?.refreshTimer) clearInterval(held.refreshTimer);
  try {
    if (lockIsOwnedByCurrentProcess(readLockData(lockPath), held?.token ?? '')) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Ignore errors during release
  }
}

export function withLock<T>(targetPath: string, fn: () => T, timeoutMs = DEFAULT_TIMEOUT_MS): T {
  const acquired = acquireLock(targetPath, timeoutMs);
  if (!acquired) {
    throw new Error(`Could not acquire lock on ${path.basename(targetPath)} after ${timeoutMs}ms`);
  }
  try {
    return fn();
  } finally {
    releaseLock(targetPath);
  }
}

export function cleanStaleLocks(dirPath: string): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue;
    const lockPath = path.join(dirPath, entry);
    const data = readLockData(lockPath);
    if (canBreakLock(lockPath, data)) {
      const tombstone = `${lockPath}.clean.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.renameSync(lockPath, tombstone);
        fs.unlinkSync(tombstone);
        removed++;
      } catch {
        // Another process may have already cleaned it
      }
    }
  }
  return removed;
}
