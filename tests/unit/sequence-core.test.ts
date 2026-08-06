import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSequence, getActiveSequence, listSequences, loadSequence, updateSequence } from '../../src/core/sequence.js';
import { entityRecordDirs, entityRecordPaths } from '../../src/core/io.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/sequence', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-sequence-',
      projectId: 'prj_sequence_test',
      currentAgent: 'codex',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('creates, lists, and updates coordination sequences', () => {
    const created = createSequence({
      name: 'post-gpt4-review',
      description: 'Shared execution order after review.',
      status: 'active',
      owner: 'codex',
      author: 'codex',
      items: [
        { planId: 'PROJECT.md', rank: 1, lane: 'vision' },
        { planId: 'constraint-categorization', rank: 2, lane: 'export-foundation' },
        { planId: 'context-metrics', rank: 3, lane: 'hooks' },
        {
          planId: 'export-restructure',
          rank: 4,
          lane: 'export-foundation',
          hard_after: ['PROJECT.md', 'constraint-categorization'],
        },
        {
          planId: 'tier-reclassification',
          rank: 5,
          lane: 'export-foundation',
          soft_after: ['export-restructure'],
        },
      ],
      tags: ['sequence'],
    }, workspace.dir);

    const listed = listSequences(workspace.dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].items[0].planId, 'PROJECT.md');
    assert.deepEqual(listed[0].items[3].hard_after, ['PROJECT.md', 'constraint-categorization']);
    assert.deepEqual(listed[0].items[4].soft_after, ['export-restructure']);
    assert.equal(getActiveSequence(workspace.dir)?.id, created.id);

    const updated = updateSequence({
      id: created.id,
      status: 'archived',
      owner: 'claude-code',
    }, workspace.dir);

    assert.equal(updated.status, 'archived');
    assert.equal(updated.owner, 'claude-code');
    assert.equal(updated.items.length, 5);
    assert.equal(getActiveSequence(workspace.dir), undefined);
  });

  it('rejects duplicate ranks', () => {
    assert.throws(() => createSequence({
      name: 'bad-sequence',
      author: 'codex',
      items: [
        { planId: 'a', rank: 1 },
        { planId: 'b', rank: 1 },
      ],
    }, workspace.dir), /Duplicate sequence rank/);
  });

  it('persists optional stepId on sequence items', () => {
    const created = createSequence({
      name: 'step-aware-sequence',
      author: 'codex',
      status: 'active',
      items: [
        { planId: 'pln_auth', stepId: 'stp_1', rank: 1, lane: 'auth' },
      ],
    }, workspace.dir);

    const loaded = listSequences(workspace.dir).find((sequence) => sequence.id === created.id);
    assert.ok(loaded);
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].planId, 'pln_auth');
    assert.equal(loaded.items[0].stepId, 'stp_1');
  });
});

/**
 * pln#649 — the sequence readers converge both record layouts.
 *
 * FIXED AT THE LIST LAYER, deliberately. `loadSequence` resolves by id OR short_label and
 * `getActiveSequence` needs the whole set, so both are list-mediated: porting a by-id
 * loader to `entityRecordPaths` (the mechanical instinct) would build a filesystem path
 * from a short_label and could not work for either caller. That distinction came from a
 * Fable audit and is the reason this file, not a by-id pin, is where it belongs.
 *
 * Exposure today is nil — sequences postdate the partitioned layout — so these pins
 * MANUFACTURE the legacy state. Consistency with the sibling entities, not a field fix.
 */
describe('core/sequence — both record layouts (pln#649)', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace({ prefix: 'bclaw-sequence-layout-', projectId: 'prj_sequence_layout', currentAgent: 'codex' });
  });

  afterEach(() => { ws.cleanup(); });

  /** Move a record into the pre-migration flat layout, leaving the canonical dir populated. */
  function demote(id: string): void {
    const [canonical, legacy] = entityRecordDirs('sequences', ws.dir);
    fs.mkdirSync(legacy, { recursive: true });
    fs.renameSync(path.join(canonical, `${id}.json`), path.join(legacy, `${id}.json`));
  }

  it('lists a legacy record, and finds it by id AND by short_label, and as the active one', () => {
    const keep = createSequence({ name: 'canonical companion', author: 'codex', items: [] }, ws.dir);
    const moved = createSequence({ name: 'demoted lane set', author: 'codex', items: [] }, ws.dir);
    updateSequence({ id: moved.id, status: 'active' }, ws.dir);
    demote(moved.id);

    const ids = listSequences(ws.dir).map((s) => s.id);
    assert.ok(ids.includes(moved.id), `a legacy sequence must be listed — got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(keep.id), 'the canonical one must still be listed');
    assert.equal(new Set(ids).size, ids.length, 'no duplicates across layouts');

    // The two list-mediated readers, which a by-id fix could not have covered.
    assert.equal(loadSequence(moved.id, ws.dir).id, moved.id, 'by id');
    if (moved.shortLabel) {
      assert.equal(loadSequence(moved.shortLabel, ws.dir).id, moved.id, 'by short_label — the reason this is a LIST fix');
    }
    assert.equal(getActiveSequence(ws.dir)?.id, moved.id, 'and the active-sequence lookup');
  });

  it('saving a demoted sequence converges it instead of leaving a stale twin', () => {
    const moved = createSequence({ name: 'to converge', author: 'codex', items: [] }, ws.dir);
    demote(moved.id);
    updateSequence({ id: moved.id, status: 'active' }, ws.dir);

    const present = entityRecordPaths('sequences', moved.id, ws.dir).filter((p) => fs.existsSync(p));
    assert.equal(present.length, 1, `exactly one copy must survive — got ${JSON.stringify(present)}`);
    assert.match(present[0], /coordination/, 'the survivor must be canonical');
    assert.equal(getActiveSequence(ws.dir)?.id, moved.id, 'and the converged record is the live one');
  });
});
