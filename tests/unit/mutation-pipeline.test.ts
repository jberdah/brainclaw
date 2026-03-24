import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mutate, STORE_LOCK_TIMEOUT_MS } from '../../src/core/mutation-pipeline.js';
import { memoryDir, storeLockPath } from '../../src/core/io.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mutpipe-'));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('mutation-pipeline', () => {
  it('creates .brainclaw dir and executes the callback', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const result = mutate({ cwd: dir }, (cwd) => {
      assert.equal(cwd, dir);
      return 42;
    });

    assert.equal(result, 42);
    assert.equal(fs.existsSync(memoryDir(dir)), true);
  });

  it('propagates errors from the callback', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    assert.throws(() => {
      mutate({ cwd: dir }, () => {
        throw new Error('boom');
      });
    }, /boom/);
  });

  it('releases lock after error', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    try {
      mutate({ cwd: dir }, () => { throw new Error('fail'); });
    } catch { /* expected */ }

    // Should be able to acquire again immediately
    const result = mutate({ cwd: dir }, () => 'ok');
    assert.equal(result, 'ok');
  });

  it('supports re-entrant calls within the same process', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const result = mutate({ cwd: dir }, () => {
      return mutate({ cwd: dir }, () => 'nested');
    });

    assert.equal(result, 'nested');
  });

  it('uses default STORE_LOCK_TIMEOUT_MS of 5000', () => {
    assert.equal(STORE_LOCK_TIMEOUT_MS, 5_000);
  });

  it('blocks concurrent mutations from another process', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    // Acquire the lock in this process
    const brainclaw = memoryDir(dir);
    fs.mkdirSync(brainclaw, { recursive: true });

    const mutationModuleUrl = new URL('../../src/core/mutation-pipeline.js', import.meta.url).href;
    const ioModuleUrl = new URL('../../src/core/io.js', import.meta.url).href;

    // Hold the lock for a short time, spawn a child that tries to acquire it with a very short timeout
    mutate({ cwd: dir }, () => {
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import { mutate } from ${JSON.stringify(mutationModuleUrl)};
            try {
              mutate({ cwd: ${JSON.stringify(dir)}, timeoutMs: 50 }, () => 'should-not-reach');
              process.exit(0);
            } catch (e) {
              process.stderr.write(e.message);
              process.exit(1);
            }
          `,
        ],
        { encoding: 'utf-8', timeout: 10_000 },
      );

      assert.notEqual(child.status, 0, 'Child should fail to acquire lock');
      assert.match(child.stderr, /Could not acquire lock/);
    });
  });

  it('serializes concurrent multi-process mutations (stress test)', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    // Initialize .brainclaw
    fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });

    const counterFile = path.join(dir, '.brainclaw', 'counter.json');
    fs.writeFileSync(counterFile, '0', 'utf-8');

    const mutationModuleUrl = new URL('../../src/core/mutation-pipeline.js', import.meta.url).href;

    const WORKERS = 5;
    const INCREMENTS_PER_WORKER = 10;

    const workerScript = `
      import { mutate } from ${JSON.stringify(mutationModuleUrl)};
      import fs from 'node:fs';

      const cwd = ${JSON.stringify(dir)};
      const counterFile = ${JSON.stringify(counterFile)};

      for (let i = 0; i < ${INCREMENTS_PER_WORKER}; i++) {
        mutate({ cwd }, () => {
          const current = parseInt(fs.readFileSync(counterFile, 'utf-8'), 10);
          fs.writeFileSync(counterFile, String(current + 1), 'utf-8');
        });
      }
    `;

    // Spawn all workers truly concurrently using async spawn
    const workerPromises = Array.from({ length: WORKERS }, (_, w) =>
      new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('close', (status) => resolve({ status, stderr }));
      }),
    );

    const results = await Promise.all(workerPromises);

    for (let w = 0; w < WORKERS; w++) {
      const r = results[w]!;
      if (r.status !== 0) console.error(`Worker ${w} stderr:`, r.stderr);
      assert.equal(r.status, 0, `Worker ${w} should succeed`);
    }

    const finalValue = parseInt(fs.readFileSync(counterFile, 'utf-8'), 10);
    assert.equal(
      finalValue,
      WORKERS * INCREMENTS_PER_WORKER,
      `Expected ${WORKERS * INCREMENTS_PER_WORKER} but got ${finalValue} — race condition detected!`,
    );
  });

  it('stress: parallel mutations preserve file integrity (no partial writes)', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });

    const dataFile = path.join(dir, '.brainclaw', 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify({ items: [] }), 'utf-8');

    const mutationModuleUrl = new URL('../../src/core/mutation-pipeline.js', import.meta.url).href;

    const WORKERS = 4;
    const ITEMS_PER_WORKER = 8;

    const workerScript = (workerId: number) => `
      import { mutate } from ${JSON.stringify(mutationModuleUrl)};
      import fs from 'node:fs';

      const cwd = ${JSON.stringify(dir)};
      const dataFile = ${JSON.stringify(dataFile)};

      for (let i = 0; i < ${ITEMS_PER_WORKER}; i++) {
        mutate({ cwd }, () => {
          const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
          data.items.push({ worker: ${workerId}, seq: i });
          fs.writeFileSync(dataFile, JSON.stringify(data), 'utf-8');
        });
      }
    `;

    const workerPromises = Array.from({ length: WORKERS }, (_, w) =>
      new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript(w)], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('close', (status) => resolve({ status, stderr }));
      }),
    );

    const results = await Promise.all(workerPromises);

    for (let w = 0; w < WORKERS; w++) {
      const r = results[w]!;
      if (r.status !== 0) console.error(`Worker ${w} stderr:`, r.stderr);
      assert.equal(r.status, 0, `Worker ${w} should succeed`);
    }

    const final = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    assert.equal(
      final.items.length,
      WORKERS * ITEMS_PER_WORKER,
      `Expected ${WORKERS * ITEMS_PER_WORKER} items but got ${final.items.length}`,
    );

    // Validate JSON is well-formed (no partial writes)
    assert.equal(Array.isArray(final.items), true);
    for (const item of final.items) {
      assert.equal(typeof item.worker, 'number');
      assert.equal(typeof item.seq, 'number');
    }
  });
});
