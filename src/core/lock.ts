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

function isLockExpired(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const data: LockData = JSON.parse(raw);
    return Date.now() - data.timestamp > LOCK_EXPIRY_MS;
  } catch {
    return true;
  }
}

function writeLock(lockPath: string): void {
  const data: LockData = { pid: process.pid, timestamp: Date.now() };
  fs.writeFileSync(lockPath, JSON.stringify(data), 'utf-8');
}

export function acquireLock(targetPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): boolean {
  const lockPath = lockFilePath(targetPath);
  const deadline = Date.now() + timeoutMs;

  // Ensure directory exists
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  while (Date.now() < deadline) {
    if (!fs.existsSync(lockPath)) {
      try {
        writeLock(lockPath);
        return true;
      } catch {
        // Another process may have grabbed it between check and write
      }
    } else if (isLockExpired(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        writeLock(lockPath);
        return true;
      } catch {
        // Race condition — try again
      }
    }

    // Spin-wait (sync — this is a CLI tool, not a server)
    const until = Date.now() + LOCK_RETRY_INTERVAL_MS;
    while (Date.now() < until) {
      // busy-wait
    }
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
