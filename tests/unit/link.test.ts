import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  addCrossProjectLink,
  removeCrossProjectLink,
  resolveCrossProjectLinks,
  resolveCrossProjectTarget,
} from '../../src/core/cross-project.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function tmpProject(name: string, projectId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bclaw-link-${name}-`));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig(name, { projectId }), dir);
  return dir;
}

describe('core/cross-project — link CRUD helpers', () => {
  let workspace: TestWorkspace;
  let peerA: string;
  let peerB: string;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-link-main-', projectId: 'prj_link_main' });
    peerA = tmpProject('peer-a', 'prj_peer_a');
    peerB = tmpProject('peer-b', 'prj_peer_b');
  });

  afterEach(() => {
    workspace.cleanup();
    fs.rmSync(peerA, { recursive: true, force: true });
    fs.rmSync(peerB, { recursive: true, force: true });
  });

  describe('addCrossProjectLink', () => {
    it('adds a subscriber link by default and derives the name from the linked project_name', () => {
      const link = addCrossProjectLink({ path: peerA, cwd: workspace.dir });
      assert.equal(link.role, 'subscriber');
      assert.equal(link.name, 'peer-a');
      assert.equal(link.path, peerA);

      const links = resolveCrossProjectLinks(workspace.dir);
      assert.equal(links.length, 1);
      assert.equal(links[0].available, true);
    });

    it('supports an explicit name and role override', () => {
      const link = addCrossProjectLink({
        path: peerA,
        name: 'alpha',
        role: 'publisher',
        cwd: workspace.dir,
      });
      assert.equal(link.name, 'alpha');
      assert.equal(link.role, 'publisher');
    });

    it('persists optional channels filter on the stored entry', () => {
      const link = addCrossProjectLink({
        path: peerA,
        role: 'publisher',
        channels: ['candidate', 'handoff'],
        cwd: workspace.dir,
      });
      assert.deepEqual(link.channels, ['candidate', 'handoff']);

      const links = resolveCrossProjectLinks(workspace.dir);
      assert.deepEqual(links[0].channels, ['candidate', 'handoff']);
    });

    it('refuses to add a duplicate link by name without force', () => {
      addCrossProjectLink({ path: peerA, cwd: workspace.dir });
      assert.throws(
        () => addCrossProjectLink({ path: peerA, cwd: workspace.dir }),
        /already exists/i,
      );
    });

    it('replaces an existing link when force=true is passed', () => {
      addCrossProjectLink({ path: peerA, cwd: workspace.dir });
      const replaced = addCrossProjectLink({
        path: peerA,
        role: 'publisher',
        force: true,
        cwd: workspace.dir,
      });
      assert.equal(replaced.role, 'publisher');

      const links = resolveCrossProjectLinks(workspace.dir);
      assert.equal(links.length, 1, 'force replace must not duplicate the entry');
      assert.equal(links[0].role, 'publisher');
    });

    it('rejects a path that does not exist', () => {
      assert.throws(
        () => addCrossProjectLink({ path: path.join(os.tmpdir(), 'definitely-not-here-bclaw-test'), cwd: workspace.dir }),
        /does not exist/i,
      );
    });

    it('rejects a path that exists but is not brainclaw-initialised', () => {
      const blank = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-link-blank-'));
      try {
        assert.throws(
          () => addCrossProjectLink({ path: blank, cwd: workspace.dir }),
          /not brainclaw-initialised/i,
        );
      } finally {
        fs.rmSync(blank, { recursive: true, force: true });
      }
    });
  });

  describe('removeCrossProjectLink', () => {
    it('removes by name', () => {
      addCrossProjectLink({ path: peerA, cwd: workspace.dir });
      const removed = removeCrossProjectLink('peer-a', workspace.dir);
      assert.equal(removed.name, 'peer-a');

      const links = resolveCrossProjectLinks(workspace.dir);
      assert.equal(links.length, 0);
    });

    it('removes by exact path', () => {
      addCrossProjectLink({ path: peerA, cwd: workspace.dir });
      removeCrossProjectLink(peerA, workspace.dir);
      assert.equal(resolveCrossProjectLinks(workspace.dir).length, 0);
    });

    it('removes by basename when stored path is absolute', () => {
      addCrossProjectLink({ path: peerA, cwd: workspace.dir });
      removeCrossProjectLink(path.basename(peerA), workspace.dir);
      assert.equal(resolveCrossProjectLinks(workspace.dir).length, 0);
    });

    it('throws when no matching link exists', () => {
      assert.throws(
        () => removeCrossProjectLink('ghost', workspace.dir),
        /no cross_project_link found matching/i,
      );
    });

    it('removes only the targeted link, leaving other entries intact', () => {
      addCrossProjectLink({ path: peerA, cwd: workspace.dir });
      addCrossProjectLink({ path: peerB, cwd: workspace.dir });
      removeCrossProjectLink('peer-a', workspace.dir);

      const links = resolveCrossProjectLinks(workspace.dir);
      assert.equal(links.length, 1);
      assert.equal(links[0].name, 'peer-b');
    });
  });

  describe('round-trip with resolveCrossProjectTarget', () => {
    it('a link added via addCrossProjectLink is resolvable by resolveCrossProjectTarget', () => {
      addCrossProjectLink({
        path: peerA,
        name: 'alpha',
        role: 'publisher',
        cwd: workspace.dir,
      });
      const resolved = resolveCrossProjectTarget('alpha', workspace.dir);
      assert.equal(resolved.role, 'publisher');
      assert.equal(resolved.absolutePath, peerA);
    });
  });

  describe('config.yaml shape', () => {
    it('writes the link through the config schema (no extra fields)', () => {
      addCrossProjectLink({
        path: peerA,
        name: 'alpha',
        role: 'publisher',
        channels: ['candidate'],
        cwd: workspace.dir,
      });
      const cfg = loadConfig(workspace.dir);
      assert.equal(cfg.cross_project_links?.length, 1);
      const stored = cfg.cross_project_links?.[0];
      assert.deepEqual(stored, {
        path: peerA,
        name: 'alpha',
        role: 'publisher',
        channels: ['candidate'],
      });
    });
  });
});
