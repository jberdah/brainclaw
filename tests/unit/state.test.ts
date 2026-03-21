import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, persistState } from '../../src/core/state.js';

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
});
