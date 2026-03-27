import fs from 'node:fs';
import path from 'node:path';
const DEFAULT_TIMEOUT_MS = 5000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_EXPIRY_MS = 10000;
const heldLocks = new Map();
function lockFilePath(targetPath) {
    return targetPath + '.lock';
}
function syncSleep(ms) {
    if (ms <= 0)
        return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readLockData(lockPath) {
    try {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function tryCreateLock(lockPath) {
    const data = { pid: process.pid, timestamp: Date.now() };
    try {
        fs.writeFileSync(lockPath, JSON.stringify(data), { encoding: 'utf-8', flag: 'wx' });
        return true;
    }
    catch (err) {
        if (err instanceof Error && 'code' in err) {
            const code = err.code;
            if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
                return false;
            }
        }
        throw err;
    }
}
function tryBreakLock(lockPath) {
    const data = readLockData(lockPath);
    if (!data)
        return false;
    const expired = Date.now() - data.timestamp > LOCK_EXPIRY_MS;
    const ownerDead = !isProcessAlive(data.pid);
    if (!expired && !ownerDead)
        return false;
    try {
        fs.unlinkSync(lockPath);
    }
    catch {
        return false;
    }
    return tryCreateLock(lockPath);
}
export function acquireLock(targetPath, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const lockPath = lockFilePath(targetPath);
    const heldCount = heldLocks.get(lockPath);
    if (heldCount) {
        heldLocks.set(lockPath, heldCount + 1);
        return true;
    }
    const deadline = Date.now() + timeoutMs;
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    while (Date.now() < deadline) {
        if (tryCreateLock(lockPath)) {
            heldLocks.set(lockPath, 1);
            return true;
        }
        if (tryBreakLock(lockPath)) {
            heldLocks.set(lockPath, 1);
            return true;
        }
        syncSleep(Math.min(LOCK_RETRY_INTERVAL_MS, deadline - Date.now()));
    }
    return false;
}
export function releaseLock(targetPath) {
    const lockPath = lockFilePath(targetPath);
    const heldCount = heldLocks.get(lockPath);
    if (heldCount && heldCount > 1) {
        heldLocks.set(lockPath, heldCount - 1);
        return;
    }
    heldLocks.delete(lockPath);
    try {
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
        }
    }
    catch {
        // Ignore errors during release
    }
}
export function withLock(targetPath, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const acquired = acquireLock(targetPath, timeoutMs);
    if (!acquired) {
        throw new Error(`Could not acquire lock on ${path.basename(targetPath)} after ${timeoutMs}ms`);
    }
    try {
        return fn();
    }
    finally {
        releaseLock(targetPath);
    }
}
export function cleanStaleLocks(dirPath) {
    let removed = 0;
    let entries;
    try {
        entries = fs.readdirSync(dirPath);
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.endsWith('.lock'))
            continue;
        const lockPath = path.join(dirPath, entry);
        const data = readLockData(lockPath);
        if (!data)
            continue;
        const expired = Date.now() - data.timestamp > LOCK_EXPIRY_MS;
        const ownerDead = !isProcessAlive(data.pid);
        if (expired || ownerDead) {
            try {
                fs.unlinkSync(lockPath);
                removed++;
            }
            catch {
                // Another process may have already cleaned it
            }
        }
    }
    return removed;
}
//# sourceMappingURL=lock.js.map