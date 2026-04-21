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

  it('preserves schema-invalid plan files across mutateState instead of silently deleting them', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    // Seed one valid plan so the directory exists and the sync loop runs.
    mutateState((state) => {
      state.plan_items.push({
        id: 'pln_valid',
        short_label: 'pln#1',
        text: 'Valid plan',
        type: 'fix',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        author: 'tester',
        status: 'todo',
        priority: 'medium',
        tags: [],
        depends_on: [],
      });
    }, dir);

    // Drop an invalid plan file (missing required `author`) — this is what
    // bclaw_create would do before fix pln_5f44426c.
    const plansDir = path.join(dir, '.brainclaw', 'coordination', 'plans');
    const invalidPath = path.join(plansDir, 'pln_orphan.json');
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({
        schema_version: 2,
        id: 'pln_orphan',
        text: 'Missing author, tags, status — invalid',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );

    assert.equal(fs.existsSync(invalidPath), true, 'invalid plan file should start on disk');

    // Trigger a mutation that forces writeStateDirectories.
    mutateState((state) => {
      state.recent_decisions.push({
        id: 'dec_probe',
        short_label: 'dec#1',
        text: 'Probe mutation',
        created_at: '2026-01-01T00:02:00.000Z',
        author: 'tester',
        tags: [],
      });
    }, dir);

    // Before the fix, syncDirectory would unlink pln_orphan.json because it is
    // not in the loaded state. After the fix, the unparseable file is preserved.
    assert.equal(
      fs.existsSync(invalidPath),
      true,
      'invalid plan file must NOT be silently deleted by syncDirectory',
    );

    // The valid plan should still be there.
    assert.equal(
      fs.existsSync(path.join(plansDir, 'pln_valid.json')),
      true,
      'valid plan file should remain on disk',
    );
  });

  it('preserves schema-invalid legacy plan files during legacy cleanup', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const legacyPlansDir = path.join(dir, '.brainclaw', 'plans');
    fs.mkdirSync(legacyPlansDir, { recursive: true });
    const invalidLegacyPath = path.join(legacyPlansDir, 'pln_legacy_orphan.json');
    fs.writeFileSync(
      invalidLegacyPath,
      JSON.stringify({
        schema_version: 2,
        id: 'pln_legacy_orphan',
        text: 'Legacy JSON-valid plan missing required author/status fields',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );

    mutateState((state) => {
      state.recent_decisions.push({
        id: 'dec_probe',
        short_label: 'dec#1',
        text: 'Trigger write with empty canonical plans dir',
        created_at: '2026-01-01T00:02:00.000Z',
        author: 'tester',
        tags: [],
      });
    }, dir);

    assert.equal(
      fs.existsSync(invalidLegacyPath),
      true,
      'schema-invalid legacy plan file must not be deleted by legacy cleanup',
    );
  });
});
