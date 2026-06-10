/**
 * Composite bootstrap-need assessment (pln#557 step 3) — replaces the
 * one-bit PROJECT.md stat() behind bootstrap_recommended. Kills the false
 * positive (from-scratch bootstrap recommended on a rich store) and the
 * eternal false negative (fossil PROJECT.md never reflagged).
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assessBootstrapNeed } from '../../src/core/setup-flow.js';
import { memoryDir } from '../../src/core/io.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function writeEventLog(dir: string, bytes: number, mtime?: Date): string {
  const line = JSON.stringify({ ts: new Date().toISOString(), agent: 'alice', action: 'update', item_type: 'claim' }) + '\n';
  const repeats = Math.ceil(bytes / line.length);
  const logPath = path.join(memoryDir(dir), 'events.jsonl');
  fs.writeFileSync(logPath, line.repeat(repeats), 'utf-8');
  if (mtime) fs.utimesSync(logPath, mtime, mtime);
  return logPath;
}

describe('assessBootstrapNeed (composite bootstrap_recommended)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-bneed-', projectId: 'prj_bneed_test' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('no PROJECT.md + sparse store → bootstrap (legacy true case)', () => {
    const a = assessBootstrapNeed(workspace.dir);
    assert.equal(a.verdict, 'bootstrap');
    assert.equal(a.project_md_present, false);
    assert.notEqual(a.store_density, 'rich');
  });

  it('empty (0-byte) PROJECT.md counts as absent', () => {
    fs.writeFileSync(path.join(workspace.dir, 'PROJECT.md'), '', 'utf-8');
    const a = assessBootstrapNeed(workspace.dir);
    assert.equal(a.verdict, 'bootstrap');
    assert.equal(a.project_md_present, false);
  });

  it('no PROJECT.md + rich store → refresh, NOT from-scratch bootstrap', () => {
    writeEventLog(workspace.dir, 80 * 1024);
    const a = assessBootstrapNeed(workspace.dir);
    assert.equal(a.verdict, 'refresh');
    assert.equal(a.store_density, 'rich');
    assert.match(a.reasons[0], /regenerate from existing memory/);
  });

  it('fresh PROJECT.md + recent activity → none', () => {
    fs.writeFileSync(path.join(workspace.dir, 'PROJECT.md'), '# project\n', 'utf-8');
    writeEventLog(workspace.dir, 1024);
    const a = assessBootstrapNeed(workspace.dir);
    assert.equal(a.verdict, 'none');
    assert.equal(a.project_md_present, true);
  });

  it('fossil PROJECT.md (much older than recent store activity) → refresh', () => {
    const projectMd = path.join(workspace.dir, 'PROJECT.md');
    fs.writeFileSync(projectMd, '# project\n', 'utf-8');
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    fs.utimesSync(projectMd, sixtyDaysAgo, sixtyDaysAgo);
    writeEventLog(workspace.dir, 1024); // mtime = now

    const a = assessBootstrapNeed(workspace.dir);
    assert.equal(a.verdict, 'refresh');
    assert.equal(a.project_md_present, true);
    assert.match(a.reasons[0], /fossil/);
  });

  it('old PROJECT.md with NO recent activity stays none (no false refresh)', () => {
    const projectMd = path.join(workspace.dir, 'PROJECT.md');
    fs.writeFileSync(projectMd, '# project\n', 'utf-8');
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    fs.utimesSync(projectMd, sixtyDaysAgo, sixtyDaysAgo);
    // Event log equally old: the gap between PROJECT.md and activity is small.
    writeEventLog(workspace.dir, 1024, new Date(Date.now() - 59 * 86_400_000));

    const a = assessBootstrapNeed(workspace.dir);
    assert.equal(a.verdict, 'none');
  });
});
