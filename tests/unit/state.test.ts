import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, loadState, mutateState, persistState } from '../../src/core/state.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-state-'));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('core/state', () => {
  it('persists canonical state and project markdown together', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const state = emptyState();
    state.recent_decisions.push({
      id: 'dec_test',
      short_label: 'dec#1',
      text: 'Persist through the unified mutation pipeline',
      created_at: '2026-01-01T00:00:00.000Z',
      author: 'tester',
      tags: [],
    });

    persistState(state, dir);

    const decisionPath = path.join(dir, '.brainclaw', 'memory', 'decisions', 'dec_test.json');
    const markdownPath = path.join(dir, '.brainclaw', 'project.md');
    const eventLogPath = path.join(dir, '.brainclaw', 'events.jsonl');

    assert.equal(fs.existsSync(decisionPath), true);
    assert.equal(fs.existsSync(markdownPath), true);
    assert.equal(fs.existsSync(eventLogPath), true);
    assert.match(fs.readFileSync(markdownPath, 'utf-8'), /Persist through the unified mutation pipeline/);
  });

  it('mutates state from a fresh snapshot under the store lock', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    mutateState((state) => {
      state.plan_items.push({
        id: 'pln_test',
        short_label: 'pln#1',
        text: 'Create plan atomically',
        type: 'fix',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        author: 'tester',
        status: 'todo',
        priority: 'high',
        tags: [],
        depends_on: [],
      });
    }, dir);

    mutateState((state) => {
      state.recent_decisions.push({
        id: 'dec_test_2',
        short_label: 'dec#2',
        text: 'Follow-up write keeps the plan file',
        created_at: '2026-01-01T00:01:00.000Z',
        author: 'tester',
        tags: [],
      });
    }, dir);

    const state = loadState(dir);
    assert.equal(state.plan_items.length, 1);
    assert.equal(state.plan_items[0]?.id, 'pln_test');
    assert.equal(state.recent_decisions.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '.brainclaw', 'coordination', 'plans', 'pln_test.json')), true);
  });
});
