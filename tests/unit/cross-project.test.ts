import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveCrossProjectLinks, detectCrossProjectCycles, loadCrossProjectState, resolveCrossProjectTarget } from '../../src/core/cross-project.js';
import { saveState } from '../../src/core/state.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { State } from '../../src/core/schema.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function initProject(dir: string): void {
  const fakeHome = path.join(dir, '.fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  spawnSync(NODE, [CLI_PATH, 'init', '-y', '--no-analyze-repo'], {
    cwd: dir, encoding: 'utf-8', timeout: 10000,
    env: { ...process.env, USERNAME: 'testuser', USER: 'testuser', HOME: fakeHome, USERPROFILE: fakeHome },
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-xp-'));
}

const BASE_STATE: State = {
  version: 1, write_version: 1,
  active_constraints: [], recent_decisions: [], known_traps: [],
  open_handoffs: [], plan_items: [],
};

describe('cross-project', () => {
  let workspace: TestWorkspace;
  let linkedDir: string;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-xp-main-', projectId: 'prj_xp_main', currentAgent: 'copilot' });
    linkedDir = tmpDir();
    initProject(linkedDir);
  });

  afterEach(() => {
    workspace.cleanup();
    fs.rmSync(linkedDir, { recursive: true, force: true });
  });

  it('returns empty array when no cross_project_links configured', () => {
    const links = resolveCrossProjectLinks(workspace.dir);
    assert.deepEqual(links, []);
  });

  it('resolves a valid cross_project_link as available', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, role: 'subscriber' }];
    saveConfig(config, workspace.dir);

    const links = resolveCrossProjectLinks(workspace.dir);
    assert.equal(links.length, 1);
    assert.equal(links[0].available, true);
    assert.equal(links[0].absolutePath, linkedDir);
  });

  it('marks a link as unavailable when path does not exist', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: '/nonexistent/project', role: 'subscriber' }];
    saveConfig(config, workspace.dir);

    const links = resolveCrossProjectLinks(workspace.dir);
    assert.equal(links[0].available, false);
  });

  it('loads state from a linked project', () => {
    saveState({
      ...BASE_STATE,
      recent_decisions: [{
        id: 'dec_xp01', text: 'API uses REST not GraphQL',
        created_at: new Date().toISOString(), author: 'copilot',
        author_id: 'agt_test', project_id: 'prj_xp_linked', tags: ['api'],
      }],
    }, linkedDir);

    const state = loadCrossProjectState(linkedDir);
    assert.equal(state.recent_decisions.length, 1);
    assert.equal(state.recent_decisions[0].id, 'dec_xp01');
  });

  it('resolveCrossProjectTarget finds link by project name', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, name: 'brainclaw-website', role: 'publisher' }];
    saveConfig(config, workspace.dir);

    const link = resolveCrossProjectTarget('brainclaw-website', workspace.dir);
    assert.equal(link.projectName, 'brainclaw-website');
    assert.equal(link.role, 'publisher');
  });

  it('resolveCrossProjectTarget throws when link not found', () => {
    assert.throws(
      () => resolveCrossProjectTarget('unknown-project', workspace.dir),
      /No cross_project_link found/,
    );
  });

  it('detectCrossProjectCycles returns empty array when no cycles', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, role: 'subscriber' }];
    saveConfig(config, workspace.dir);

    const cycles = detectCrossProjectCycles(workspace.dir);
    assert.deepEqual(cycles, []);
  });
});
