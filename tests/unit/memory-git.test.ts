import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { initMemoryRepo, hasMemoryRepo, commitMemoryChange, getMemoryLog, rollbackMemory, getMemoryHead } from '../../src/core/memory-git.js';
import { saveState, loadState, emptyState } from '../../src/core/state.js';

describe('memory-git', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-memgit-',
      projectId: 'prj_memgit_test',
      currentAgent: 'testuser',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('initializes a git repo in .brainclaw/', () => {
    assert.equal(hasMemoryRepo(workspace.dir), false);
    const created = initMemoryRepo(workspace.dir);
    assert.equal(created, true);
    assert.equal(hasMemoryRepo(workspace.dir), true);
  });

  it('is idempotent — second init returns false', () => {
    initMemoryRepo(workspace.dir);
    assert.equal(initMemoryRepo(workspace.dir), false);
  });

  it('auto-commits state changes', () => {
    initMemoryRepo(workspace.dir);

    const state = emptyState();
    state.recent_decisions.push({
      id: 'dec_gittest',
      text: 'Git test decision',
      created_at: new Date().toISOString(),
      author: 'testuser',
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_memgit_test',
      tags: ['test'],
    } as any);
    saveState(state, workspace.dir);

    const log = getMemoryLog(10, workspace.dir);
    assert.ok(log.length >= 2); // initial + state update
    assert.ok(log[0].includes('state update'));
  });

  it('returns HEAD hash', () => {
    initMemoryRepo(workspace.dir);
    const head = getMemoryHead(workspace.dir);
    assert.ok(head);
    assert.match(head, /^[a-f0-9]+$/);
  });

  it('rollback removes files added after target ref', () => {
    initMemoryRepo(workspace.dir);
    const initialHead = getMemoryHead(workspace.dir)!;

    // Add a decision
    const state = emptyState();
    state.recent_decisions.push({
      id: 'dec_rollback',
      text: 'Will be rolled back',
      created_at: new Date().toISOString(),
      author: 'testuser',
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_memgit_test',
      tags: [],
    } as any);
    saveState(state, workspace.dir);

    // Verify decision exists
    const afterState = loadState(workspace.dir);
    assert.equal(afterState.recent_decisions.length, 1);

    // Rollback
    const success = rollbackMemory(initialHead, workspace.dir);
    assert.equal(success, true);

    // Decision should be gone
    const rolledBack = loadState(workspace.dir);
    assert.equal(rolledBack.recent_decisions.length, 0);
  });

  it('no-ops when no memory repo exists', () => {
    assert.equal(commitMemoryChange('test', workspace.dir), false);
    assert.equal(rollbackMemory('abc', workspace.dir), false);
    assert.deepEqual(getMemoryLog(10, workspace.dir), []);
    assert.equal(getMemoryHead(workspace.dir), undefined);
  });
});
