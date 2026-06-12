import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { resolveJournalMode } from '../../src/core/events/journal.js';

describe('journal mode resolution: env override > config.yaml > off (pln#543)', () => {
  let ws: TestWorkspace;
  let savedEnv: string | undefined;

  beforeEach(() => {
    ws = createTestWorkspace({ prefix: 'bclaw-jmode-', projectId: 'prj_jmode', currentAgent: 'tester' });
    savedEnv = process.env.BRAINCLAW_JOURNAL_MODE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE; else process.env.BRAINCLAW_JOURNAL_MODE = savedEnv;
    ws.cleanup();
  });

  it('defaults to off when neither env nor config set it (fresh store)', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    assert.equal(resolveJournalMode(ws.dir), 'off');
  });

  it('config.yaml store.journal.mode=dual activates without any env var', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    ws.updateConfig(c => { c.store = { journal: { mode: 'dual' } }; });
    assert.equal(resolveJournalMode(ws.dir), 'dual');
  });

  it('env var overrides config (env wins both directions)', () => {
    ws.updateConfig(c => { c.store = { journal: { mode: 'dual' } }; });
    process.env.BRAINCLAW_JOURNAL_MODE = 'off';
    assert.equal(resolveJournalMode(ws.dir), 'off', 'env=off beats config=dual');

    ws.updateConfig(c => { c.store = { journal: { mode: 'off' } }; });
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    assert.equal(resolveJournalMode(ws.dir), 'dual', 'env=dual beats config=off');
  });

  it('primary/registryPrimary degrade to dual until the cutover (step 5)', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    ws.updateConfig(c => { c.store = { journal: { mode: 'primary' } }; });
    assert.equal(resolveJournalMode(ws.dir), 'dual');
  });

  it('unreadable/absent config never throws — resolves off', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    // A cwd with no .brainclaw store at all.
    assert.equal(resolveJournalMode('/no/such/brainclaw/store/path'), 'off');
  });
});
