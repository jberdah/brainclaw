import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

  it('throws when another process cannot acquire the lock in time', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');
    const lockModuleUrl = new URL('../../src/core/lock.js', import.meta.url).href;

    assert.equal(acquireLock(target, 50), true);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { withLock } from ${JSON.stringify(lockModuleUrl)}; withLock(${JSON.stringify(target)}, () => 'never', 20);`,
      ],
      { encoding: 'utf-8' },
    );
    releaseLock(target);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Could not acquire lock/);
  });

  it('cleans stale lock files left by dead processes', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const staleLock = path.join(dir, 'state.json.lock');
    fs.writeFileSync(staleLock, JSON.stringify({ pid: 999999, timestamp: Date.now() }), 'utf-8');

    assert.equal(cleanStaleLocks(dir), 1);
    assert.equal(fs.existsSync(staleLock), false);
  });

  it('allows re-entrant locking within the same process', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');

    const result = withLock(target, () => withLock(target, () => 'ok'));

    assert.equal(result, 'ok');
    assert.equal(fs.existsSync(`${target}.lock`), false);
  });
});
