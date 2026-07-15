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
 *
 * The kill-9 crash-storm companion test lives in tests/journal-crash-storm.test.ts
 * (e2e lane): its spawned children must not run under the c8 coverage gate,
 * which exports NODE_V8_COVERAGE inherited by child processes (pln#622 PR0a).
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
});
