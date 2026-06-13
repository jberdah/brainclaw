/**
 * pln#560 step 2 slice 2 — board observer orchestration.
 * Cursor persistence + journal tail + counts merge, per
 * docs/concepts/observer-protocol.md §3/§4 and trp_2a89ae97.
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BoardObserver, mergeCounts, type CursorMemento, type SeedCounts } from './board-observer.js';
import type { ProjectedCounts } from './board-projection.js';
import type { JournalRecord } from './journal-consumer.js';

function tmpEvents(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-obs-'));
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  return path.join(dir, 'events');
}
function rec(seq: number, action: string, item_type: string, item_id: string, payload?: Record<string, unknown>): string {
  const r: JournalRecord = { v: 2, seq, action, item_type, item_id, ...(payload ? { payload } : {}) };
  return JSON.stringify(r);
}
function writeSeg(eventsDir: string, firstSeq: number, lines: string[]): void {
  fs.writeFileSync(path.join(eventsDir, `seg-${String(firstSeq).padStart(8, '0')}.jsonl`), lines.join('\n') + '\n');
}
function appendSeg(eventsDir: string, firstSeq: number, lines: string[]): void {
  fs.appendFileSync(path.join(eventsDir, `seg-${String(firstSeq).padStart(8, '0')}.jsonl`), lines.join('\n') + '\n');
}

/** In-memory Memento double. */
function memento(): CursorMemento & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get<T>(key: string): T | undefined { return store.get(key) as T | undefined; },
    update(key: string, value: unknown) { store.set(key, value); },
  };
}

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) { try { fs.rmSync(path.dirname(cleanup.pop()!), { recursive: true, force: true }); } catch { /* ignore */ } } });

const ZERO_JOURNAL: ProjectedCounts = { plans: 0, claims: 0, assignments: 0, runs: 0, actions: 0, agents: 0, sessions: 0, failedRuns: 0 };
const ZERO_SEED: SeedCounts = { claims: 0, assignments: 0, runs: 0, actions: 0, agents: 0, sessions: 0 };

describe('board observer (pln#560 s2 slice2)', () => {
  it('mergeCounts: plans from journal, everything else from the seed (trp_2a89ae97)', () => {
    const journal: ProjectedCounts = { ...ZERO_JOURNAL, plans: 4, claims: 0, actions: 0 };
    const seed: SeedCounts = { claims: 3, assignments: 2, runs: 1, actions: 7, agents: 5, sessions: 6, failedRuns: 1 };
    const merged = mergeCounts(journal, seed);
    assert.equal(merged.plans, 4, 'plans is journal-driven');
    assert.equal(merged.claims, 3);
    assert.equal(merged.actions, 7, 'attention badge comes from the seed — must not regress to 0');
    assert.equal(merged.agents, 5);
    assert.equal(merged.sessions, 6);
    assert.equal(merged.failedRuns, 1);
  });

  it('mergeCounts: missing seed.failedRuns defaults to 0', () => {
    assert.equal(mergeCounts(ZERO_JOURNAL, ZERO_SEED).failedRuns, 0);
  });

  it('ingest tails the journal into the projection and advances + persists the cursor', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [
      rec(1, 'create', 'plan', 'pln_1', { id: 'pln_1', status: 'todo' }),
      rec(2, 'create', 'plan', 'pln_2', { id: 'pln_2', status: 'in_progress' }),
    ]);
    const mem = memento();
    const obs = new BoardObserver(ev, 'prj_test', mem);
    const affected = obs.ingest();
    assert.deepEqual([...affected], ['plan']);
    assert.equal(obs.counts().plans, 2);
    assert.equal(obs.board().active_plans.length, 2);
    assert.deepEqual(mem.store.get('bclaw.observer.cursor.prj_test'), { seq: 2, checkpoint_seq: 0 });
  });

  it('a second ingest resumes from the persisted cursor (only new records applied)', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'pln_1', { id: 'pln_1', status: 'todo' })]);
    const mem = memento();
    const obs = new BoardObserver(ev, 'prj_test', mem);
    obs.ingest();
    appendSeg(ev, 1, [rec(2, 'create', 'trap', 'trp_1', { id: 'trp_1' })]);
    const affected = obs.ingest();
    assert.deepEqual([...affected], ['trap'], 'only the new record’s type is reported affected');
    assert.equal(obs.board().active_plans.length, 1);
    assert.equal(obs.board().known_traps.length, 1);
    assert.deepEqual(mem.store.get('bclaw.observer.cursor.prj_test'), { seq: 2, checkpoint_seq: 0 });
  });

  it('a fresh observer reusing a stored cursor does NOT re-apply already-seen records', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'pln_1', { id: 'pln_1', status: 'todo' })]);
    const mem = memento();
    mem.store.set('bclaw.observer.cursor.prj_test', { seq: 1, checkpoint_seq: 0 });
    const obs = new BoardObserver(ev, 'prj_test', mem);
    const affected = obs.ingest();
    assert.equal(affected.size, 0, 'cursor already past the only record');
    assert.equal(obs.board().active_plans.length, 0);
  });

  it('ingest on an absent events dir is a no-op, never throws', () => {
    const mem = memento();
    const obs = new BoardObserver(path.join(os.tmpdir(), 'bclaw-does-not-exist-xyz', 'events'), 'prj_x', mem);
    assert.doesNotThrow(() => obs.ingest());
    assert.equal(obs.counts().plans, 0);
  });

  it('a malformed stored cursor is ignored (cold-starts from 0)', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'pln_1', { id: 'pln_1', status: 'todo' })]);
    const mem = memento();
    mem.store.set('bclaw.observer.cursor.prj_test', { seq: -5 });   // corrupt
    const obs = new BoardObserver(ev, 'prj_test', mem);
    obs.ingest();
    assert.equal(obs.board().active_plans.length, 1, 'cold-started despite corrupt cursor');
  });
});
