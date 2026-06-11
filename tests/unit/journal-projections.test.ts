import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyState, loadState, persistState,
  readPersistWriteStats, resetPersistWriteStats,
} from '../../src/core/state.js';
import {
  type State, type Decision, type PlanItem, type Trap,
  DecisionSchema, PlanItemSchema, TrapSchema,
} from '../../src/core/schema.js';
import { readJournalRecords } from '../../src/core/events/journal.js';
import {
  materializeMemoryStateFromJournal,
  verifyProjectionsAgainstJournal,
} from '../../src/core/events/materialize.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-jproj-'));
}

// Build schema-valid docs by parsing a minimal seed (fills defaults).
function decision(id: string, text: string): Decision {
  return DecisionSchema.parse({ id, short_label: id.replace('dec_', 'dec#'), text, created_at: '2026-01-01T00:00:00.000Z', author: 'tester', tags: [] });
}
function plan(id: string, text: string): PlanItem {
  return PlanItemSchema.parse({ id, short_label: id.replace('pln_', 'pln#'), text, type: 'feat', status: 'todo', priority: 'medium', created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', author: 'tester', tags: [] });
}
function trap(id: string, text: string): Trap {
  return TrapSchema.parse({ id, short_label: id.replace('trp_', 'trp#'), text, created_at: '2026-01-01T00:00:00.000Z', author: 'tester', status: 'active', severity: 'low', scope: 'project', tags: [] });
}

describe('journal projections — dirty tracking + materialize (pln#543 step 3)', () => {
  const cleanup: string[] = [];
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.BRAINCLAW_JOURNAL_MODE;
    resetPersistWriteStats();
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE;
    else process.env.BRAINCLAW_JOURNAL_MODE = savedMode;
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  it('dirty-tracking: re-persisting unchanged state writes 0 files', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_a', 'first'));
    state.plan_items.push(plan('pln_a', 'planned'));
    persistState(state, dir);

    resetPersistWriteStats();
    persistState(loadState(dir), dir); // identical content
    const stats = readPersistWriteStats();
    assert.equal(stats.written, 0, 'no file should be rewritten when nothing changed');
    assert.ok(stats.skippedUnchanged >= 2, 'unchanged files skipped');
  });

  it('dirty-tracking: a single-entity change rewrites exactly 1 file, not N', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    for (let i = 0; i < 5; i++) state.recent_decisions.push(decision(`dec_${i}`, `text ${i}`));
    persistState(state, dir);

    resetPersistWriteStats();
    const reload = loadState(dir);
    reload.recent_decisions.find(d => d.id === 'dec_2')!.text = 'changed';
    persistState(reload, dir);
    assert.equal(readPersistWriteStats().written, 1, 'only the changed entity is rewritten');
  });

  it('dirty-tracking is safe against trp#126: a missing projection file is always rewritten', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_x', 'present'));
    persistState(state, dir);

    // Simulate a lost projection while the entity is still in state.
    fs.unlinkSync(path.join(dir, '.brainclaw', 'memory', 'decisions', 'dec_x.json'));
    resetPersistWriteStats();
    persistState(state, dir); // state still holds dec_x
    assert.equal(fs.existsSync(path.join(dir, '.brainclaw', 'memory', 'decisions', 'dec_x.json')), true);
    assert.equal(readPersistWriteStats().written, 1);
  });

  it('flag off: no per-entity journal records emitted', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_off', 'x'));
    persistState(state, dir);
    assert.equal(readJournalRecords(dir).length, 0);
  });

  it('dual mode: persist emits per-entity post-images (entity-state with payload), not a coarse store_marker', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_p', 'hello'));
    state.plan_items.push(plan('pln_p', 'do it'));
    persistState(state, dir);

    const records = readJournalRecords(dir);
    const stateMarkers = records.filter(r => (r.payload as { kind?: string })?.kind === 'store_marker');
    assert.equal(stateMarkers.length, 0, 'persist must not double-write the coarse store_marker');

    const dec = records.find(r => r.item_type === 'decision' && r.item_id === 'dec_p');
    assert.ok(dec, 'decision post-image present');
    assert.equal(dec!.action, 'create');
    assert.equal(dec!.entity_rev, 1);
    assert.equal((dec!.payload as { text?: string }).text, 'hello');
  });

  it('dual mode: update bumps entity_rev; delete emits a tombstone', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_u', 'v1'));
    persistState(state, dir);

    const upd = loadState(dir);
    upd.recent_decisions.find(d => d.id === 'dec_u')!.text = 'v2';
    persistState(upd, dir);

    const del = loadState(dir);
    del.recent_decisions = del.recent_decisions.filter(d => d.id !== 'dec_u');
    persistState(del, dir, { deleteMissing: true }); // real removal semantics (mutateState)

    const recs = readJournalRecords(dir).filter(r => r.item_id === 'dec_u');
    assert.deepEqual(recs.map(r => r.action), ['create', 'update', 'delete']);
    assert.deepEqual(recs.map(r => r.entity_rev), [1, 2, 3]);
  });

  it('materialize: journal replay reconstructs the live memory state', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_1', 'keep me'));
    state.recent_decisions.push(decision('dec_2', 'delete me later'));
    state.plan_items.push(plan('pln_1', 'a plan'));
    persistState(state, dir);

    const next = loadState(dir);
    next.recent_decisions = next.recent_decisions.filter(d => d.id !== 'dec_2');
    persistState(next, dir, { deleteMissing: true });

    const materialized: State = materializeMemoryStateFromJournal(dir);
    assert.deepEqual(materialized.recent_decisions.map(d => d.id), ['dec_1']);
    assert.equal(materialized.plan_items.length, 1);
    assert.equal(materialized.plan_items[0].id, 'pln_1');
  });

  it('verify: faithful dual-write yields zero drift; a tampered projection is detected', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_v', 'consistent'));
    state.known_traps.push(trap('trp_v', 'a trap'));
    persistState(state, dir);

    assert.deepEqual(verifyProjectionsAgainstJournal(dir), [], 'dual-write should be faithful');

    // Tamper the projection out-of-band → drift surfaces as a mismatch.
    const decFile = path.join(dir, '.brainclaw', 'memory', 'decisions', 'dec_v.json');
    const doc = JSON.parse(fs.readFileSync(decFile, 'utf-8'));
    doc.text = 'tampered out of band';
    fs.writeFileSync(decFile, JSON.stringify(doc, null, 2) + '\n', 'utf-8');

    const drift = verifyProjectionsAgainstJournal(dir);
    assert.equal(drift.length, 1);
    assert.deepEqual(drift[0], { item_type: 'decision', item_id: 'dec_v', kind: 'mismatch' });
  });

  // --- Regression coverage added by review (pln#543 step 3) ---

  it('trp#126 safety extends to empty AND unparseable on-disk files', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_e', 'present'));
    persistState(state, dir);

    const file = path.join(dir, '.brainclaw', 'memory', 'decisions', 'dec_e.json');

    // Empty existing file — canonical("") parses-fail → raw "" ≠ canonical desired → REWRITE.
    fs.writeFileSync(file, '', 'utf-8');
    resetPersistWriteStats();
    persistState(state, dir);
    assert.equal(readPersistWriteStats().written, 1, 'empty existing file must be rewritten');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).id, 'dec_e');

    // Binary/garbage non-JSON bytes — same protection.
    fs.writeFileSync(file, ' binary garbage{not json', 'utf-8');
    resetPersistWriteStats();
    persistState(state, dir);
    assert.equal(readPersistWriteStats().written, 1, 'unparseable existing file must be rewritten');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).id, 'dec_e');

    // Parseable JSON of a DIFFERENT shape — still a rewrite (canonical differs).
    fs.writeFileSync(file, '{"unrelated":"value"}\n', 'utf-8');
    resetPersistWriteStats();
    persistState(state, dir);
    assert.equal(readPersistWriteStats().written, 1, 'parseable-but-different existing file must be rewritten');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).id, 'dec_e');
  });

  it('entity_rev is strictly monotonic across delete→recreate (spec §2.1: never resets)', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_r', 'v1'));
    persistState(state, dir);

    const upd = loadState(dir);
    upd.recent_decisions.find(d => d.id === 'dec_r')!.text = 'v2';
    persistState(upd, dir);

    const del = loadState(dir);
    del.recent_decisions = del.recent_decisions.filter(d => d.id !== 'dec_r');
    persistState(del, dir, { deleteMissing: true });

    // Recreate the SAME id — rev MUST continue from where the tombstone left
    // it, NOT reset to 1 (spec: entity_rev is per-id-monotonic across the
    // entity's whole life, including delete→recreate cycles).
    const recreate = loadState(dir);
    recreate.recent_decisions.push(decision('dec_r', 'reborn'));
    persistState(recreate, dir);

    const recs = readJournalRecords(dir).filter(r => r.item_id === 'dec_r');
    assert.deepEqual(recs.map(r => r.action), ['create', 'update', 'delete', 'create']);
    assert.deepEqual(recs.map(r => r.entity_rev), [1, 2, 3, 4], 'rev must continue, never reset');
  });

  it('storeAction override (rollback) emits the broader verb but keeps entity-state class semantics', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_rb', 'pre-rollback'));
    persistState(state, dir, { eventAction: 'rollback' });

    const recs = readJournalRecords(dir).filter(r => r.item_id === 'dec_rb');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].action, 'rollback', 'storeAction overrides the default create/update verb');
    assert.ok(recs[0].payload, 'rollback is entity-state class → MUST carry the post-image');
    assert.equal(recs[0].entity_rev, 1);

    // Materialize still ingests rollback as a post-image (class drives replay,
    // not the verb) — so a rollback never produces phantom drift in verify.
    const mat = materializeMemoryStateFromJournal(dir);
    assert.equal(mat.recent_decisions.length, 1);
    assert.equal(mat.recent_decisions[0].id, 'dec_rb');
    assert.deepEqual(verifyProjectionsAgainstJournal(dir), []);
  });

  it('canonical compare is locale/key-order tolerant: re-persisting after schema-reorder writes 0 files', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const dir = tmpDir(); cleanup.push(dir);
    const state = emptyState();
    state.recent_decisions.push(decision('dec_o', 'ordered'));
    persistState(state, dir);

    // Hand-rewrite the file with EXPLICITLY-REORDERED keys (the byte stream
    // diverges from what serializeVersionedJson produced, but the semantic
    // content is identical). The dirty-tracking compare MUST treat this as
    // unchanged — otherwise every loadState→persistState round-trip would
    // rewrite the whole store on key-order alone, defeating the optimisation.
    const file = path.join(dir, '.brainclaw', 'memory', 'decisions', 'dec_o.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(original).reverse()) reordered[k] = original[k];
    fs.writeFileSync(file, JSON.stringify(reordered, null, 2) + '\n', 'utf-8');

    resetPersistWriteStats();
    persistState(loadState(dir), dir);
    assert.equal(readPersistWriteStats().written, 0, 'key-order-only divergence must NOT trigger a rewrite');
  });
});
