import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPrune } from '../../src/commands/prune.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { loadState, saveState } from '../../src/core/state.js';
import { listRuntimeNotes, saveRuntimeNote } from '../../src/core/runtime.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function captureConsole(fn: () => void): string[] {
  const original = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return logs;
}

describe('prune command dry-run', () => {
  let workspace: TestWorkspace;
  let restoreCwd: () => void;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-prune-' });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd();
    workspace.cleanup();
  });

  it('previews expired constraints, claims, and notes without mutating them', () => {
    const state = loadState(workspace.dir);
    state.active_constraints.push({
      id: 'con_expired',
      text: 'Expired constraint',
      created_at: '2026-01-01T00:00:00.000Z',
      author: 'test',
      status: 'active',
      tags: [],
      expires_at: '2026-01-02T00:00:00.000Z',
    });
    saveState(state, workspace.dir);
    saveClaim({
      schema_version: 2,
      id: 'clm_expired',
      agent: 'codex',
      scope: 'src/old',
      description: 'expired',
      created_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
      expires_at: '2026-01-02T00:00:00.000Z',
    }, workspace.dir);
    saveRuntimeNote({
      id: 'rtn_expired',
      agent: 'codex',
      text: 'expired note',
      created_at: '2026-01-01T00:00:00.000Z',
      tags: [],
      visibility: 'shared',
      note_type: 'observation',
      expires_at: '2026-01-02T00:00:00.000Z',
    }, workspace.dir);
    const before = JSON.stringify(loadState(workspace.dir));

    const logs = captureConsole(() => runPrune({ expired: true, dryRun: true }));

    assert.ok(logs.some((line) => line.includes('Dry run: no files will be changed.')));
    assert.ok(logs.some((line) => line.includes('Would prune 1 expired constraints.')));
    assert.ok(logs.some((line) => line.includes('Would release 1 expired claims.')));
    assert.ok(logs.some((line) => line.includes('Would delete 1 expired runtime notes.')));
    assert.equal(JSON.stringify(loadState(workspace.dir)), before);
    assert.equal(loadClaim('clm_expired', workspace.dir).status, 'active');
    assert.ok(listRuntimeNotes(undefined, workspace.dir).some((note) => note.id === 'rtn_expired'));
    assert.equal(fs.existsSync(`${workspace.dir}/.brainclaw/audit.log`), false);
  });
});
