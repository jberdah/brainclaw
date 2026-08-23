import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

  it('never reclaims an expired lock while its local owner process is alive', () => {
    const loopId = generateLoopId();
    const lockPath = path.join(loopsRoot(cwd), 'locks', `${loopId}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const suspendedButAlive: LockBlob = {
      pid: process.pid,
      host_id: os.hostname(),
      agent_id: 'agt_suspended',
      acquired_at: new Date(Date.now() - 300_000).toISOString(),
      lease_until: new Date(Date.now() - 240_000).toISOString(),
      hard_deadline: new Date(Date.now() - 120_000).toISOString(),
      mutation_id: 'live_expired_mut',
    };
    fs.writeFileSync(lockPath, JSON.stringify(suspendedButAlive));

    assert.throws(
      () => acquireLock({ lockPath, agentId: 'agt_takeover', intent: 'advance', timeoutMs: 50 }),
      (err) => err instanceof LockTimeoutError,
    );
    assert.equal(readLock(cwd, loopId)?.mutation_id, 'live_expired_mut');
    fs.unlinkSync(lockPath);
  });

  it('serializes two real processes racing to reap the same dead generation', async () => {
    const loopId = generateLoopId();
    const lockPath = path.join(loopsRoot(cwd), 'locks', `${loopId}.lock`);
    const tracePath = path.join(cwd, 'reaper-trace.jsonl');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const stale: LockBlob = {
      pid: 999_999,
      host_id: os.hostname(),
      agent_id: 'agt_dead',
      acquired_at: new Date(Date.now() - 300_000).toISOString(),
      lease_until: new Date(Date.now() - 240_000).toISOString(),
      hard_deadline: new Date(Date.now() - 120_000).toISOString(),
      mutation_id: 'shared_stale_generation',
    };
    fs.writeFileSync(lockPath, JSON.stringify(stale));

    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), 'dist-test', 'src', 'core', 'loops', 'index.js'),
    ).href;
    const childScript = [
      "import fs from 'node:fs';",
      `const { acquireLock } = await import(${JSON.stringify(moduleUrl)});`,
      'const [lockPath, tracePath, label] = process.argv.slice(1);',
      "const lock = acquireLock({ lockPath, agentId: label, intent: 'advance', timeoutMs: 3000 });",
      "fs.appendFileSync(tracePath, JSON.stringify({ kind: 'enter', label }) + '\\n');",
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);',
      "fs.appendFileSync(tracePath, JSON.stringify({ kind: 'exit', label }) + '\\n');",
      'lock.release();',
    ].join('\n');

    const run = (label: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, lockPath, tracePath, label], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label} exited ${code}: ${stderr}`));
      });
    });

    await Promise.all([run('agt_reaper_a'), run('agt_reaper_b')]);
    const trace = fs.readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: 'enter' | 'exit'; label: string });
    assert.equal(trace.length, 4);
    assert.equal(trace[0].kind, 'enter');
    assert.equal(trace[1].kind, 'exit', 'a second owner entered before the first released');
    assert.equal(trace[2].kind, 'enter');
    assert.equal(trace[3].kind, 'exit');
    assert.notEqual(trace[0].label, trace[2].label);
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
