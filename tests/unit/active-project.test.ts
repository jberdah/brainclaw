import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadActiveProject, saveActiveProject, clearActiveProject } from '../../src/core/active-project.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-active-project-'));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('core/active-project', () => {
  it('returns undefined when no active project file exists', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });

    assert.equal(loadActiveProject(dir), undefined);
  });

  it('saves and loads an active project', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });

    const project = {
      path: '/srv/workspace/apps/lodestar',
      name: 'lodestar',
      switched_at: '2026-03-24T10:00:00.000Z',
      switched_by: 'claude-code',
    };

    saveActiveProject(dir, project);
    const loaded = loadActiveProject(dir);

    assert.ok(loaded);
    assert.equal(loaded.path, project.path);
    assert.equal(loaded.name, project.name);
    assert.equal(loaded.switched_at, project.switched_at);
    assert.equal(loaded.switched_by, project.switched_by);
  });

  it('clears the active project', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });

    saveActiveProject(dir, {
      path: '/srv/workspace/apps/lodestar',
      switched_at: new Date().toISOString(),
    });

    assert.ok(loadActiveProject(dir));
    clearActiveProject(dir);
    assert.equal(loadActiveProject(dir), undefined);
  });

  it('returns undefined for malformed JSON', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(path.join(brainclawDir, 'active-project.json'), '{invalid}', 'utf-8');

    assert.equal(loadActiveProject(dir), undefined);
  });

  it('returns undefined when path field is missing', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(path.join(brainclawDir, 'active-project.json'), '{"name": "test"}', 'utf-8');

    assert.equal(loadActiveProject(dir), undefined);
  });
});
