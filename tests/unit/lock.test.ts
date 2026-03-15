import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, cleanStaleLocks, releaseLock, withLock } from '../../src/core/lock.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lock-'));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('core/lock', () => {
  it('acquires and releases a lock file', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');

    assert.equal(acquireLock(target, 50), true);
    assert.equal(fs.existsSync(`${target}.lock`), true);

    releaseLock(target);
    assert.equal(fs.existsSync(`${target}.lock`), false);
  });

  it('throws when withLock cannot acquire the lock in time', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');

    assert.equal(acquireLock(target, 50), true);
    assert.throws(() => withLock(target, () => 'never', 20), /Could not acquire lock/);
    releaseLock(target);
  });

  it('cleans stale lock files left by dead processes', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const staleLock = path.join(dir, 'state.json.lock');
    fs.writeFileSync(staleLock, JSON.stringify({ pid: 999999, timestamp: Date.now() }), 'utf-8');

    assert.equal(cleanStaleLocks(dir), 1);
    assert.equal(fs.existsSync(staleLock), false);
  });
});
