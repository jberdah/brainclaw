/**
 * Code Map concurrency acceptance — spec §12.3.
 *
 * lock.test.ts already covers the lock UNIT seams (exclusive create / no-truncate,
 * live-blocks, dead-pid + stale-heartbeat reclaim, takeover validity). This file
 * adds the INTEGRATION half §12.3 asks for: two refreshes racing on the SAME temp
 * project, where the second sees a *live* lock and fails fast with a clear lock
 * status, never corrupting shards/indexes, leaving a consistent final store.
 *
 * To get a genuinely foreign + live lock owner (acquireCodeLock is re-entrant for
 * the test process's own pid), we spawn a real long-lived child process and plant
 * a lock owned by ITS pid. The real refresh() pipeline then uses the default
 * process.kill(pid,0) liveness check and must block. Everything runs in an
 * os.tmpdir() project; nothing touches the real <repo>/.brainclaw/code store.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { readManifest, readSymbolsIndex, listShards } from '../../../src/core/code-map/store.js';
import { lockPath, codeMapDir } from '../../../src/core/code-map/paths.js';
import { CodeLockSchema, type CodeLock } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_concurrency';
const cleanupDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop()!;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-concur-'));
  cleanupDirs.push(dir);
  writeSrc(
    dir,
    'src/app/App.tsx',
    `import React from 'react';\nexport const App = () => <div>app</div>;\nexport default App;\n`,
  );
  writeSrc(
    dir,
    'src/hooks/useAuth.ts',
    `import { useState } from 'react';\nexport function useAuth() { return useState(null); }\n`,
  );
  writeSrc(dir, 'src/util.ts', `export function add(a: number, b: number) { return a + b; }\n`);
  return dir;
}

async function refreshAll(root: string) {
  return refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });
}

/** Spawn a real, idle child process whose pid we can use as a live foreign owner. */
function spawnLiveChild(): ChildProcess {
  // node -e with a long timer: alive until we SIGKILL it in afterEach.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

/** Plant a foreign lock on disk owned by `pid` with a fresh (live) heartbeat. */
function plantLiveForeignLock(root: string, pid: number): CodeLock {
  fs.mkdirSync(codeMapDir(root), { recursive: true });
  const now = new Date().toISOString();
  const lock = CodeLockSchema.parse({
    schema_version: 1,
    lock_id: 'lock_competitor',
    project_id: PROJECT,
    owner_agent: 'codex',
    pid,
    operation: 'refresh',
    scope: 'all',
    created_at: now,
    heartbeat_at: now,
    stale_after_ms: 60_000,
  });
  fs.writeFileSync(lockPath(root), JSON.stringify(lock, null, 2), 'utf-8');
  return lock;
}

describe('code-map concurrency §12.3 — two refreshes on one project', () => {
  it('a refresh blocked by a LIVE competing lock fails fast and leaves the store consistent', async () => {
    const root = tmpProject();

    // 1. first refresh succeeds: establishes a known-good store.
    const first = await refreshAll(root);
    assert.equal(first.ran, true);
    const shardsBefore = listShards(root);
    assert.equal(shardsBefore.length, 3);
    const manifestBefore = readManifest(root)!;
    const symbolsBefore = JSON.stringify(readSymbolsIndex(root));

    // 2. a genuine live foreign writer now holds the lock.
    const child = spawnLiveChild();
    assert.ok(child.pid && child.pid !== process.pid, 'foreign live pid obtained');
    plantLiveForeignLock(root, child.pid!);

    // 3. a competing refresh launched while the lock is live must fail fast —
    //    never block bclaw_work (rule 8), never corrupt the store (§12.3).
    const t0 = performance.now();
    const blocked = await refreshAll(root);
    const blockedMs = performance.now() - t0;
    console.log(`[§12.3] blocked refresh returned in ${blockedMs.toFixed(1)}ms (must be fail-fast)`);

    assert.equal(blocked.ran, false, 'second refresh did not run');
    assert.equal(blocked.lock_acquired, false, 'second refresh did not acquire the lock');
    assert.ok(blocked.lock_status, 'a clear lock status is reported');
    assert.equal(blocked.lock_status, 'held_by_live_writer');
    assert.equal(blocked.freshness.status, 'partial', 'badge reflects the unavailable refresh');
    // fail-fast: should not have waited anywhere near the 60s stale window.
    assert.ok(blockedMs < 5000, `fail-fast (${blockedMs.toFixed(1)}ms, did not block on the live lock)`);

    // 4. the live competitor's lock was NOT truncated/stolen (exclusive create).
    const onDisk = CodeLockSchema.parse(JSON.parse(fs.readFileSync(lockPath(root), 'utf-8')));
    assert.equal(onDisk.lock_id, 'lock_competitor', 'live lock untouched');
    assert.equal(onDisk.pid, child.pid, 'live owner preserved');

    // 5. store consistency: the blocked refresh wrote NOTHING — shards/index/
    //    manifest are byte-identical to the known-good state. No corruption, no
    //    partial writes.
    const shardsAfter = listShards(root);
    assert.equal(shardsAfter.length, 3, 'no shard added/removed by the blocked refresh');
    assert.deepEqual(
      shardsAfter.map((s) => s.file_hash).sort(),
      shardsBefore.map((s) => s.file_hash).sort(),
      'shards uncorrupted',
    );
    assert.equal(JSON.stringify(readSymbolsIndex(root)), symbolsBefore, 'symbols index uncorrupted');
    const manifestAfter = readManifest(root)!;
    assert.equal(manifestAfter.stats.files_indexed, manifestBefore.stats.files_indexed);
    assert.equal(manifestAfter.freshness.status, 'fresh', 'manifest still reports the good state');

    // every shard remains schema-valid (no partially written JSON).
    for (const shard of shardsAfter) {
      assert.equal(shard.schema_version, 1, 'shard schema intact');
      assert.ok(shard.parse_status === 'parsed', 'shard parse_status intact');
    }
  });

  it('once the competitor exits, the lock is reclaimable and a fresh refresh succeeds', async () => {
    const root = tmpProject();
    await refreshAll(root);

    const child = spawnLiveChild();
    plantLiveForeignLock(root, child.pid!);

    // blocked while alive.
    const blocked = await refreshAll(root);
    assert.equal(blocked.lock_acquired, false);

    // competitor dies -> its lock becomes abandoned (dead pid) -> auto-reclaimed
    // by the next refresh without operator action (spec §5.8 / §12.3).
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
    // give the OS a beat to reap the pid so process.kill(pid,0) reports dead.
    await waitUntilDead(child.pid!);

    const recovered = await refreshAll(root);
    assert.equal(recovered.ran, true, 'refresh reclaims the abandoned lock and runs');
    assert.equal(recovered.lock_acquired, true);
    assert.equal(readManifest(root)!.freshness.status, 'fresh', 'store consistent after recovery');
    // lock is released after a successful refresh.
    assert.equal(fs.existsSync(lockPath(root)), false, 'lock released post-refresh');
  });

  it('exclusive create never truncates: a concurrent acquire attempt does not 0-byte the lock', async () => {
    // Direct §12.3 invariant ("lock acquisition uses exclusive create and does not
    // truncate an existing lock") at the refresh-integration level.
    const root = tmpProject();
    await refreshAll(root);
    const child = spawnLiveChild();
    const planted = plantLiveForeignLock(root, child.pid!);

    const blocked = await refreshAll(root);
    assert.equal(blocked.lock_acquired, false);

    const raw = fs.readFileSync(lockPath(root), 'utf-8');
    assert.ok(raw.length > 0, 'lock file not truncated to zero bytes');
    const parsed = CodeLockSchema.safeParse(JSON.parse(raw));
    assert.equal(parsed.success, true, 'lock file still schema-valid (uncorrupted)');
    assert.equal(parsed.data!.lock_id, planted.lock_id);
  });
});

/** Poll until process.kill(pid,0) reports the pid is gone (bounded). */
async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH -> gone.
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
