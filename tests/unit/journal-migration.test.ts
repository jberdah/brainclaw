import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, persistState } from '../../src/core/state.js';
import { DecisionSchema, PlanItemSchema, type Decision, type PlanItem } from '../../src/core/schema.js';
import { readJournalRecords, journalDir } from '../../src/core/events/journal.js';
import { verifyProjectionsAgainstJournal } from '../../src/core/events/materialize.js';
import { runGenesisMigration, rollbackJournal, hasGenesis } from '../../src/core/events/genesis.js';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-genesis-')); }
function decision(id: string, text: string): Decision {
  return DecisionSchema.parse({ id, short_label: id.replace('dec_', 'dec#'), text, created_at: '2026-01-01T00:00:00.000Z', author: 'tester', tags: [] });
}
function plan(id: string): PlanItem {
  return PlanItemSchema.parse({ id, short_label: id.replace('pln_', 'pln#'), text: 'p', type: 'feat', status: 'todo', priority: 'medium', created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', author: 'tester', tags: [] });
}

describe('journal genesis migration + rollback (pln#543 step 4)', () => {
  const cleanup: string[] = [];
  let savedMode: string | undefined;
  beforeEach(() => { savedMode = process.env.BRAINCLAW_JOURNAL_MODE; });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE; else process.env.BRAINCLAW_JOURNAL_MODE = savedMode;
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  function seedStore(dir: string) {
    // Seed projections with the journal OFF, so genesis is the only writer.
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    const state = emptyState();
    state.recent_decisions.push(decision('dec_1', 'a'), decision('dec_2', 'b'));
    state.plan_items.push(plan('pln_1'));
    persistState(state, dir);
  }

  it('genesis backfills every live memory entity at entity_rev 1, behind a genesis note', () => {
    const dir = tmpDir(); cleanup.push(dir);
    seedStore(dir);
    assert.equal(readJournalRecords(dir).length, 0, 'journal empty before genesis (flag was off)');

    const result = runGenesisMigration({ cwd: dir });
    assert.equal(result.status, 'migrated');
    assert.equal(result.backfilled, 3);
    assert.deepEqual(result.per_family, { constraint: 0, decision: 2, trap: 0, handoff: 0, plan: 1 });

    const recs = readJournalRecords(dir);
    const genesis = recs.find(r => (r.payload as { kind?: string })?.kind === 'genesis');
    assert.ok(genesis, 'genesis note present');
    assert.equal(genesis!.seq, result.genesis_seq);
    const backfills = recs.filter(r => r.action === 'backfill');
    assert.equal(backfills.length, 3);
    assert.ok(backfills.every(r => r.entity_rev === 1), 'every backfill at entity_rev 1');
    assert.ok(backfills.every(r => r.payload && r.item_id), 'backfill carries post-image + id');
  });

  it('genesis takes a mandatory projection backup (park-don\'t-delete)', () => {
    const dir = tmpDir(); cleanup.push(dir);
    seedStore(dir);
    const result = runGenesisMigration({ cwd: dir });
    assert.ok(result.backup_path && fs.existsSync(result.backup_path), 'backup dir exists');
    assert.ok(fs.existsSync(path.join(result.backup_path!, 'memory', 'decisions', 'dec_1.json')), 'projection copied into backup');
  });

  it('genesis is idempotent: refuses to re-seed without force, parks prior journal with force', () => {
    const dir = tmpDir(); cleanup.push(dir);
    seedStore(dir);
    runGenesisMigration({ cwd: dir });
    assert.equal(hasGenesis(dir), true);

    const again = runGenesisMigration({ cwd: dir });
    assert.equal(again.status, 'already_present');
    assert.equal(again.backfilled, 0);

    const forced = runGenesisMigration({ cwd: dir, force: true });
    assert.equal(forced.status, 'migrated');
    // After force, exactly one genesis note exists in the LIVE journal (prior parked).
    assert.equal(readJournalRecords(dir).filter(r => (r.payload as { kind?: string })?.kind === 'genesis').length, 1);
  });

  it('dry run plans without writing', () => {
    const dir = tmpDir(); cleanup.push(dir);
    seedStore(dir);
    const result = runGenesisMigration({ cwd: dir, dryRun: true });
    assert.equal(result.status, 'dry_run');
    assert.equal(result.backfilled, 3);
    assert.equal(readJournalRecords(dir).length, 0, 'nothing written on dry run');
  });

  it('post-genesis, the journal materializes to exactly the projection state (zero drift)', () => {
    const dir = tmpDir(); cleanup.push(dir);
    seedStore(dir);
    runGenesisMigration({ cwd: dir });
    assert.deepEqual(verifyProjectionsAgainstJournal(dir), [], 'genesis seed must match projections');
  });

  it('rollback parks the journal directory; projections untouched', () => {
    const dir = tmpDir(); cleanup.push(dir);
    seedStore(dir);
    runGenesisMigration({ cwd: dir });
    assert.equal(fs.existsSync(journalDir(dir)), true);

    const rb = rollbackJournal({ cwd: dir });
    assert.equal(rb.status, 'rolled_back');
    assert.equal(fs.existsSync(journalDir(dir)), false, 'journal parked');
    assert.ok(rb.parked_path && fs.existsSync(rb.parked_path), 'parked copy preserved (not deleted)');
    // Projections survive.
    assert.equal(fs.existsSync(path.join(dir, '.brainclaw', 'memory', 'decisions', 'dec_1.json')), true);

    assert.equal(rollbackJournal({ cwd: dir }).status, 'nothing_to_roll_back');
  });
});
