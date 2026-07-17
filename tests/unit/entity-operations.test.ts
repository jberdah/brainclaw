import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EntityNotFoundError,
  EntityOperationUnsupportedError,
  InvalidTransitionError,
  UnknownEntityError,
  createEntity,
  getEntity,
  listEntities,
  removeEntity,
  transitionEntity,
  updateEntity,
} from '../../src/core/entity-operations.js';
import type { EntityName } from '../../src/core/entity-registry.js';
import { createAssignment, loadAssignment } from '../../src/core/assignments.js';
import { loadClaim, saveClaim } from '../../src/core/claims.js';
import { nowISO } from '../../src/core/ids.js';
import { loadState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/entity-operations — front-door guard (pln#625 Phase 1)', () => {
  // The guard runs BEFORE any filesystem access, so this path is never touched.
  // If the guard ever stopped firing first, an ENOENT would surface here instead
  // of UnknownEntityError — making these assertions a canary for that regression.
  const cwd = 'C:/nonexistent/guard-test-never-touched';
  const unknown = 'agent' as EntityName; // the MCP layer passes entity as a free string

  it('every canonical verb rejects an unknown entity with a curated UnknownEntityError (not a raw TypeError)', () => {
    assert.throws(() => listEntities(unknown, cwd), UnknownEntityError);
    assert.throws(() => getEntity(unknown, 'x', cwd), UnknownEntityError);
    assert.throws(() => createEntity(unknown, {}, cwd), UnknownEntityError);
    assert.throws(() => updateEntity(unknown, 'x', {}, cwd), UnknownEntityError);
    assert.throws(() => removeEntity(unknown, 'x', cwd), UnknownEntityError);
    assert.throws(() => transitionEntity(unknown, 'x', 'y', cwd), UnknownEntityError);
  });

  it('the error is operator-legible: names the verb, the bad entity, the valid set, and the agent hint', () => {
    try {
      updateEntity('agent' as EntityName, 'x', { title: 'y' }, cwd);
      assert.fail('expected UnknownEntityError');
    } catch (err) {
      assert.ok(err instanceof UnknownEntityError, `expected UnknownEntityError, got ${(err as Error).name}`);
      const msg = (err as Error).message;
      assert.match(msg, /bclaw_update\(entity='agent'\)/);
      assert.match(msg, /unknown entity/i);
      assert.match(msg, /register-agent/, 'agent name should get the identity-management hint');
      assert.match(msg, /decision/, 'should list the addressable entities');
    }
  });

  it('a non-agent unknown name gets the curated error WITHOUT the agent hint', () => {
    try {
      getEntity('widget' as EntityName, 'x', cwd);
      assert.fail('expected UnknownEntityError');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /unknown entity/i);
      assert.doesNotMatch(msg, /register-agent/);
    }
  });

  it('a KNOWN-but-unwired entity still gets EntityOperationUnsupportedError (guard is additive, not a shadow)', () => {
    // handoff IS a registered entity but its create is not yet wired → the
    // switch default must still fire. The guard only catches names absent from
    // the registry, so it must not swallow the existing not-yet-wired signal.
    assert.throws(
      () => createEntity('handoff' as EntityName, { author: 'x' }, cwd),
      EntityOperationUnsupportedError,
    );
  });
});

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

  describe('claim (trp#928)', () => {
    // trp#928 regression: before this landing, bclaw_transition(entity='claim',
    // to='released') passed isValidTransition (the check ran BEFORE the switch)
    // but then the switch fell through to EntityOperationUnsupportedError. The
    // symptom was tested indirectly via existing tests that already showed
    // active-status claims not moving — but they hit the terminal-state check,
    // not the actual missing case. This test hits transition on an ACTIVE claim.
    function seedActiveClaim(workspace: TestWorkspace, id: string, opts?: { planId?: string; agent?: string }): void {
      saveClaim({
        id,
        agent: opts?.agent ?? workspace.currentAgent.agent_name,
        scope: `src/${id}`,
        description: `Test claim ${id}`,
        created_at: nowISO(),
        status: 'active',
        plan_id: opts?.planId,
      }, workspace.dir);
    }

    it('transition on ACTIVE claim → released is wired (was falling through to Unsupported)', () => {
      const claimId = 'clm_transactive_1';
      seedActiveClaim(workspace, claimId);

      const result = transitionEntity('claim', claimId, 'released', workspace.dir);
      assert.equal(result.from, 'active');
      assert.equal(result.to, 'released');
      assert.ok(result.side_effects.includes('audit:claim_released'));

      const reloaded = loadClaim(claimId, workspace.dir);
      assert.equal(reloaded.status, 'released');
      assert.ok(reloaded.released_at, 'released_at should be stamped');
    });

    it('transition on ACTIVE claim → stale marks stale (distinct from released)', () => {
      const claimId = 'clm_transactive_2';
      seedActiveClaim(workspace, claimId);

      const result = transitionEntity('claim', claimId, 'stale', workspace.dir);
      assert.equal(result.from, 'active');
      assert.equal(result.to, 'stale');
      assert.ok(result.side_effects.includes('audit:claim_stale'));

      const reloaded = loadClaim(claimId, workspace.dir);
      assert.equal(reloaded.status, 'stale');
    });

    it('coordinator override: non-owner without override is rejected with executable hint', () => {
      const claimId = 'clm_transactive_3';
      seedActiveClaim(workspace, claimId, { agent: 'other-worker' });

      assert.throws(
        () => transitionEntity('claim', claimId, 'released', workspace.dir, undefined, {
          agent: 'coordinator',
          override: false,
        }),
        (err: Error) => /coordinator_override:true/.test(err.message),
        'error must point at the executable coordinator_override:true param',
      );
    });

    it('coordinator override: non-owner with override succeeds', () => {
      const claimId = 'clm_transactive_4';
      seedActiveClaim(workspace, claimId, { agent: 'other-worker' });

      const result = transitionEntity('claim', claimId, 'released', workspace.dir, undefined, {
        agent: 'coordinator',
        override: true,
      });
      assert.equal(result.to, 'released');
      const reloaded = loadClaim(claimId, workspace.dir);
      assert.equal(reloaded.status, 'released');
    });

    it('plan → done cascades to release linked active claims (release_linked_claims_if_last)', () => {
      // Seed a plan + two claims linked to it, then transition plan → in_progress → done.
      const created = createEntity('plan', { text: 'plan with claims', author: 'testuser' }, workspace.dir);
      const planId = created.id;
      seedActiveClaim(workspace, 'clm_planscope_a', { planId });
      seedActiveClaim(workspace, 'clm_planscope_b', { planId });

      transitionEntity('plan', planId, 'in_progress', workspace.dir);
      transitionEntity('plan', planId, 'done', workspace.dir);

      const a = loadClaim('clm_planscope_a', workspace.dir);
      const b = loadClaim('clm_planscope_b', workspace.dir);
      assert.equal(a.status, 'released', 'plan-done cascade must release claim A');
      assert.equal(b.status, 'released', 'plan-done cascade must release claim B');

      // Sanity: plan itself is done.
      const state = loadState(workspace.dir);
      const plan = state.plan_items.find((p) => p.id === planId);
      assert.ok(plan);
      assert.equal(plan.status, 'done');
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

  describe('sequence (pln#520 step 37c6a777 — canonical grammar parity)', () => {
    it('create → get → find → update → transition → remove round-trip', () => {
      const created = createEntity('sequence', {
        name: 'release lanes',
        author: 'jberdah',
        items: [{ planId: 'pln_aaa', stepId: 'stp_aaa', rank: 1 }],
      }, workspace.dir);
      assert.ok(created.id.startsWith('seq_'), `expected seq_ id, got ${created.id}`);

      const fetched = getEntity('sequence', created.id, workspace.dir) as {
        id: string; name: string; status: string; items: unknown[];
      };
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.name, 'release lanes');
      assert.equal(fetched.status, 'draft');
      assert.equal(fetched.items.length, 1);
      assert.equal((fetched.items[0] as { stepId?: string }).stepId, 'stp_aaa');

      const listed = listEntities('sequence', workspace.dir, {});
      assert.equal(listed.total, 1);
      assert.equal((listed.items[0] as { id: string }).id, created.id);

      updateEntity('sequence', created.id, { name: 'release lanes (v2)' }, workspace.dir);
      const afterUpdate = getEntity('sequence', created.id, workspace.dir) as { name: string };
      assert.equal(afterUpdate.name, 'release lanes (v2)');

      const transitioned = transitionEntity('sequence', created.id, 'active', workspace.dir);
      assert.equal(transitioned.from, 'draft');
      assert.equal(transitioned.to, 'active');
      assert.ok(transitioned.side_effects.includes('audit:sequence_activated'));
      assert.equal((getEntity('sequence', created.id, workspace.dir) as { status: string }).status, 'active');

      // Default remove soft-archives (status='archived'), keeping the lane history.
      const removed = removeEntity('sequence', created.id, workspace.dir);
      assert.equal(removed.archived, true);
      assert.equal(removed.purged, false);
      assert.equal((getEntity('sequence', created.id, workspace.dir) as { status: string }).status, 'archived');
    });

    it('canonical update accepts the full sequence item shape', () => {
      const created = createEntity('sequence', { name: 'shape parity', author: 'u' }, workspace.dir);

      updateEntity('sequence', created.id, {
        items: [{
          planId: 'pln_api',
          stepId: 'stp_contract',
          rank: 1,
          hard_after: ['pln_bootstrap'],
          soft_after: ['pln_docs'],
          lane: 'api',
          scope_hint: 'src/api/**',
          rationale: 'API work can run independently after bootstrap.',
        }],
      }, workspace.dir);

      const fetched = getEntity('sequence', created.id, workspace.dir) as {
        items: Array<Record<string, unknown>>;
      };
      assert.deepEqual(fetched.items[0], {
        planId: 'pln_api',
        stepId: 'stp_contract',
        rank: 1,
        hard_after: ['pln_bootstrap'],
        soft_after: ['pln_docs'],
        lane: 'api',
        scope_hint: 'src/api/**',
        rationale: 'API work can run independently after bootstrap.',
      });
    });

    it('canonical create/update reject malformed sequence items clearly', () => {
      assert.throws(
        () => createEntity('sequence', {
          name: 'bad-items-type',
          author: 'u',
          items: { planId: 'pln_a', rank: 1 },
        }, workspace.dir),
        /items.*array/i,
      );

      assert.throws(
        () => createEntity('sequence', {
          name: 'missing-plan-id',
          author: 'u',
          items: [{ rank: 1 }],
        }, workspace.dir),
        /planId/i,
      );

      assert.throws(
        () => createEntity('sequence', {
          name: 'missing-rank',
          author: 'u',
          items: [{ planId: 'pln_a' }],
        }, workspace.dir),
        /rank/i,
      );

      assert.throws(
        () => createEntity('sequence', {
          name: 'bad-hard-after',
          author: 'u',
          items: [{ planId: 'pln_a', rank: 1, hard_after: 'pln_bootstrap' }],
        }, workspace.dir),
        /hard_after/i,
      );

      const created = createEntity('sequence', { name: 'bad-update', author: 'u' }, workspace.dir);
      assert.throws(
        () => updateEntity('sequence', created.id, { items: { planId: 'pln_a', rank: 1 } }, workspace.dir),
        /items.*array/i,
      );
      assert.throws(
        () => updateEntity('sequence', created.id, { items: [{ planId: 'pln_a', rank: 1 }, { planId: 'pln_b', rank: 1 }] }, workspace.dir),
        /Duplicate sequence rank/,
      );
    });

    it('get resolves by short_label too', () => {
      const created = createEntity('sequence', { name: 'by label', author: 'u' }, workspace.dir);
      const full = getEntity('sequence', created.id, workspace.dir) as { short_label?: string };
      assert.ok(full.short_label, 'sequence should have a short_label');
      const byLabel = getEntity('sequence', full.short_label!, workspace.dir) as { id: string };
      assert.equal(byLabel.id, created.id);
    });

    it('create rejects a missing name', () => {
      assert.throws(
        () => createEntity('sequence', { author: 'u' }, workspace.dir),
        /name/i,
      );
    });

    it('update rejects status (lifecycle goes through transition)', () => {
      const created = createEntity('sequence', { name: 's', author: 'u' }, workspace.dir);
      assert.throws(
        () => updateEntity('sequence', created.id, { status: 'active' }, workspace.dir),
        /not updatable|status/i,
      );
    });

    it('transition rejects an out-of-matrix move (archived is terminal)', () => {
      const created = createEntity('sequence', { name: 's', author: 'u' }, workspace.dir);
      transitionEntity('sequence', created.id, 'archived', workspace.dir);
      assert.throws(
        () => transitionEntity('sequence', created.id, 'active', workspace.dir),
        InvalidTransitionError,
      );
    });

    it('remove purge:true hard-deletes the sequence', () => {
      const created = createEntity('sequence', { name: 'doomed', author: 'u' }, workspace.dir);
      const removed = removeEntity('sequence', created.id, workspace.dir, true);
      assert.equal(removed.purged, true);
      assert.equal(removed.archived, false);
      assert.throws(
        () => getEntity('sequence', created.id, workspace.dir),
        EntityNotFoundError,
      );
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
