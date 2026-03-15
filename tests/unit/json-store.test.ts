import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from '../../src/core/json-store.js';
import type { Claim } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function createStore(dir: string): JsonStore<Claim> {
  return new JsonStore<Claim>({
    dirPath: dir,
    documentType: 'claim',
    getId: (claim) => claim.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

describe('core/json-store', () => {
  let workspace: TestWorkspace | undefined;

  afterEach(() => {
    workspace?.cleanup();
    workspace = undefined;
  });

  it('supports CRUD and persists schema_version on save', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-store-crud-' });
    const dir = path.join(workspace.dir, '.brainclaw', 'claims');
    const store = createStore(dir);

    const claim: Claim = {
      id: 'clm_store',
      agent: 'copilot',
      scope: 'src/core',
      description: 'Store claim',
      created_at: '2026-03-15T10:00:00.000Z',
      status: 'active',
    };

    store.save(claim);
    assert.equal(store.exists(claim.id), true);
    assert.equal(store.load(claim.id).schema_version, 2);

    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'clm_store.json'), 'utf-8')) as { schema_version?: number };
    assert.equal(persisted.schema_version, 2);

    store.delete(claim.id);
    assert.equal(store.exists(claim.id), false);
  });

  it('lists legacy documents, migrates them in memory, and skips malformed files', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-store-list-' });
    const dir = path.join(workspace.dir, '.brainclaw', 'claims');
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'clm_old.json'), JSON.stringify({
      id: 'clm_old',
      agent: 'claude',
      scope: 'src/auth',
      description: 'Legacy claim',
      created_at: '2026-03-15T08:00:00.000Z',
      status: 'active',
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not-json', 'utf-8');

    const store = createStore(dir);
    const claims = store.list();

    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.schema_version, 2);
    assert.equal(claims[0]?.id, 'clm_old');
  });

  it('throws on unsupported schema versions', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-store-future-' });
    const dir = path.join(workspace.dir, '.brainclaw', 'claims');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clm_future.json'), JSON.stringify({
      schema_version: 99,
      id: 'clm_future',
      agent: 'copilot',
      scope: 'src/api',
      description: 'Future claim',
      created_at: '2026-03-15T08:00:00.000Z',
      status: 'active',
    }, null, 2), 'utf-8');

    const store = createStore(dir);
    assert.throws(() => store.load('clm_future'));
  });
});
