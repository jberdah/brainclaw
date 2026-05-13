import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EntityNotFoundError,
  EntityOperationUnsupportedError,
  InvalidTransitionError,
  createEntity,
  getEntity,
  listEntities,
  removeEntity,
  transitionEntity,
  updateEntity,
} from '../../src/core/entity-operations.js';
import { createAssignment, loadAssignment } from '../../src/core/assignments.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/entity-operations — CRUD verb dispatch', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-entity-ops-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  describe('decision', () => {
    it('create → get → update → remove round-trip', () => {
      const created = createEntity('decision', {
        text: 'chose TypeScript',
        author: 'jberdah',
      }, workspace.dir);
      assert.ok(created.id.startsWith('dec_'));

      const fetched = getEntity('decision', created.id, workspace.dir) as { id: string; text: string };
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.text, 'chose TypeScript');

      updateEntity('decision', created.id, { text: 'chose TypeScript (revised)' }, workspace.dir);
      const updated = getEntity('decision', created.id, workspace.dir) as { text: string };
      assert.equal(updated.text, 'chose TypeScript (revised)');

      removeEntity('decision', created.id, workspace.dir);
      assert.throws(() => getEntity('decision', created.id, workspace.dir), EntityNotFoundError);
    });

    it('get by short_label works', () => {
      const created = createEntity('decision', {
        text: 'short-label test',
        author: 'testuser',
      }, workspace.dir);
      assert.ok(created.short_label);
      const fetched = getEntity('decision', created.short_label as string, workspace.dir) as { id: string };
      assert.equal(fetched.id, created.id);
    });

    it('update rejects non-updatable fields', () => {
      const created = createEntity('decision', { text: 'd', author: 'a' }, workspace.dir);
      assert.throws(
        () => updateEntity('decision', created.id, { id: 'dec_hijack' }, workspace.dir),
        /Fields not updatable/,
      );
    });
  });

  describe('trap', () => {
    it('transition active -> resolved follows the registry', () => {
      const created = createEntity('trap', {
        text: 'danger',
        author: 'testuser',
        severity: 'high',
      }, workspace.dir);

      const result = transitionEntity('trap', created.id, 'resolved', workspace.dir);
      assert.equal(result.from, 'active');
      assert.equal(result.to, 'resolved');
      assert.ok(result.side_effects.includes('audit:trap_resolved'));

      const fetched = getEntity('trap', created.id, workspace.dir) as { status: string };
      assert.equal(fetched.status, 'resolved');
    });

    it('transition from terminal state is rejected', () => {
      const created = createEntity('trap', {
        text: 'danger',
        author: 'testuser',
        severity: 'medium',
      }, workspace.dir);
      transitionEntity('trap', created.id, 'resolved', workspace.dir);

      assert.throws(
        () => transitionEntity('trap', created.id, 'active', workspace.dir),
        InvalidTransitionError,
      );
    });
  });

  describe('plan', () => {
    it('find honours status and pagination filters', () => {
      createEntity('plan', { text: 'a', type: 'feat', author: 'u' }, workspace.dir);
      createEntity('plan', { text: 'b', type: 'feat', author: 'u' }, workspace.dir);
      createEntity('plan', { text: 'c', type: 'feat', author: 'u' }, workspace.dir);

      const all = listEntities('plan', workspace.dir, {});
      assert.equal(all.total, 3);
      assert.equal(all.items.length, 3);

      const paged = listEntities('plan', workspace.dir, { limit: 2, offset: 1 });
      assert.equal(paged.total, 3);
      assert.equal(paged.items.length, 2);
    });

    it('transition todo -> in_progress updates status', () => {
      const created = createEntity('plan', { text: 'task', type: 'feat', author: 'u' }, workspace.dir);
      const result = transitionEntity('plan', created.id, 'in_progress', workspace.dir);
      assert.equal(result.from, 'todo');
      assert.equal(result.to, 'in_progress');
      const fetched = getEntity('plan', created.id, workspace.dir) as { status: string };
      assert.equal(fetched.status, 'in_progress');
    });

    it('create rejects missing author (parity with decision/constraint/trap)', () => {
      // Before fix pln_5f44426c, createEntity('plan', {...}) silently accepted
      // a payload missing `author`, wrote a schema-invalid file to disk, and the
      // state sync loop garbage-collected it on the next mutation. The guard
      // now rejects the call up-front so the caller sees the problem.
      assert.throws(
        () => createEntity('plan', { text: 'no author', type: 'feat' }, workspace.dir),
        /author/,
      );
    });

    it('create with only text + author succeeds and persists', () => {
      const created = createEntity('plan', { text: 'minimal', author: 'jberdah' }, workspace.dir);
      const fetched = getEntity('plan', created.id, workspace.dir) as { author: string; text: string };
      assert.equal(fetched.author, 'jberdah');
      assert.equal(fetched.text, 'minimal');
    });
  });

  describe('assignment', () => {
    it('transition supports cancelling an assignment canonically', () => {
      const assignment = createAssignment({
        claim_id: 'clm_entity_assignment_1',
        agent: 'worker',
        dispatcher_agent: 'dispatcher',
        scope: 'src/assignment',
        description: 'Assignment entity test',
      }, workspace.dir);

      const result = transitionEntity('assignment', assignment.id, 'cancelled', workspace.dir, 'operator cancelled');
      assert.equal(result.from, 'created');
      assert.equal(result.to, 'cancelled');

      const reloaded = loadAssignment(assignment.id, workspace.dir);
      assert.equal(reloaded?.status, 'cancelled');
      assert.equal(reloaded?.status_reason, 'operator cancelled');
    });

    it('remove archives an assignment by cancelling it', () => {
      const assignment = createAssignment({
        claim_id: 'clm_entity_assignment_2',
        agent: 'worker',
        dispatcher_agent: 'dispatcher',
        scope: 'src/remove-assignment',
        description: 'Assignment remove test',
      }, workspace.dir);

      const result = removeEntity('assignment', assignment.id, workspace.dir);
      assert.equal(result.archived, true);
      assert.equal(result.purged, false);
      assert.equal(loadAssignment(assignment.id, workspace.dir)?.status, 'cancelled');
    });
  });

  describe('candidate', () => {
    it('find honours canonical source and auto_generated filters', () => {
      const auto = createEntity('candidate', {
        type: 'decision',
        text: 'auto candidate',
        author: 'agent',
        source: 'auto',
      }, workspace.dir);
      const human = createEntity('candidate', {
        type: 'decision',
        text: 'human candidate',
        author: 'user',
        source: 'human',
      }, workspace.dir);

      const autoOnly = listEntities('candidate', workspace.dir, { status: 'pending', auto_generated: true });
      assert.deepEqual(autoOnly.items.map((item: any) => item.id), [auto.id]);

      const nonAuto = listEntities('candidate', workspace.dir, { status: 'pending', auto_generated: false });
      assert.deepEqual(nonAuto.items.map((item: any) => item.id), [human.id]);

      const bySource = listEntities('candidate', workspace.dir, { source: 'human' });
      assert.deepEqual(bySource.items.map((item: any) => item.id), [human.id]);
    });
  });

  describe('unsupported entities', () => {
    it('list on unsupported entity throws', () => {
      assert.throws(
        () => listEntities('session', workspace.dir, {}),
        EntityOperationUnsupportedError,
      );
    });

    it('create on unsupported entity throws with a helpful message', () => {
      assert.throws(
        () => createEntity('assignment', {}, workspace.dir),
        /not yet wired/,
      );
    });
  });

  describe('transition guardrails', () => {
    it('rejects transition on stateless entity', () => {
      const created = createEntity('runtime_note', {
        agent: 'testuser',
        text: 'note',
      }, workspace.dir);
      assert.throws(
        () => transitionEntity('runtime_note', created.id, 'anywhere', workspace.dir),
        /has no lifecycle/,
      );
    });

    it('surfaces side_effects metadata from the registry', () => {
      const created = createEntity('constraint', { text: 'c', author: 'a' }, workspace.dir);
      const result = transitionEntity('constraint', created.id, 'resolved', workspace.dir);
      assert.equal(result.from, 'active');
      assert.equal(result.to, 'resolved');
      assert.ok(result.side_effects.includes('audit:constraint_resolved'));
    });
  });
});
