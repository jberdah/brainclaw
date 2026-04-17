import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acquireLock,
  hashRequest,
  recordConflict,
  withLoopLock,
  IdempotencyKeyReusedError,
  LockLostError,
  LockTimeoutError,
  VersionConflictError,
  openLoop,
  generateLoopId,
  type LockBlob,
} from '../../src/core/loops/index.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loops-lock-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function loopsRoot(cwd: string): string {
  return path.join(cwd, '.brainclaw', 'loops');
}

function readLock(cwd: string, loopId: string): LockBlob | null {
  const filePath = path.join(loopsRoot(cwd), 'locks', `${loopId}.lock`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LockBlob;
}

describe('acquireLock', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('creates a lock blob with pid, host_id, agent_id, lease_until, hard_deadline, mutation_id', () => {
    const loopId = generateLoopId();
    const lock = acquireLock({
      lockPath: path.join(loopsRoot(cwd), 'locks', `${loopId}.lock`),
      agentId: 'agt_a',
      intent: 'open',
    });
    const blob = readLock(cwd, loopId)!;
    assert.equal(blob.agent_id, 'agt_a');
    assert.equal(blob.pid, process.pid);
    assert.equal(blob.host_id, os.hostname());
    assert.ok(blob.lease_until > blob.acquired_at);
    assert.ok(blob.hard_deadline > blob.acquired_at);
    assert.ok(blob.mutation_id);
    lock.release();
    assert.equal(readLock(cwd, loopId), null);
  });

  it('fails with LockTimeoutError when the path is held', () => {
    const loopId = generateLoopId();
    const lockPath = path.join(loopsRoot(cwd), 'locks', `${loopId}.lock`);
    const first = acquireLock({ lockPath, agentId: 'agt_a', intent: 'open' });
    try {
      assert.throws(
        () => acquireLock({ lockPath, agentId: 'agt_b', intent: 'open', timeoutMs: 50 }),
        (err) => err instanceof LockTimeoutError,
      );
    } finally {
      first.release();
    }
  });

  it('reclaims a lock whose pid is dead', () => {
    const loopId = generateLoopId();
    const lockPath = path.join(loopsRoot(cwd), 'locks', `${loopId}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const stale: LockBlob = {
      pid: 999_999, // almost certainly not alive
      host_id: os.hostname(),
      agent_id: 'agt_ghost',
      acquired_at: new Date(Date.now() - 120_000).toISOString(),
      lease_until: new Date(Date.now() - 60_000).toISOString(),
      hard_deadline: new Date(Date.now() + 300_000).toISOString(),
      mutation_id: 'stale_mut',
    };
    fs.writeFileSync(lockPath, JSON.stringify(stale));
    const live = acquireLock({ lockPath, agentId: 'agt_reaper', intent: 'advance' });
    assert.equal(readLock(cwd, loopId)?.agent_id, 'agt_reaper');
    live.release();
  });

  it('fenceCheck throws LockLostError when the lock blob has been replaced', () => {
    const loopId = generateLoopId();
    const lockPath = path.join(loopsRoot(cwd), 'locks', `${loopId}.lock`);
    const lock = acquireLock({ lockPath, agentId: 'agt_a', intent: 'advance' });
    // Simulate the lock being reaped + re-taken with a different mutation_id.
    const hijacked: LockBlob = { ...lock.blob, mutation_id: 'other_mut' };
    fs.writeFileSync(lockPath, JSON.stringify(hijacked));
    assert.throws(() => lock.fenceCheck(), (err) => err instanceof LockLostError);
    // Cleanup: original release is a no-op because mutation_id no longer matches.
    lock.release();
    fs.unlinkSync(lockPath);
  });
});

describe('withLoopLock — idempotency + CAS', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('returns a cached response on retry with the same client_request_id + payload', () => {
    const loop = openLoop({ kind: 'research', title: 'idem', created_by: 'agt_a' }, cwd);
    let callCount = 0;
    const request = { intent: 'custom', note: 'x' };

    const first = withLoopLock({
      cwd,
      intent: 'custom',
      agentId: 'agt_a',
      scope: { kind: 'loop', loopId: loop.id },
      clientRequestId: 'req_1',
      requestPayload: request,
      work: () => {
        callCount += 1;
        return { ok: true, run: callCount };
      },
    });
    assert.equal(first.run, 1);

    const second = withLoopLock({
      cwd,
      intent: 'custom',
      agentId: 'agt_a',
      scope: { kind: 'loop', loopId: loop.id },
      clientRequestId: 'req_1',
      requestPayload: request,
      work: () => {
        callCount += 1;
        return { ok: true, run: callCount };
      },
    });
    assert.equal(second.run, 1, 'second call must return cached response, not re-run');
    assert.equal(callCount, 1);
  });

  it('rejects reuse with a different payload', () => {
    const loop = openLoop({ kind: 'research', title: 'diff', created_by: 'agt_a' }, cwd);
    withLoopLock({
      cwd,
      intent: 'custom',
      agentId: 'agt_a',
      scope: { kind: 'loop', loopId: loop.id },
      clientRequestId: 'req_2',
      requestPayload: { body: 'first' },
      work: () => ({ ok: true }),
    });
    assert.throws(
      () =>
        withLoopLock({
          cwd,
          intent: 'custom',
          agentId: 'agt_a',
          scope: { kind: 'loop', loopId: loop.id },
          clientRequestId: 'req_2',
          requestPayload: { body: 'second' },
          work: () => ({ ok: true }),
        }),
      (err) => err instanceof IdempotencyKeyReusedError,
    );
  });

  it('throws VersionConflictError when expected_version mismatches and records a conflict', () => {
    const loop = openLoop({ kind: 'research', title: 'cas', created_by: 'agt_a' }, cwd);
    assert.throws(
      () =>
        withLoopLock({
          cwd,
          intent: 'advance',
          agentId: 'agt_a',
          scope: { kind: 'loop', loopId: loop.id },
          expectedVersion: 99,
          currentVersion: () => loop.version,
          work: () => ({ ok: true }),
        }),
      (err) => err instanceof VersionConflictError,
    );
    const conflictsLog = path.join(loopsRoot(cwd), 'conflicts', `${loop.id}.jsonl`);
    assert.ok(fs.existsSync(conflictsLog));
    const lines = fs.readFileSync(conflictsLog, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.expected_version, 99);
    assert.equal(entry.actual_version, loop.version);
  });

  it('open_idempotency scope uses agent_id + client_request_id', () => {
    let minted = 0;
    const run = () =>
      withLoopLock({
        cwd,
        intent: 'open',
        agentId: 'agt_a',
        scope: { kind: 'open_idempotency', clientRequestId: 'req_open_1' },
        clientRequestId: 'req_open_1',
        requestPayload: { kind: 'review', title: 'x' },
        loopIdForIdempotency: undefined,
        work: () => {
          minted += 1;
          return { loop_id: `lop_minted_${minted}` };
        },
      });
    const first = run();
    const second = run();
    assert.equal(minted, 1, 'open retries must not mint twice');
    assert.equal(first.loop_id, second.loop_id);
  });

  it('open_idempotency rejects the same key with a different payload hash', () => {
    withLoopLock({
      cwd,
      intent: 'open',
      agentId: 'agt_a',
      scope: { kind: 'open_idempotency', clientRequestId: 'req_open_2' },
      clientRequestId: 'req_open_2',
      requestPayload: { kind: 'review', title: 'first', nested: { a: 1, b: 2 } },
      work: () => ({ loop_id: 'lop_first' }),
    });

    assert.throws(
      () =>
        withLoopLock({
          cwd,
          intent: 'open',
          agentId: 'agt_a',
          scope: { kind: 'open_idempotency', clientRequestId: 'req_open_2' },
          clientRequestId: 'req_open_2',
          requestPayload: { kind: 'review', title: 'first', nested: { b: 9, a: 1 } },
          work: () => ({ loop_id: 'lop_second' }),
        }),
      (err) => err instanceof IdempotencyKeyReusedError,
    );
  });
});

describe('recordConflict + hashRequest', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('hashRequest is stable across key orderings', () => {
    const a = hashRequest({ a: 1, b: 2 });
    const b = hashRequest({ b: 2, a: 1 });
    assert.equal(a, b);
  });

  it('hashRequest is stable across nested object key orderings', () => {
    const a = hashRequest({
      kind: 'review',
      payload: { nested: { a: 1, b: 2 }, items: [{ z: 1, a: 2 }] },
    });
    const b = hashRequest({
      payload: { items: [{ a: 2, z: 1 }], nested: { b: 2, a: 1 } },
      kind: 'review',
    });
    assert.equal(a, b);
  });

  it('recordConflict appends a line with the expected shape', () => {
    recordConflict({
      loopId: 'lop_conflict',
      attemptedBy: 'agt_t',
      expectedVersion: 7,
      actualVersion: 9,
      rejectedIntent: 'advance',
      cwd,
    });
    const logPath = path.join(loopsRoot(cwd), 'conflicts', 'lop_conflict.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.loop_id, 'lop_conflict');
    assert.equal(entry.expected_version, 7);
    assert.equal(entry.actual_version, 9);
    assert.equal(entry.rejected_intent, 'advance');
  });
});
