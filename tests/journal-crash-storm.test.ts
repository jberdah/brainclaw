/**
 * pln#565 — kill-9 crash-storm convergence test (moved out of tests/unit by
 * pln#622 PR0a).
 *
 * WHY THIS FILE LIVES OUTSIDE tests/unit (do not move it back):
 * scripts/run-tests.mjs classifies tests/unit/** as the "unit" group, which CI
 * runs under the c8 "Coverage gate" job. c8 works by exporting
 * NODE_V8_COVERAGE, and that variable is INHERITED by every child process this
 * test spawns — so each of the N Node children paid an instrumented ESM
 * cold-start plus V8 coverage collection inside its tight fsync-per-append
 * loop. Under a loaded shared runner that starved the children so badly that
 * fewer than QUORUM of them committed a single append before the deadline,
 * flaking 4 of 5 PRs during the 1.15.0 release. Three timer patches (quorum
 * pln#573, commit markers pln#574, CI-scaled deadline) all failed because the
 * budget being exhausted was instrumentation overhead, not startup time.
 * The fix is structural: this file sits directly under tests/, so
 * run-tests.mjs classifies it as "e2e" and it runs in the required
 * "E2E Tests (Linux)" CI job — which never wraps the runner in c8.
 * Belt-and-braces, NODE_V8_COVERAGE is also stripped from the env passed to
 * the spawned children below, so the test stays storm-shaped even if someone
 * runs this file under a coverage wrapper locally.
 *
 * The journal's crash-safety claim: a process killed mid-append (SIGKILL, no
 * cleanup) must never make the journal unreadable, never cause seq reuse, and
 * never block recovery. Only REAL separate OS processes killed uncooperatively
 * can exercise this. The four post-crash invariants asserted here are the
 * cutover gate and must stay intact:
 *   1. journal stays readable (torn tails skipped, never throw)
 *   2. committed seqs are unique (no duplicate after crash)
 *   3. gaps ARE allowed (a torn final frame burns its seq intent)
 *   4. recovery append succeeds with seq > pre-recovery max (no collision)
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMemoryDir } from '../src/core/io.js';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { readJournalRecords, forceAppendJournalRecords } from '../src/core/events/journal.js';
import { materializeMemoryStateFromJournal } from '../src/core/events/materialize.js';

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-journal-crash-storm-'));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('journal-crash-storm', { projectId: 'prj_journal_storm' }), dir);
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

describe('journal crash-storm convergence (pln#565 — cutover gate)', { concurrency: false }, () => {
  it('converges after a kill-9 storm: journal stays readable, seq never duplicates, next append does not collide', async () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);

    // 3 children (down from 4, pln#622 PR0a): the invariants need several
    // concurrent committers racing the lock, not a specific count, and each
    // extra fsync-per-append loop multiplies disk contention on shared runners.
    const N = 3;
    const journalUrl = new URL('../src/core/events/journal.js', import.meta.url).href;

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

    // Belt-and-braces: never let a coverage wrapper instrument the children
    // (see the file header — inherited NODE_V8_COVERAGE was the flake's root
    // cause when this test lived in the c8-wrapped unit lane).
    const childEnv = { ...process.env };
    delete childEnv.NODE_V8_COVERAGE;

    const children = Array.from({ length: N }, (_, i) =>
      spawn(process.execPath, ['--input-type=module', '-e', childScript(i)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: childEnv,
      }),
    );

    // Kill once a QUORUM of children have each committed at least once — we do
    // NOT wait for all N. The invariant under test (no seq reuse / readable torn
    // tail after a crash) only needs several concurrent committers; requiring
    // all N made the precondition flaky under disk-I/O contention, where a tight
    // fsync-per-append loop in the already-started children can starve a slow
    // starter for a long time (pln#573). Killing while some children are still
    // mid-append is also stronger crash stress, not weaker.
    // QUORUM stays at 2 (review decision, pln#622 PR0a): a single committer
    // cannot witness cross-process seq races, so 1 would gut the invariant.
    const committedCount = () =>
      Array.from({ length: N }, (_, i) => markerPath(i)).filter((p) => fs.existsSync(p)).length;
    const QUORUM = 2;
    // Startup budget, not invariant budget: uninstrumented cold-starts are
    // quick, but shared CI runners can still stall process spawn. Kept within
    // the 300s per-file e2e budget of scripts/run-tests.mjs.
    const deadline = Date.now() + (process.env.CI ? 210_000 : 90_000);
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
    // A child SIGKILLed mid-lock-write can leave a TORN .brainclaw.store-mutation
    // .lock file: canBreakLock (src/core/lock.ts) cannot verify a dead owner pid
    // from unparseable data and falls back to mtime expiry (LOCK_EXPIRY_MS = 10s),
    // which exceeds a single append's 5s acquisition timeout. That self-heal
    // window is designed crash-recovery behavior, so retry the recovery append
    // across it — the invariant is convergence, not convergence-in-one-attempt.
    const maxSeqBefore = Math.max(...seqs);
    let recovered: ReturnType<typeof forceAppendJournalRecords>[number] | undefined;
    let lastRecoveryError: unknown;
    const recoveryDeadline = Date.now() + 30_000;
    while (Date.now() < recoveryDeadline) {
      try {
        [recovered] = forceAppendJournalRecords([{
          action: 'journal_note', item_type: 'journal', agent: 'coordinator',
          summary: 'post-storm recovery append',
        }], dir);
        break;
      } catch (err) {
        lastRecoveryError = err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(recovered, `post-storm append must succeed within the stale-lock expiry budget (last error: ${String(lastRecoveryError)})`);
    assert.ok(recovered.seq > maxSeqBefore, `recovery seq ${recovered.seq} must exceed pre-recovery max ${maxSeqBefore} (no collision/absorption)`);

    // INVARIANT 4: state still materializes from the recovered journal.
    const reread = readJournalRecords(dir);
    assert.equal(new Set(reread.map((r) => r.seq)).size, reread.length, 'seqs still unique after recovery append');
    assert.doesNotThrow(() => materializeMemoryStateFromJournal(dir), 'journal must still materialize after the storm + recovery');
  });
});
