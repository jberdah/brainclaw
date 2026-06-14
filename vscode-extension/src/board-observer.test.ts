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
/** The registry_genesis cutover marker line (journal_note, no item_id). */
function registryGenesisMarker(seq: number): string {
  return JSON.stringify({ v: 2, seq, action: 'journal_note', item_type: 'journal', payload: { kind: 'registry_genesis', backfill_count: 0 } });
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
const ZERO_SEED: SeedCounts = { plans: 0, claims: 0, assignments: 0, runs: 0, actions: 0, agents: 0, sessions: 0 };

describe('board observer (pln#560 s2 slice2)', () => {
  it('mergeCounts: plans from journal, everything else from the seed (trp_2a89ae97)', () => {
    const journal: ProjectedCounts = { ...ZERO_JOURNAL, plans: 4, claims: 0, actions: 0 };
    const seed: SeedCounts = { plans: 9, claims: 3, assignments: 2, runs: 1, actions: 7, agents: 5, sessions: 6, failedRuns: 1 };
    const merged = mergeCounts(journal, seed);
    assert.equal(merged.plans, 4, 'plans is journal-driven (journalActive default)');
    assert.equal(merged.claims, 3);
    assert.equal(merged.actions, 7, 'attention badge comes from the seed — must not regress to 0');
    assert.equal(merged.agents, 5);
    assert.equal(merged.sessions, 6);
    assert.equal(merged.failedRuns, 1);
  });

  it('mergeCounts: missing seed.failedRuns defaults to 0', () => {
    assert.equal(mergeCounts(ZERO_JOURNAL, ZERO_SEED).failedRuns, 0);
  });

  it('mergeCounts: journalActive=false falls back to the seed plan count (journal off, §9)', () => {
    // journal projection reports 0 plans (empty/absent journal) but the store
    // has 9 — the badge/count must NOT regress to 0.
    const journal: ProjectedCounts = { ...ZERO_JOURNAL, plans: 0 };
    const seed: SeedCounts = { ...ZERO_SEED, plans: 9 };
    assert.equal(mergeCounts(journal, seed, false).plans, 9, 'falls back to seed plans when journal inactive');
    assert.equal(mergeCounts(journal, seed, true).plans, 0, 'uses journal plans when active');
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

  it('a fresh observer replays from the checkpoint floor before using the stored seq', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'pln_1', { id: 'pln_1', status: 'todo' })]);
    const mem = memento();
    mem.store.set('bclaw.observer.cursor.prj_test', { seq: 1, checkpoint_seq: 0 });
    const obs = new BoardObserver(ev, 'prj_test', mem);
    const affected = obs.ingest();
    assert.deepEqual([...affected], ['plan'], 'fresh process rebuilds its empty projection from the checkpoint floor');
    assert.equal(obs.board().active_plans.length, 1);

    const warmAffected = obs.ingest();
    assert.equal(warmAffected.size, 0, 'warm tail uses the persisted seq after bootstrap');
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

  // ── pln#568 slice 3 — registry cutover authority ─────────────────────────

  it('mergeCounts: registry families come from the journal ONLY when authoritative', () => {
    const journal: ProjectedCounts = { plans: 0, claims: 5, assignments: 4, runs: 3, actions: 8, agents: 0, sessions: 0, failedRuns: 2 };
    const seed: SeedCounts = { plans: 0, claims: 1, assignments: 1, runs: 1, actions: 1, agents: 5, sessions: 6, failedRuns: 0 };

    // Not authoritative → registry counts stay seed-backed (no badge regression).
    const seeded = mergeCounts(journal, seed, true, false);
    assert.equal(seeded.claims, 1);
    assert.equal(seeded.actions, 1, 'badge from seed until the cutover marker is present');

    // Authoritative → registry counts come from the journal.
    const authoritative = mergeCounts(journal, seed, true, true);
    assert.equal(authoritative.claims, 5);
    assert.equal(authoritative.assignments, 4);
    assert.equal(authoritative.runs, 3);
    assert.equal(authoritative.actions, 8, 'attention badge is now journal-driven');
    assert.equal(authoritative.failedRuns, 2);
    assert.equal(authoritative.agents, 5, 'agents/sessions are never journaled → always seed');
    assert.equal(authoritative.sessions, 6);
  });

  it('mergeCounts: registryAuthoritative is ignored when the journal is inactive (§9)', () => {
    const journal: ProjectedCounts = { ...ZERO_JOURNAL, claims: 5 };
    const seed: SeedCounts = { ...ZERO_SEED, claims: 1 };
    assert.equal(mergeCounts(journal, seed, false, true).claims, 1, 'journal off → seed even if marker was seen');
  });

  it('observer.registryAuthoritative flips true after ingesting the registry_genesis marker', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'claim', 'clm_1', { id: 'clm_1', status: 'active' })]);
    const mem = memento();
    const obs = new BoardObserver(ev, 'prj_test', mem);
    obs.ingest();
    assert.equal(obs.registryAuthoritative(), false, 'not authoritative before the marker');

    appendSeg(ev, 1, [registryGenesisMarker(2)]);
    obs.ingest();
    assert.equal(obs.registryAuthoritative(), true, 'authoritative once the marker is ingested');
  });

  it('a fresh observer re-derives registry authority by replaying from the floor', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [
      registryGenesisMarker(1),
      rec(2, 'backfill', 'claim', 'clm_1', { id: 'clm_1', status: 'active' }),
    ]);
    const mem = memento();
    // Simulate a warm cursor from a prior process that already passed the marker.
    mem.store.set('bclaw.observer.cursor.prj_test', { seq: 2, checkpoint_seq: 0 });
    const obs = new BoardObserver(ev, 'prj_test', mem);
    obs.ingest(); // cold start replays from checkpoint floor (0) → re-sees the marker
    assert.equal(obs.registryAuthoritative(), true, 'cold start re-derives authority from the journal');
  });
});
