/**
 * pln#567 (decision A+D) — `brainclaw migrate --enable-journal` turns the event
 * journal on for an EXISTING store and backfills it via genesis.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { runMigrate } from '../../src/commands/migrate.js';
import { loadConfig } from '../../src/core/config.js';
import { hasGenesis, runGenesisMigration } from '../../src/core/events/genesis.js';
import { emptyState, persistState } from '../../src/core/state.js';
import { DecisionSchema } from '../../src/core/schema.js';

let ws: TestWorkspace | undefined;
let savedMode: string | undefined;

afterEach(() => {
  if (savedMode === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE; else process.env.BRAINCLAW_JOURNAL_MODE = savedMode;
  ws?.cleanup();
  ws = undefined;
});

function seed(dir: string): void {
  savedMode = process.env.BRAINCLAW_JOURNAL_MODE;
  delete process.env.BRAINCLAW_JOURNAL_MODE; // baseline: journal off, projections only
  const state = emptyState();
  state.recent_decisions.push(
    DecisionSchema.parse({ id: 'dec_1', short_label: 'dec#1', text: 'a', created_at: '2026-01-01T00:00:00.000Z', author: 'tester', tags: [] }),
    DecisionSchema.parse({ id: 'dec_2', short_label: 'dec#2', text: 'b', created_at: '2026-01-01T00:00:00.000Z', author: 'tester', tags: [] }),
  );
  persistState(state, dir);
}

describe('migrate --enable-journal (pln#567)', () => {
  it('sets store.journal.mode=dual and backfills existing entities via genesis', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-migrate-journal-', projectId: 'prj_mj', currentAgent: 'tester' });
    const dir = ws.dir;
    assert.equal(loadConfig(dir).store?.journal?.mode, undefined, 'baseline: no journal mode set');
    seed(dir);
    assert.equal(hasGenesis(dir), false, 'no journal before migrate');

    runMigrate({ enableJournal: true, cwd: dir });

    assert.equal(loadConfig(dir).store?.journal?.mode, 'dual', 'mode flipped to dual');
    assert.equal(hasGenesis(dir), true, 'journal seeded with a genesis note');
  });

  it('is idempotent — a second run keeps dual and does not re-seed', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-migrate-journal-', projectId: 'prj_mj2', currentAgent: 'tester' });
    const dir = ws.dir;
    seed(dir);
    runMigrate({ enableJournal: true, cwd: dir });
    // Second run: genesis already present → no-op (no throw, mode stays dual).
    assert.doesNotThrow(() => runMigrate({ enableJournal: true, cwd: dir }));
    assert.equal(loadConfig(dir).store?.journal?.mode, 'dual');
    assert.equal(runGenesisMigration({ cwd: dir }).status, 'already_present');
  });

  it('dry-run writes nothing (no mode change, no journal)', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-migrate-journal-', projectId: 'prj_mj3', currentAgent: 'tester' });
    const dir = ws.dir;
    seed(dir);
    runMigrate({ enableJournal: true, dryRun: true, cwd: dir });
    assert.equal(loadConfig(dir).store?.journal?.mode, undefined, 'dry-run did not change config');
    assert.equal(hasGenesis(dir), false, 'dry-run did not seed the journal');
  });
});
