import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoordinatorClaim, listClaims } from '../../src/core/claims.js';
import { cleanOrphanFiles } from '../../src/core/io.js';
import { mutate } from '../../src/core/mutation-pipeline.js';
import { emptyState, loadState, persistState } from '../../src/core/state.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-store-concurrency-'));
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runModule(script: string, timeout = 30_000): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout,
  });
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<{ status: number | null; stderr: string }> {
  return await new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('store concurrency regressions', { concurrency: false }, () => {
  it('preserves concurrent entity creates across a stale snapshot rewrite', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const staleSnapshot = emptyState();
    const stateModuleUrl = new URL('../../src/core/state.js', import.meta.url).href;

    for (let i = 0; i < 2; i++) {
      const child = runModule(`
        import { mutateState } from ${JSON.stringify(stateModuleUrl)};
        mutateState((state) => {
          state.recent_decisions.push({
            id: 'dec_child_${i}',
            short_label: 'dec#${i + 1}',
            text: 'child decision ${i}',
            created_at: '2026-06-10T00:00:0${i}.000Z',
            author: 'child',
            tags: [],
          });
        }, ${JSON.stringify(dir)});
      `);
      assert.equal(child.status, 0, child.stderr);
    }

    persistState(staleSnapshot, dir);

    const ids = loadState(dir).recent_decisions.map((decision) => decision.id).sort();
    assert.deepEqual(ids, ['dec_child_0', 'dec_child_1']);
  });

  it('does not steal the store lock from a live slow holder after expiry', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const marker = path.join(dir, 'child-acquired.txt');
    const mutationModuleUrl = new URL('../../src/core/mutation-pipeline.js', import.meta.url).href;
    const childScript = `
      import fs from 'node:fs';
      import { mutate } from ${JSON.stringify(mutationModuleUrl)};
      mutate({ cwd: ${JSON.stringify(dir)}, timeoutMs: 20_000 }, () => {
        fs.writeFileSync(${JSON.stringify(marker)}, 'acquired', 'utf-8');
      });
    `;

    let child: ReturnType<typeof spawn> | undefined;
    mutate({ cwd: dir, timeoutMs: 20_000 }, () => {
      child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      syncSleep(12_000);
      assert.equal(fs.existsSync(marker), false, 'child acquired the lock while the parent process was still alive');
    });

    assert.ok(child);
    const result = await waitForChild(child);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), true, 'child should acquire only after the parent releases');
  });

  it('creates at most one active coordinator claim for a scope under process contention', async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const claimsModuleUrl = new URL('../../src/core/claims.js', import.meta.url).href;
    const script = (agent: string) => `
      import { createCoordinatorClaim } from ${JSON.stringify(claimsModuleUrl)};
      createCoordinatorClaim({
        agent: ${JSON.stringify(agent)},
        scope: 'src/core/state.ts',
        description: 'race claim',
        dispatcherAgent: 'dispatcher',
        cwd: ${JSON.stringify(dir)}
      });
    `;

    const children = ['agent-a', 'agent-b'].map((agent) =>
      spawn(process.execPath, ['--input-type=module', '-e', script(agent)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );
    const results = await Promise.all(children.map(waitForChild));
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
    }

    const active = listClaims(dir).filter((claim) => claim.status === 'active' && claim.scope === 'src/core/state.ts');
    assert.equal(active.length, 1);
  });

  it('cleans only old temp files whose embedded owner pid is dead', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const old = new Date(Date.now() - 120_000);
    const recent = new Date();
    const deadPid = 9_999_999;

    const liveTmp = path.join(dir, `.live.json.${process.pid}.${Date.now() - 120_000}.aaaa.tmp`);
    const deadTmp = path.join(dir, `.dead.json.${deadPid}.${Date.now() - 120_000}.bbbb.tmp`);
    const recentDeadTmp = path.join(dir, `.recent.json.${deadPid}.${Date.now()}.cccc.tmp`);
    const unownedTmp = path.join(dir, '.unowned.tmp');

    for (const file of [liveTmp, deadTmp, recentDeadTmp, unownedTmp]) {
      fs.writeFileSync(file, 'tmp', 'utf-8');
    }
    fs.utimesSync(liveTmp, old, old);
    fs.utimesSync(deadTmp, old, old);
    fs.utimesSync(recentDeadTmp, recent, recent);
    fs.utimesSync(unownedTmp, old, old);

    const removed = cleanOrphanFiles(dir);

    assert.equal(removed, 1);
    assert.equal(fs.existsSync(deadTmp), false);
    assert.equal(fs.existsSync(liveTmp), true);
    assert.equal(fs.existsSync(recentDeadTmp), true);
    assert.equal(fs.existsSync(unownedTmp), true);
  });
});
