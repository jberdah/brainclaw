import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireCodeLock,
  readCodeLock,
  releaseCodeLock,
} from '../../../src/core/code-map/lock.js';
import { lockPath, codeMapDir } from '../../../src/core/code-map/paths.js';
import { CodeLockSchema, type CodeLock } from '../../../src/core/code-map/types.js';

const cleanupDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-lock-'));
  cleanupDirs.push(dir);
  fs.mkdirSync(codeMapDir(dir), { recursive: true });
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

/** Write a foreign lock file directly (different pid simulates another process). */
function writeForeignLock(cwd: string, overrides: Partial<CodeLock>): CodeLock {
  const now = new Date().toISOString();
  const lock = CodeLockSchema.parse({
    schema_version: 1,
    lock_id: 'lock_foreign',
    project_id: 'prj_test',
    owner_agent: 'codex',
    pid: 999999, // not our pid
    operation: 'refresh',
    scope: 'changed',
    created_at: now,
    heartbeat_at: now,
    stale_after_ms: 60000,
    ...overrides,
  });
  fs.writeFileSync(lockPath(cwd), JSON.stringify(lock, null, 2), 'utf-8');
  return lock;
}

describe('code-map lock', () => {
  it('exclusive create acquires when no lock exists', () => {
    const cwd = tmpProject();
    const handle = acquireCodeLock({ cwd, projectId: 'prj_test', ownerAgent: 'claude-code' });
    assert.ok(handle, 'acquired');
    assert.equal(handle.lock.pid, process.pid);
    assert.ok(fs.existsSync(lockPath(cwd)));
    releaseCodeLock(handle);
    assert.equal(fs.existsSync(lockPath(cwd)), false, 'released removes lock');
  });

  it('a LIVE foreign lock blocks a competing acquire', () => {
    const cwd = tmpProject();
    writeForeignLock(cwd, { heartbeat_at: new Date().toISOString() });
    const handle = acquireCodeLock({
      cwd,
      projectId: 'prj_test',
      // foreign pid is reported alive
      isPidAlive: (pid) => pid === 999999,
    });
    assert.equal(handle, null, 'live lock must block');
    // original lock untouched (not truncated)
    const onDisk = readCodeLock(cwd);
    assert.equal(onDisk!.lock_id, 'lock_foreign');
    assert.equal(onDisk!.pid, 999999);
  });

  it('abandoned lock (dead pid) is reclaimed automatically', () => {
    const cwd = tmpProject();
    writeForeignLock(cwd, { heartbeat_at: new Date().toISOString() });
    const handle = acquireCodeLock({
      cwd,
      projectId: 'prj_test',
      ownerAgent: 'claude-code',
      isPidAlive: () => false, // prior owner is dead
    });
    assert.ok(handle, 'dead-owner lock is reclaimed');
    assert.equal(handle.lock.pid, process.pid);
    const onDisk = readCodeLock(cwd);
    assert.equal(onDisk!.pid, process.pid, 'takeover wrote our lock');
    assert.equal(onDisk!.owner_agent, 'claude-code');
  });

  it('abandoned lock (stale heartbeat) is reclaimed when store is quiescent', () => {
    const cwd = tmpProject();
    // heartbeat 5 minutes ago, well beyond stale_after_ms=60000
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    writeForeignLock(cwd, { heartbeat_at: old, created_at: old });
    const handle = acquireCodeLock({
      cwd,
      projectId: 'prj_test',
      ownerAgent: 'claude-code',
      isPidAlive: () => true, // pid still alive, but heartbeat is stale
    });
    assert.ok(handle, 'stale heartbeat is reclaimed even with a live pid');
    assert.equal(readCodeLock(cwd)!.pid, process.pid);
  });

  it('stale heartbeat does NOT reclaim if a store file changed after the heartbeat', () => {
    const cwd = tmpProject();
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    writeForeignLock(cwd, { heartbeat_at: old, created_at: old });
    // simulate an in-progress writer touching the store after the heartbeat
    fs.writeFileSync(path.join(codeMapDir(cwd), 'manifest.json'), '{}', 'utf-8');
    const handle = acquireCodeLock({
      cwd,
      projectId: 'prj_test',
      isPidAlive: () => true,
    });
    assert.equal(handle, null, 'recent store change blocks reclaim of stale lock');
  });

  it('dead-pid lock IS reclaimed even when the store changed after the heartbeat', () => {
    // Regression guard: a process that crashed mid-refresh after writing a shard
    // leaves store mtime > heartbeat. The store-change guard must NOT gate the
    // dead-pid path, or crash recovery freezes until an operator intervenes
    // (spec §6 rule 1, §12.3 — operator-free reclaim).
    const cwd = tmpProject();
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    writeForeignLock(cwd, { heartbeat_at: old, created_at: old });
    // Simulate a shard written AFTER the last heartbeat, then the writer died.
    fs.writeFileSync(path.join(codeMapDir(cwd), 'manifest.json'), '{}', 'utf-8');
    const handle = acquireCodeLock({
      cwd,
      projectId: 'prj_test',
      ownerAgent: 'claude-code',
      isPidAlive: () => false, // owner is definitively dead
    });
    assert.ok(handle, 'dead owner must be reclaimed regardless of store mtime');
    assert.equal(readCodeLock(cwd)!.pid, process.pid);
  });

  it('re-entrant acquire by the same process refreshes rather than blocks', () => {
    const cwd = tmpProject();
    const first = acquireCodeLock({ cwd, projectId: 'prj_test', ownerAgent: 'claude-code' });
    assert.ok(first);
    const firstHeartbeat = first.lock.heartbeat_at;
    // Same process, real (alive) pid — must not be treated as a foreign live lock.
    const second = acquireCodeLock({ cwd, projectId: 'prj_test' });
    assert.ok(second, 're-entrant acquire by owning pid succeeds');
    assert.equal(second.lock.pid, process.pid);
    assert.ok(
      Date.parse(second.lock.heartbeat_at) >= Date.parse(firstHeartbeat),
      'heartbeat is refreshed on re-entry',
    );
    releaseCodeLock(second);
  });

  it('takeover does not leave temp/advisory litter that blocks the next reclaim', () => {
    // After an abandoned-lock takeover, writeFileAtomic may transiently create a
    // .tmp + an advisory .lock.lock under the store dir. A subsequent stale-lock
    // reclaim must still succeed: such litter is not authoritative store content.
    const cwd = tmpProject();
    writeForeignLock(cwd, { heartbeat_at: new Date().toISOString() });
    const first = acquireCodeLock({ cwd, projectId: 'prj_test', isPidAlive: () => false });
    assert.ok(first);
    releaseCodeLock(first);
    // Now plant a fresh stale foreign lock and confirm reclaim is not blocked by
    // any leftover litter from the first takeover.
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    writeForeignLock(cwd, { heartbeat_at: old, created_at: old, lock_id: 'lock_foreign2' });
    const second = acquireCodeLock({ cwd, projectId: 'prj_test', isPidAlive: () => true });
    assert.ok(second, 'stale reclaim succeeds despite prior-takeover litter');
    releaseCodeLock(second);
  });

  it('takeover leaves a valid (uncorrupted) lock file', () => {
    const cwd = tmpProject();
    writeForeignLock(cwd, {});
    const handle = acquireCodeLock({ cwd, projectId: 'prj_test', isPidAlive: () => false });
    assert.ok(handle);
    // parse the on-disk file fresh to assert no corruption
    const raw = fs.readFileSync(lockPath(cwd), 'utf-8');
    const parsed = CodeLockSchema.safeParse(JSON.parse(raw));
    assert.equal(parsed.success, true, 'reclaimed lock is schema-valid');
    releaseCodeLock(handle);
  });
});
