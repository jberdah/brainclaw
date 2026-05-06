import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  EntityNotFoundError,
  createEntity,
  getEntity,
  listEntities,
  removeEntity,
  transitionEntity,
  updateEntity,
} from '../../src/core/entity-operations.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { ENTITY_REGISTRY } from '../../src/core/entity-registry.js';

function tmpProject(name: string, projectId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bclaw-xpl-${name}-`));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig(name, { projectId }), dir);
  return dir;
}

describe('canonical grammar — cross_project_link entity', () => {
  let workspace: TestWorkspace;
  let peerA: string;
  let peerB: string;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-xpl-grammar-', projectId: 'prj_xpl_grammar' });
    peerA = tmpProject('peer-a', 'prj_peer_a');
    peerB = tmpProject('peer-b', 'prj_peer_b');
  });

  afterEach(() => {
    workspace.cleanup();
    fs.rmSync(peerA, { recursive: true, force: true });
    fs.rmSync(peerB, { recursive: true, force: true });
  });

  it('cross_project_link is registered in ENTITY_REGISTRY as stateless', () => {
    const spec = ENTITY_REGISTRY.cross_project_link;
    assert.ok(spec, 'cross_project_link spec must exist');
    assert.equal(spec.name, 'cross_project_link');
    assert.equal(spec.shortLabelPrefix, 'xpl');
    assert.equal(spec.statusField, undefined, 'cross_project_link must be stateless');
    assert.deepEqual(spec.transitions, {});
    assert.deepEqual(spec.terminal, []);
  });

  it('create → list round-trip', () => {
    const created = createEntity('cross_project_link', {
      path: peerA,
      role: 'publisher',
    }, workspace.dir);
    assert.equal(created.entity, 'cross_project_link');
    assert.equal(created.id, 'peer-a');

    const listed = listEntities('cross_project_link', workspace.dir);
    assert.equal(listed.total, 1);
    assert.equal(listed.items.length, 1);
  });

  it('get resolves by name, path, and basename', () => {
    createEntity('cross_project_link', { path: peerA, name: 'alpha' }, workspace.dir);

    const byName = getEntity('cross_project_link', 'alpha', workspace.dir) as { path: string };
    assert.equal(byName.path, peerA);

    const byPath = getEntity('cross_project_link', peerA, workspace.dir) as { name: string };
    assert.equal(byPath.name, 'alpha');

    const byBasename = getEntity('cross_project_link', path.basename(peerA), workspace.dir) as { name: string };
    assert.equal(byBasename.name, 'alpha');
  });

  it('get throws EntityNotFoundError when nothing matches', () => {
    assert.throws(
      () => getEntity('cross_project_link', 'ghost', workspace.dir),
      EntityNotFoundError,
    );
  });

  it('update patches role in-place without duplicating the entry', () => {
    createEntity('cross_project_link', { path: peerA, role: 'subscriber' }, workspace.dir);
    updateEntity('cross_project_link', 'peer-a', { role: 'publisher' }, workspace.dir);

    const fetched = getEntity('cross_project_link', 'peer-a', workspace.dir) as { role: string };
    assert.equal(fetched.role, 'publisher');

    const listed = listEntities('cross_project_link', workspace.dir);
    assert.equal(listed.total, 1, 'update must not duplicate the entry');
  });

  it('update can patch channels', () => {
    createEntity('cross_project_link', { path: peerA, role: 'publisher' }, workspace.dir);
    updateEntity('cross_project_link', 'peer-a', { channels: ['handoff'] }, workspace.dir);

    const fetched = getEntity('cross_project_link', 'peer-a', workspace.dir) as { channels?: string[] };
    assert.deepEqual(fetched.channels, ['handoff']);
  });

  it('update rejects non-updatable fields like path', () => {
    createEntity('cross_project_link', { path: peerA }, workspace.dir);
    assert.throws(
      () => updateEntity('cross_project_link', 'peer-a', { path: peerB }, workspace.dir),
      /not updatable on cross_project_link/i,
    );
  });

  it('remove drops the entry from config', () => {
    createEntity('cross_project_link', { path: peerA }, workspace.dir);
    const removed = removeEntity('cross_project_link', 'peer-a', workspace.dir);
    assert.equal(removed.id, 'peer-a');
    assert.equal(removed.purged, true);

    const listed = listEntities('cross_project_link', workspace.dir);
    assert.equal(listed.total, 0);
  });

  it('multiple links coexist and are addressed independently', () => {
    createEntity('cross_project_link', { path: peerA, role: 'subscriber' }, workspace.dir);
    createEntity('cross_project_link', { path: peerB, role: 'publisher' }, workspace.dir);

    const listed = listEntities('cross_project_link', workspace.dir);
    assert.equal(listed.total, 2);

    removeEntity('cross_project_link', 'peer-a', workspace.dir);
    const after = listEntities('cross_project_link', workspace.dir) as { items: Array<{ name?: string }> };
    assert.equal(after.items.length, 1);
    assert.equal(after.items[0].name, 'peer-b');
  });

  it('transition rejects cross_project_link as a stateless entity', () => {
    createEntity('cross_project_link', { path: peerA }, workspace.dir);
    assert.throws(
      () => transitionEntity('cross_project_link', 'peer-a', 'archived', workspace.dir),
      /no lifecycle/i,
    );
  });
});
