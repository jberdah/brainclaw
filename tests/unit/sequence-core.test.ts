import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSequence, getActiveSequence, listSequences, updateSequence } from '../../src/core/sequence.js';
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
});
