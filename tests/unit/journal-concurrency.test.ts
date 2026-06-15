/**
 * pln#565 step 2 — two-process append stress test (Phase-2 cutover gate).
 *
 * The journal's correctness claim under multi-agent traffic rests on the
 * store lock serializing single-buffer framed appends (§2.2/§2.6): concurrent
 * writers must never interleave bytes, never collide on a seq, and never lose
 * a record. In-process async cannot test this (it shares the lock's in-process
 * state) — only REAL separate OS processes contending for the file lock do.
 *
 * N children × K events each, appended concurrently to one store via
 * forceAppendJournalRecords (mode-independent). After join we assert the
 * journal holds exactly N*K well-framed records, a gap-free 1..N*K seq with no
 * duplicates, and exactly N distinct writers (one per process) — i.e. the lock
 * held and no append was torn or lost.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMemoryDir } from '../../src/core/io.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { readJournalRecords, forceAppendJournalRecords } from '../../src/core/events/journal.js';
import { materializeMemoryStateFromJournal } from '../../src/core/events/materialize.js';

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-journal-concurrency-'));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('journal-concurrency', { projectId: 'prj_journal_conc' }), dir);
  return dir;
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

describe('journal append concurrency (pln#565 — cutover gate)', { concurrency: false }, () => {
  it('serializes N concurrent processes × K appends with gap-free seq, no torn/lost records', async () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);

    const N = 4;
    const K = 12;
    const journalUrl = new URL('../../src/core/events/journal.js', import.meta.url).href;

    const childScript = (child: number) => `
      import { forceAppendJournalRecords } from ${JSON.stringify(journalUrl)};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let k = 0; k < ${K}; k++) {
        forceAppendJournalRecords([{
          action: 'create',
          item_type: 'decision',
          item_id: 'dec_c${child}_' + k,
          agent: 'child-${child}',
          summary: 'child ${child} event ' + k,
        }], ${JSON.stringify(dir)});
        // Jitter between appends so the advisory store lock circulates fairly.
        // The lock is O_EXCL-create with no fairness queue; a tight re-acquire
        // loop lets one writer monopolize it and starve siblings past the
        // acquisition timeout under load (pln#574). Writers still overlap — the
        // serialization invariants below are unchanged — they just don't hammer
        // the lock in lock-step.
        await sleep(5 + Math.floor(Math.random() * 25));
      }
    `;

    const children = Array.from({ length: N }, (_, i) =>
      spawn(process.execPath, ['--input-type=module', '-e', childScript(i)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );
    const results = await Promise.all(children.map(waitForChild));
    for (const result of results) {
      assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    }

    const records = readJournalRecords(dir);

    // 1. No record lost and none torn-skipped: exactly N*K survive the reader.
    assert.equal(records.length, N * K, `expected ${N * K} records, got ${records.length}`);

    // 2. seq is a gap-free, duplicate-free 1..N*K — proves the lock serialized
    //    every append (no two processes minted the same seq, none was lost).
    const seqs = records.map((r) => r.seq).sort((a, b) => a - b);
    const expected = Array.from({ length: N * K }, (_, i) => i + 1);
    assert.deepEqual(seqs, expected, 'seq must be gap-free 1..N*K with no duplicates');

    // 3. Exactly N distinct writers (one WRITER_ID per process) — proves the
    //    appends genuinely came from separate processes contending for the lock.
    const writers = new Set(records.map((r) => r.writer));
    assert.equal(writers.size, N, `expected ${N} distinct writers, got ${writers.size}`);

    // 4. Every record is well-framed (required envelope fields present).
    for (const r of records) {
      assert.equal(r.v, 2);
      assert.ok(typeof r.seq === 'number' && r.seq > 0);
      assert.ok(r.writer && r.action && r.item_type);
    }

    // 5. (seq, writer) pairs are unique (defensive — implied by gap-free seq).
    const pairs = new Set(records.map((r) => `${r.seq}:${r.writer}`));
    assert.equal(pairs.size, N * K);
  });

  it('converges after a kill-9 storm: journal stays readable, seq never duplicates, next append does not collide', async () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);

    const N = 4;
    const journalUrl = new URL('../../src/core/events/journal.js', import.meta.url).href;

    // Each child appends in a tight unbounded loop (fsync per append), writing a
    // marker file after its FIRST committed append so the parent can kill on a
    // deterministic signal (commit happened) rather than a racy wall-clock delay
    // — node ESM cold-start under variable load made a fixed timeout flaky.
    const markerPath = (i: number) => path.join(dir, `child-${i}.committed`);
    const childScript = (child: number) => `
      import fs from 'node:fs';
      import { forceAppendJournalRecords } from ${JSON.stringify(journalUrl)};
      for (let k = 0; k < 100000; k++) {
        forceAppendJournalRecords([{
          action: 'create', item_type: 'decision',
          item_id: 'dec_k${child}_' + k, agent: 'killable-${child}',
        }], ${JSON.stringify(dir)});
        if (k === 0) fs.writeFileSync(${JSON.stringify(markerPath(child))}, 'ok');
      }
    `;

    const children = Array.from({ length: N }, (_, i) =>
      spawn(process.execPath, ['--input-type=module', '-e', childScript(i)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      }),
    );

    // Kill once a QUORUM of children have each committed at least once — we do
    // NOT wait for all N. The invariant under test (no seq reuse / readable torn
    // tail after a crash) only needs several concurrent committers; requiring
    // all N made the precondition flaky under disk-I/O contention, where a tight
    // fsync-per-append loop in the already-started children can starve a slow
    // starter for a long time (pln#573). Killing while some children are still
    // mid-append is also stronger crash stress, not weaker.
    const committedCount = () =>
      Array.from({ length: N }, (_, i) => markerPath(i)).filter((p) => fs.existsSync(p)).length;
    const QUORUM = 2;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (committedCount() >= QUORUM) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      committedCount() >= QUORUM,
      `at least ${QUORUM} of ${N} children should have committed at least once before the kill`,
    );
    for (const c of children) c.kill('SIGKILL');
    await Promise.all(children.map(waitForChild));

    // INVARIANT 1: the journal is always readable after a crash storm — torn
    // tails are skipped by the reader, never throw.
    const afterKill = readJournalRecords(dir);
    assert.ok(afterKill.length > 0, 'expected some committed records to survive the storm');

    // INVARIANT 2: no seq is ever duplicated — a process killed mid-append must
    // not have caused another to reuse a committed seq (the core crash-safety
    // claim). Gaps ARE allowed: a torn final frame burns its seq intent.
    const seqs = afterKill.map((r) => r.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'committed seqs must be unique (no duplicate after crash)');

    // INVARIANT 3: recovery converges — a clean append AFTER the storm succeeds,
    // re-derives next_seq from the (possibly torn) tail, and does not collide
    // with any surviving seq.
    const maxSeqBefore = Math.max(...seqs);
    const [recovered] = forceAppendJournalRecords([{
      action: 'journal_note', item_type: 'journal', agent: 'coordinator',
      summary: 'post-storm recovery append',
    }], dir);
    assert.ok(recovered, 'post-storm append must succeed');
    assert.ok(recovered.seq > maxSeqBefore, `recovery seq ${recovered.seq} must exceed pre-recovery max ${maxSeqBefore} (no collision/absorption)`);

    // INVARIANT 4: state still materializes from the recovered journal.
    const reread = readJournalRecords(dir);
    assert.equal(new Set(reread.map((r) => r.seq)).size, reread.length, 'seqs still unique after recovery append');
    assert.doesNotThrow(() => materializeMemoryStateFromJournal(dir), 'journal must still materialize after the storm + recovery');
  });
});
