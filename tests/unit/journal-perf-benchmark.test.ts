/**
 * Perf benchmark suite (pln#543 step 4). Asserts the STRUCTURAL win of
 * dirty-tracking deterministically (a single-entity mutation writes 1 file,
 * not N) and LOGS wall-clock against the plan's targets (bclaw_work cold
 * read < 1s, single-entity ops O(1)-ish). Wall-clock is observation, not
 * gate: slow Windows CI under memory pressure can blow loose ceilings and
 * that is not a structural regression. The structural counts are the
 * O(1) claim; flaky wall-clock asserts would only undermine it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyState, loadState, persistState,
  readPersistWriteStats, resetPersistWriteStats,
} from '../../src/core/state.js';
import { DecisionSchema, type Decision } from '../../src/core/schema.js';
import { runGenesisMigration } from '../../src/core/events/genesis.js';
import { verifyProjectionsAgainstJournal } from '../../src/core/events/verify.js';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-perf-')); }
function decision(i: number): Decision {
  return DecisionSchema.parse({ id: `dec_${String(i).padStart(4, '0')}`, short_label: `dec#${i}`, text: `decision ${i} body`, created_at: '2026-01-01T00:00:00.000Z', author: 'tester', tags: [] });
}

const N = 250;

describe('journal perf benchmark (pln#543 step 4)', () => {
  const cleanup: string[] = [];
  let savedMode: string | undefined;
  beforeEach(() => { savedMode = process.env.BRAINCLAW_JOURNAL_MODE; });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE; else process.env.BRAINCLAW_JOURNAL_MODE = savedMode;
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  it(`single-entity mutation writes 1 file regardless of store size (${N} entities)`, () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    for (let i = 0; i < N; i++) state.recent_decisions.push(decision(i));
    persistState(state, dir);

    // First persist writes all N (initial materialization).
    // A subsequent single-entity change must write exactly 1 — the O(1) win.
    const reload = loadState(dir);
    reload.recent_decisions.find(d => d.id === 'dec_0123')!.text = 'mutated';
    resetPersistWriteStats();
    const t0 = performance.now();
    persistState(reload, dir);
    const ms = performance.now() - t0;

    const stats = readPersistWriteStats();
    assert.equal(stats.written, 1, `O(1) write: 1 file, not ${N}`);
    assert.equal(stats.skippedUnchanged, N - 1, 'the rest are skipped');
    console.log(`    [bench] single-entity persist over ${N} entities: ${ms.toFixed(1)}ms, wrote ${stats.written}, skipped ${stats.skippedUnchanged}`);
  });

  it(`cold read (loadState) of ${N} entities is sub-second`, () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    for (let i = 0; i < N; i++) state.recent_decisions.push(decision(i));
    persistState(state, dir);

    const t0 = performance.now();
    const loaded = loadState(dir);
    const ms = performance.now() - t0;
    assert.equal(loaded.recent_decisions.length, N);
    console.log(`    [bench] cold loadState of ${N} entities: ${ms.toFixed(1)}ms`);
  });

  it(`genesis + materialize round-trip over ${N} entities is faithful and bounded`, () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    for (let i = 0; i < N; i++) state.recent_decisions.push(decision(i));
    persistState(state, dir);

    const t0 = performance.now();
    const result = runGenesisMigration({ cwd: dir });
    const genesisMs = performance.now() - t0;
    assert.equal(result.backfilled, N);

    const t1 = performance.now();
    const drift = verifyProjectionsAgainstJournal(dir);
    const verifyMs = performance.now() - t1;
    assert.deepEqual(drift, [], 'genesis must reproduce projections exactly');
    console.log(`    [bench] genesis ${N} entities: ${genesisMs.toFixed(1)}ms; verify replay: ${verifyMs.toFixed(1)}ms`);
  });
});
