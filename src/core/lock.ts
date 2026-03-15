import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 2000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_EXPIRY_MS = 5000;

interface LockData {
  pid: number;
  timestamp: number;
}

function lockFilePath(targetPath: string): string {
  return targetPath + '.lock';
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
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

function tryCreateLock(lockPath: string): boolean {
  const data: LockData = { pid: process.pid, timestamp: Date.now() };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(data), { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function tryBreakLock(lockPath: string): boolean {
  const data = readLockData(lockPath);
  if (!data) return false;
  const expired = Date.now() - data.timestamp > LOCK_EXPIRY_MS;
  const ownerDead = !isProcessAlive(data.pid);
  if (!expired && !ownerDead) return false;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    return false;
  }
  return tryCreateLock(lockPath);
}

export function acquireLock(targetPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): boolean {
  const lockPath = lockFilePath(targetPath);
  const deadline = Date.now() + timeoutMs;

  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  while (Date.now() < deadline) {
    if (tryCreateLock(lockPath)) return true;
    if (tryBreakLock(lockPath)) return true;
    syncSleep(Math.min(LOCK_RETRY_INTERVAL_MS, deadline - Date.now()));
  }

  return false;
}

export function releaseLock(targetPath: string): void {
  const lockPath = lockFilePath(targetPath);
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Ignore errors during release
  }
}

export function withLock<T>(targetPath: string, fn: () => T, timeoutMs = DEFAULT_TIMEOUT_MS): T {
  const acquired = acquireLock(targetPath, timeoutMs);
  if (!acquired) {
    console.warn(`⚠ Could not acquire lock on ${path.basename(targetPath)} after ${timeoutMs}ms — proceeding anyway`);
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      releaseLock(targetPath);
    }
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
    if (!data) continue;
    const expired = Date.now() - data.timestamp > LOCK_EXPIRY_MS;
    const ownerDead = !isProcessAlive(data.pid);
    if (expired || ownerDead) {
      try {
        fs.unlinkSync(lockPath);
        removed++;
      } catch {
        // Another process may have already cleaned it
      }
    }
  }
  return removed;
}
