import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../src/core/io.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-io-'));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('core/io', () => {
  it('writes atomically and leaves no temp files behind', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');

    writeFileAtomic(target, '{"ok":true}\n');

    assert.equal(fs.readFileSync(target, 'utf-8'), '{"ok":true}\n');
    const leftovers = fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('retries rename on transient errors and eventually succeeds', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');
    const realRename = fs.renameSync.bind(fs);
    const attempts: string[] = [];
    const delays: number[] = [];

    writeFileAtomic(target, 'content\n', {
      fsImpl: {
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: ((tmpPath: fs.PathLike, targetPath: fs.PathLike) => {
          attempts.push(String(tmpPath));
          if (attempts.length < 3) {
            const error = new Error('busy') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          realRename(tmpPath, targetPath);
        }) as typeof fs.renameSync,
      },
      maxRenameAttempts: 4,
      retryDelayMs: 5,
      sleep: (ms) => delays.push(ms),
    });

    assert.equal(fs.readFileSync(target, 'utf-8'), 'content\n');
    assert.equal(attempts.length, 3);
    assert.deepEqual(delays, [5, 10]);
  });

  it('does not retry non-retryable rename errors', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');
    let attempts = 0;

    assert.throws(() => writeFileAtomic(target, 'content\n', {
      fsImpl: {
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: ((_: fs.PathLike, __: fs.PathLike) => {
          attempts++;
          const error = new Error('invalid') as NodeJS.ErrnoException;
          error.code = 'EINVAL';
          throw error;
        }) as typeof fs.renameSync,
      },
      maxRenameAttempts: 4,
      retryDelayMs: 5,
      sleep: () => undefined,
    }), /invalid/);

    assert.equal(attempts, 1);
  });

  it('retries on EBUSY (Windows file-in-use)', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');
    const realRename = fs.renameSync.bind(fs);
    let attempts = 0;

    writeFileAtomic(target, 'ebusy-test\n', {
      fsImpl: {
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: ((tmpPath: fs.PathLike, targetPath: fs.PathLike) => {
          attempts++;
          if (attempts === 1) {
            const err = new Error('resource busy') as NodeJS.ErrnoException;
            err.code = 'EBUSY';
            throw err;
          }
          realRename(tmpPath, targetPath);
        }) as typeof fs.renameSync,
      },
      maxRenameAttempts: 3,
      retryDelayMs: 1,
      sleep: () => undefined,
    });

    assert.equal(fs.readFileSync(target, 'utf-8'), 'ebusy-test\n');
    assert.equal(attempts, 2);
  });

  it('retries on EACCES (Windows permission denied)', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');
    const realRename = fs.renameSync.bind(fs);
    let attempts = 0;

    writeFileAtomic(target, 'eacces-test\n', {
      fsImpl: {
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: ((tmpPath: fs.PathLike, targetPath: fs.PathLike) => {
          attempts++;
          if (attempts <= 2) {
            const err = new Error('permission denied') as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          realRename(tmpPath, targetPath);
        }) as typeof fs.renameSync,
      },
      maxRenameAttempts: 4,
      retryDelayMs: 1,
      sleep: () => undefined,
    });

    assert.equal(fs.readFileSync(target, 'utf-8'), 'eacces-test\n');
    assert.equal(attempts, 3);
  });

  it('throws after exhausting all retry attempts', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');
    let attempts = 0;

    assert.throws(() => writeFileAtomic(target, 'exhausted\n', {
      fsImpl: {
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: ((_: fs.PathLike, __: fs.PathLike) => {
          attempts++;
          const err = new Error('always busy') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }) as typeof fs.renameSync,
      },
      maxRenameAttempts: 3,
      retryDelayMs: 1,
      sleep: () => undefined,
    }), /always busy/);

    // Should have tried exactly maxRenameAttempts times
    assert.equal(attempts, 3);
  });

  it('backoff delay increases linearly with each attempt', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const target = path.join(dir, 'state.json');
    const realRename = fs.renameSync.bind(fs);
    const delays: number[] = [];
    let attempts = 0;

    writeFileAtomic(target, 'backoff-test\n', {
      fsImpl: {
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: ((tmpPath: fs.PathLike, targetPath: fs.PathLike) => {
          attempts++;
          if (attempts < 4) {
            const err = new Error('eperm') as NodeJS.ErrnoException;
            err.code = 'EPERM';
            throw err;
          }
          realRename(tmpPath, targetPath);
        }) as typeof fs.renameSync,
      },
      maxRenameAttempts: 5,
      retryDelayMs: 10,
      sleep: (ms) => delays.push(ms),
    });

    assert.deepEqual(delays, [10, 20, 30]); // retryDelayMs * (attempt + 1)
  });
});
