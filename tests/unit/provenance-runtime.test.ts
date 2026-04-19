import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEntity, getEntity, listEntities } from '../../src/core/entity-operations.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * Phase 3 slice 3f — runtime provenance wiring.
 * Verifies: new creates stamp a typed `user` provenance; default read
 * filter excludes legacy + low-confidence auto_reflect; overrides work.
 */
describe('core/entity-operations — runtime provenance', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-provenance-runtime-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('auto-stamps user provenance on decision create', () => {
    const created = createEntity('decision', {
      text: 'new decision',
      author: 'jberdah',
    }, workspace.dir);
    const item = getEntity('decision', created.id, workspace.dir) as { provenance: { kind: string; author?: string } };
    assert.equal(item.provenance.kind, 'user');
    assert.equal(item.provenance.author, 'jberdah');
  });

  it('auto-stamps user provenance on runtime_note create', () => {
    const created = createEntity('runtime_note', {
      agent: 'testuser',
      text: 'note',
      author: 'testuser',
    }, workspace.dir);
    const item = getEntity('runtime_note', created.id, workspace.dir) as { provenance: { kind: string; author?: string } };
    assert.equal(item.provenance.kind, 'user');
  });

  it('default list filter excludes records stamped legacy', () => {
    // Seed a legacy record directly.
    const file = path.join(workspace.dir, '.brainclaw', 'memory', 'decisions', 'dec_legacy.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      id: 'dec_legacy', text: 'old', author: 'a',
      created_at: '2025-01-01T00:00:00.000Z', tags: [],
      provenance: { kind: 'legacy' },
    }), 'utf-8');

    // Plus a fresh record (stamped user).
    createEntity('decision', { text: 'new', author: 'a' }, workspace.dir);

    const defaultList = listEntities('decision', workspace.dir, {});
    assert.equal(defaultList.items.length, 1, 'legacy should be filtered out by default');

    const withLegacy = listEntities('decision', workspace.dir, { includeLegacy: true });
    assert.equal(withLegacy.items.length, 2);
  });

  it('default list filter excludes auto_reflect below 0.6 confidence', () => {
    const lowFile = path.join(workspace.dir, '.brainclaw', 'memory', 'decisions', 'dec_low.json');
    const highFile = path.join(workspace.dir, '.brainclaw', 'memory', 'decisions', 'dec_high.json');
    fs.mkdirSync(path.dirname(lowFile), { recursive: true });
    fs.writeFileSync(lowFile, JSON.stringify({
      id: 'dec_low', text: 'auto-low', author: 'a',
      created_at: '2026-04-19T00:00:00.000Z', tags: [],
      provenance: { kind: 'auto_reflect', confidence: 0.3 },
    }), 'utf-8');
    fs.writeFileSync(highFile, JSON.stringify({
      id: 'dec_high', text: 'auto-high', author: 'a',
      created_at: '2026-04-19T00:01:00.000Z', tags: [],
      provenance: { kind: 'auto_reflect', confidence: 0.9 },
    }), 'utf-8');

    const defaultList = listEntities('decision', workspace.dir, {});
    const ids = (defaultList.items as Array<{ id: string }>).map((i) => i.id).sort();
    assert.deepEqual(ids, ['dec_high']);

    const lowered = listEntities('decision', workspace.dir, { minAutoReflectConfidence: 0.1 });
    const allIds = (lowered.items as Array<{ id: string }>).map((i) => i.id).sort();
    assert.deepEqual(allIds, ['dec_high', 'dec_low']);
  });

  it('records without provenance pass through unchanged (pre-v1 compatibility)', () => {
    const file = path.join(workspace.dir, '.brainclaw', 'memory', 'decisions', 'dec_plain.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      id: 'dec_plain', text: 'no provenance', author: 'a',
      created_at: '2025-06-01T00:00:00.000Z', tags: [],
    }), 'utf-8');

    const list = listEntities('decision', workspace.dir, {});
    assert.equal(list.items.length, 1);
  });
});
