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

  it('rollback preserves durable audit, archive, backup, and compaction artifacts', () => {
    initMemoryRepo(workspace.dir);
    const initialHead = getMemoryHead(workspace.dir)!;

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

    const auditPath = path.join(workspace.dir, '.brainclaw', 'audit.log');
    fs.writeFileSync(auditPath, '{"action":"update"}\n', 'utf-8');

    const archivePath = path.join(workspace.dir, '.brainclaw', 'coordination', 'plans', 'archive.jsonl');
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, '{"id":"pln_archived"}\n', 'utf-8');

    const backupPath = path.join(workspace.dir, '.brainclaw', 'gc-backups', 'compact-test.jsonl');
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, '{"id":"backup"}\n', 'utf-8');

    const compactedPath = path.join(workspace.dir, '.brainclaw', 'memory', 'decisions', 'compacted.jsonl');
    fs.mkdirSync(path.dirname(compactedPath), { recursive: true });
    fs.writeFileSync(compactedPath, '{"id":"dec_old"}\n', 'utf-8');

    assert.equal(commitMemoryChange('durable artifacts', workspace.dir), true);

    const success = rollbackMemory(initialHead, workspace.dir);
    assert.equal(success, true);

    const rolledBack = loadState(workspace.dir);
    assert.equal(rolledBack.recent_decisions.length, 0);
    assert.equal(fs.readFileSync(auditPath, 'utf-8'), '{"action":"update"}\n');
    assert.equal(fs.readFileSync(archivePath, 'utf-8'), '{"id":"pln_archived"}\n');
    assert.equal(fs.readFileSync(backupPath, 'utf-8'), '{"id":"backup"}\n');
    assert.equal(fs.readFileSync(compactedPath, 'utf-8'), '{"id":"dec_old"}\n');
  });

  it('rollback only affects the current project memory store', () => {
    initMemoryRepo(workspace.dir);
    const initialHead = getMemoryHead(workspace.dir)!;

    const state = emptyState();
    state.recent_decisions.push({
      id: 'dec_local',
      text: 'Current project decision',
      created_at: new Date().toISOString(),
      author: 'testuser',
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_memgit_test',
      tags: [],
    } as any);
    saveState(state, workspace.dir);

    const siblingDir = fs.mkdtempSync(path.join(path.dirname(workspace.dir), 'bclaw-memgit-sibling-'));
    try {
      fs.mkdirSync(path.join(siblingDir, '.brainclaw', 'memory', 'decisions'), { recursive: true });
      const siblingDecisionPath = path.join(siblingDir, '.brainclaw', 'memory', 'decisions', 'dec_sibling.json');
      fs.writeFileSync(
        siblingDecisionPath,
        JSON.stringify({
          id: 'dec_sibling',
          text: 'Sibling project decision',
          created_at: new Date().toISOString(),
          author: 'other-user',
          tags: [],
        }),
        'utf-8',
      );

      const success = rollbackMemory(initialHead, workspace.dir);
      assert.equal(success, true);

      const rolledBack = loadState(workspace.dir);
      assert.equal(rolledBack.recent_decisions.length, 0);
      assert.equal(fs.existsSync(siblingDecisionPath), true);
      const sibling = JSON.parse(fs.readFileSync(siblingDecisionPath, 'utf-8')) as { id: string; text: string };
      assert.equal(sibling.id, 'dec_sibling');
      assert.equal(sibling.text, 'Sibling project decision');
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  it('no-ops when no memory repo exists', () => {
    assert.equal(commitMemoryChange('test', workspace.dir), false);
    assert.equal(rollbackMemory('abc', workspace.dir), false);
    assert.deepEqual(getMemoryLog(10, workspace.dir), []);
    assert.equal(getMemoryHead(workspace.dir), undefined);
  });
});
