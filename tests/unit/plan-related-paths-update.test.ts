import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntity, getEntity, updateEntity } from '../../src/core/entity-operations.js';
import { ENTITY_REGISTRY } from '../../src/core/entity-registry.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

// trp#434 — plan.related_paths was settable at create but not updatable
// (decision/constraint/trap already allow it). Canonical-API consistency.

describe('plan.related_paths is updatable (trp#434)', () => {
  it('declares related_paths in the plan updatable set', () => {
    assert.ok(
      ENTITY_REGISTRY.plan.updatable.includes('related_paths'),
      'plan.updatable must include related_paths',
    );
  });

  describe('round-trip', () => {
    let workspace: TestWorkspace;
    beforeEach(() => { workspace = createTestWorkspace({ prefix: 'bclaw-plan-relpaths-' }); });
    afterEach(() => { workspace.cleanup(); });

    it('bclaw_update accepts and persists related_paths on a plan', () => {
      const created = createEntity('plan', {
        text: 'wire the thing',
        author: 'jberdah',
        related_paths: ['src/a.ts'],
      }, workspace.dir);

      updateEntity('plan', created.id, { related_paths: ['src/a.ts', 'src/b.ts'] }, workspace.dir);

      const fetched = getEntity('plan', created.id, workspace.dir) as { related_paths?: string[] };
      assert.deepStrictEqual(fetched.related_paths, ['src/a.ts', 'src/b.ts']);
    });

    it('rejects an unknown field but allows related_paths (no longer in the reject list)', () => {
      const created = createEntity('plan', { text: 'x', author: 'jberdah' }, workspace.dir);
      assert.throws(
        () => updateEntity('plan', created.id, { banana: 'split' } as Record<string, unknown>, workspace.dir),
        /not updatable/i,
      );
      assert.doesNotThrow(
        () => updateEntity('plan', created.id, { related_paths: ['x'] }, workspace.dir),
      );
    });
  });
});
