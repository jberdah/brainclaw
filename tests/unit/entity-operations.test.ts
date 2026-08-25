import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EntityNotFoundError,
  EntityOperationUnsupportedError,
  InvalidTransitionError,
  SystemManagedError,
  UnknownEntityError,
  createEntity,
  getEntity,
  listEntities,
  projectAgentForRead,
  removeEntity,
  transitionEntity,
  updateEntity,
} from '../../src/core/entity-operations.js';
import type { EntityName } from '../../src/core/entity-registry.js';
import { createAssignment, loadAssignment } from '../../src/core/assignments.js';
import { loadClaim, saveClaim } from '../../src/core/claims.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { nowISO } from '../../src/core/ids.js';
import { loadState, mutateState } from '../../src/core/state.js';
import type { AgentIdentityDocument, Handoff } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/entity-operations — front-door guard (pln#625 Phase 1)', () => {
  // The guard runs BEFORE any filesystem access, so this path is never touched.
  // If the guard ever stopped firing first, the pre-guard behavior would surface
  // instead (EntityOperationUnsupportedError for find/get/create/remove; a raw
  // TypeError for update/transition) — a different error class than
  // UnknownEntityError, so these assertions still catch the regression.
  const cwd = 'C:/nonexistent/guard-test-never-touched';
  // NB 'agent' used to be the canonical "unknown entity" fixture here. pln#625
  // Phase 2c promoted agent to a registered read-only entity (find/get wired,
  // writes → SystemManagedError), so the fixture is now a name that is genuinely
  // absent from the registry.
  const unknown = 'widget' as EntityName; // the MCP layer passes entity as a free string

  it('every canonical verb rejects an unknown entity with a curated UnknownEntityError (not a raw TypeError)', () => {
    assert.throws(() => listEntities(unknown, cwd), UnknownEntityError);
    assert.throws(() => getEntity(unknown, 'x', cwd), UnknownEntityError);
    assert.throws(() => createEntity(unknown, {}, cwd), UnknownEntityError);
    assert.throws(() => updateEntity(unknown, 'x', {}, cwd), UnknownEntityError);
    assert.throws(() => removeEntity(unknown, 'x', cwd), UnknownEntityError);
    assert.throws(() => transitionEntity(unknown, 'x', 'y', cwd), UnknownEntityError);
  });

  it('the error is operator-legible: names the verb, the bad entity, and the valid set', () => {
    try {
      updateEntity(unknown, 'x', { title: 'y' }, cwd);
      assert.fail('expected UnknownEntityError');
    } catch (err) {
      assert.ok(err instanceof UnknownEntityError, `expected UnknownEntityError, got ${(err as Error).name}`);
      const msg = (err as Error).message;
      assert.match(msg, /bclaw_update\(entity='widget'\)/);
      assert.match(msg, /unknown entity/i);
      assert.match(msg, /decision/, 'should list the addressable entities');
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

describe('core/entity-operations — writePolicy enforcement (pln#625 Phase 2)', () => {
  // The default (unwired) write path throws before any I/O, so this path is never touched.
  const cwd = 'C:/nonexistent/writepolicy-test-never-touched';

  // create/update/remove throw at the switch default before any I/O, so the
  // fake cwd is never touched. (transition does I/O first — its boundary is
  // covered with a real record in the CRUD-dispatch describe below.)
  it('a system-managed entity reports SystemManagedError on create/update/remove', () => {
    assert.throws(() => createEntity('action' as EntityName, {}, cwd), SystemManagedError);
    assert.throws(() => updateEntity('action' as EntityName, 'x', { tags: ['t'] }, cwd), SystemManagedError);
    assert.throws(() => removeEntity('action' as EntityName, 'x', cwd), SystemManagedError);
    assert.throws(() => createEntity('agent_run' as EntityName, {}, cwd), SystemManagedError);
    // pln#625 Phase 2c — agent is read-only via the grammar: every write verb
    // hits the system-managed boundary, not "not yet wired".
    assert.throws(() => createEntity('agent' as EntityName, {}, cwd), SystemManagedError);
    assert.throws(() => updateEntity('agent' as EntityName, 'x', { tags: ['t'] }, cwd), SystemManagedError);
    assert.throws(() => removeEntity('agent' as EntityName, 'x', cwd), SystemManagedError);
  });

  it('the SystemManagedError is operator-legible: says system-managed AND names the authorized path (from writePolicyNote)', () => {
    try {
      createEntity('action' as EntityName, {}, cwd);
      assert.fail('expected SystemManagedError');
    } catch (err) {
      assert.ok(err instanceof SystemManagedError, `expected SystemManagedError, got ${(err as Error).name}`);
      const msg = (err as Error).message;
      assert.match(msg, /system-managed/i);
      assert.match(msg, /bclaw_assignment_action/, 'must name the authorized path from writePolicyNote');
    }
  });

  it('an agent-ownable but not-yet-wired entity keeps the "not yet wired" signal, NOT the system boundary', () => {
    // handoff has no writePolicy → defaults to 'agent': its unwired create is a
    // "coming soon" gap, not a runtime-owned boundary. Proves writePolicy only
    // relabels the default and does not over-classify agent-ownable entities.
    try {
      createEntity('handoff' as EntityName, { author: 'x' }, cwd);
      assert.fail('expected EntityOperationUnsupportedError');
    } catch (err) {
      assert.ok(err instanceof EntityOperationUnsupportedError, `expected EntityOperationUnsupportedError, got ${(err as Error).name}`);
      assert.ok(!(err instanceof SystemManagedError), 'agent-ownable entity must NOT get the system-managed boundary');
      assert.match((err as Error).message, /not yet wired/);
    }
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
    it('returns bounded proximity hints without blocking a legitimate duplicate', () => {
      const original = createEntity('trap', {
        text: 'Codex preflight loses the stdin prompt and rejects a healthy reviewer',
        author: 'testuser',
      }, workspace.dir);
      const duplicate = createEntity('trap', {
        text: 'Codex preflight loses stdin prompt and rejects the healthy reviewer',
        author: 'testuser',
      }, workspace.dir);

      assert.notEqual(duplicate.id, original.id, 'creation remains non-blocking');
      assert.equal(duplicate.nearby_items?.length, 1);
      assert.equal(duplicate.nearby_items?.[0]?.id, original.id);
      assert.match(duplicate.nearby_items?.[0]?.reason ?? '', /similar|exact/);
      assert.ok((duplicate.nearby_items?.[0]?.preview.length ?? 0) <= 160);
    });

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
    it('find on inbox_message routes to bclaw_read_inbox (per-agent), not a misleading global list', () => {
      assert.throws(() => listEntities('inbox_message', workspace.dir, {}), /bclaw_read_inbox/);
    });

    it('find/get is now wired for the previously-unwired reads: step / session / instruction (pln#625 Phase 2)', async () => {
      // step + instruction: empty workspace → empty list, but no longer the
      // EntityOperationUnsupportedError default.
      assert.doesNotThrow(() => listEntities('step', workspace.dir, {}));
      assert.doesNotThrow(() => listEntities('instruction', workspace.dir, {}));
      // session: seed one and prove the session_id -> id alias makes get uniform.
      const { saveCurrentSession } = await import('../../src/core/identity.js');
      saveCurrentSession({
        session_id: 'sess_readtest',
        started_at: nowISO(),
        last_seen_at: nowISO(),
        agent: 'claude-code',
        agent_id: 'agt_readtest',
        host_id: 'host_readtest',
      }, workspace.dir);
      assert.doesNotThrow(() => listEntities('session', workspace.dir, {}));
      const got = getEntity('session', 'sess_readtest', workspace.dir) as { session_id: string; id: string };
      assert.equal(got.session_id, 'sess_readtest');
      assert.equal(got.id, 'sess_readtest', 'session_id must be aliased to id for uniform get');
    });

    it('create on a system-managed entity throws the system-managed boundary (pln#625 Phase 2)', () => {
      // assignment.writePolicy = 'system' — created by dispatch, not the grammar.
      // (The agent-ownable "not yet wired" path is covered in the writePolicy
      // enforcement describe above, via handoff.)
      assert.throws(() => createEntity('assignment', {}, workspace.dir), SystemManagedError);
      assert.throws(() => createEntity('assignment', {}, workspace.dir), /system-managed/);
    });

    it('transition on a system-managed entity (real record) reports the boundary past the I/O checks', async () => {
      // transition does statusField + load + isValidTransition BEFORE the switch,
      // so a fake id yields not-found / invalid-transition, not the boundary.
      // Seed a real pending action and attempt a VALID transition: it clears
      // those checks, reaches the switch default, and reports SystemManagedError
      // (actions are resolved via bclaw_assignment_action, not the grammar).
      const { createActionRequired } = await import('../../src/core/actions.js');
      const action = createActionRequired({
        assignment_id: 'asgn_test',
        agent: 'claude-code',
        kind: 'approval',
        title: 'seed for transition boundary',
        prompt: 'approve?',
      }, workspace.dir);
      assert.equal(action.status, 'pending');
      assert.throws(
        () => transitionEntity('action', action.id, 'resolved', workspace.dir),
        SystemManagedError,
      );
    });
  });

  describe('runtime_note remove contract (trp_dc9ca61e)', () => {
    it('default remove ARCHIVES: the raw record is parked under gc-backups before the file is unlinked', async () => {
      const fs = (await import('node:fs')).default;
      const path = (await import('node:path')).default;
      const created = createEntity('runtime_note', {
        agent: 'testuser',
        text: 'note to archive',
      }, workspace.dir);

      const result = removeEntity('runtime_note', created.id, workspace.dir);

      assert.equal(result.archived, true);
      assert.equal(result.purged, false);
      const backupDir = path.join(workspace.dir, '.brainclaw', 'gc-backups');
      const backups = fs.readdirSync(backupDir).filter((f: string) => f.startsWith('removed-runtime-notes-'));
      assert.equal(backups.length, 1);
      const parked = fs.readFileSync(path.join(backupDir, backups[0]), 'utf-8');
      assert.ok(parked.includes(created.id), 'parked JSONL must contain the removed note');
      assert.ok(parked.includes('"_removal_type":"bclaw_remove"'));
    });

    it('purge:true hard-deletes without parking', async () => {
      const fs = (await import('node:fs')).default;
      const path = (await import('node:path')).default;
      const created = createEntity('runtime_note', {
        agent: 'testuser',
        text: 'note to purge',
      }, workspace.dir);

      const result = removeEntity('runtime_note', created.id, workspace.dir, true);

      assert.equal(result.archived, false);
      assert.equal(result.purged, true);
      const backupDir = path.join(workspace.dir, '.brainclaw', 'gc-backups');
      const backups = fs.existsSync(backupDir)
        ? fs.readdirSync(backupDir).filter((f: string) => f.startsWith('removed-runtime-notes-'))
        : [];
      assert.equal(backups.length, 0);
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

describe('core/entity-operations — agent read-only projection (pln#625 Phase 2c)', () => {
  let workspace: TestWorkspace;

  const SECRET_KEY = 'sk-SECRET-do-not-leak';
  const SECRET_PEM = '-----BEGIN PUBLIC KEY-----\nSECRETKEYMATERIAL\n-----END PUBLIC KEY-----';
  const FULL_FINGERPRINT = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-agent-read-' });
    const doc: AgentIdentityDocument = {
      version: 1,
      agent_id: 'agt_read0001',
      agent_name: 'codex-tester',
      created_at: nowISO(),
      kind: 'agent',
      trust_level: 'contributor',
      capabilities: ['review', 'schema'],
      identity_key: {
        algorithm: 'ed25519',
        public_key: SECRET_PEM,
        fingerprint: FULL_FINGERPRINT,
        created_at: nowISO(),
      },
      model: 'gpt-5-codex',
      invoke: {
        command: 'codex exec {prompt}',
        channel: 'spawn',
        timeout: 600,
        env: { OPENAI_API_KEY: SECRET_KEY },
      },
    };
    saveAgentIdentity(doc, workspace.dir);
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('find(agent) returns a redacted projection — key material dropped, invoke gone, FULL fingerprint', () => {
    const listed = listEntities('agent', workspace.dir, {});
    const hit = (listed.items as Array<Record<string, unknown>>).find((a) => a.name === 'codex-tester');
    assert.ok(hit, 'saved agent should be findable');
    assert.equal(hit!.id, 'agt_read0001');
    assert.equal(hit!.kind, 'agent');
    assert.equal(hit!.trust_level, 'contributor');
    assert.deepEqual(hit!.capabilities, ['review', 'schema']);
    // Full public fingerprint (public key id, matches the cloud) — NOT truncated;
    // the private key material (identity_key / public_key PEM) is what's dropped.
    assert.equal(hit!.fingerprint, FULL_FINGERPRINT);
    assert.equal(hit!.identity_key, undefined);
    // invoke is not projected at all (dead field + would leak invoke.command).
    assert.equal(hit!.invoke, undefined);
    // Belt-and-braces: no secret (env value / key PEM) leaks in the projection.
    const serialized = JSON.stringify(hit);
    assert.doesNotMatch(serialized, /sk-SECRET-do-not-leak/);
    assert.doesNotMatch(serialized, /SECRETKEYMATERIAL/);
  });

  it('projection is a strict allow-list — an unknown future field stays hidden', () => {
    const docWithSecret = {
      version: 1,
      agent_id: 'agt_alx',
      agent_name: 'allowlist-probe',
      created_at: nowISO(),
      kind: 'agent',
      trust_level: 'observer',
      capabilities: [],
      secret_field: 'LEAK-ME',
    } as unknown as AgentIdentityDocument;
    const projected = projectAgentForRead(docWithSecret) as Record<string, unknown>;
    assert.equal(projected.secret_field, undefined);
    assert.doesNotMatch(JSON.stringify(projected), /LEAK-ME/);
  });

  it('get(agent) resolves by id OR name (short_label alias) and is equally redacted', () => {
    const byName = getEntity('agent', 'codex-tester', workspace.dir) as Record<string, unknown>;
    const byId = getEntity('agent', 'agt_read0001', workspace.dir) as Record<string, unknown>;
    assert.equal(byName.id, 'agt_read0001');
    assert.equal(byId.name, 'codex-tester');
    assert.equal(byName.identity_key, undefined);
    assert.equal(byName.invoke, undefined);
  });

  it('get(agent) throws EntityNotFoundError for an unknown id/name', () => {
    assert.throws(() => getEntity('agent', 'nope', workspace.dir), EntityNotFoundError);
  });

  it('find(agent, scope=global) unions the dispatchable catalog with dispatchable/registered flags', () => {
    const projectScoped = listEntities('agent', workspace.dir, {}).items as Array<Record<string, unknown>>;
    const globalScoped = listEntities('agent', workspace.dir, { scope: 'global' }).items as Array<Record<string, unknown>>;
    // Global is a superset — it adds catalog-only (unregistered) agents.
    assert.ok(globalScoped.length >= projectScoped.length);
    // The registered agent is flagged registered:true with a boolean dispatchable.
    const seeded = globalScoped.find((a) => a.name === 'codex-tester');
    assert.ok(seeded);
    assert.equal(seeded!.registered, true);
    assert.equal(typeof seeded!.dispatchable, 'boolean');
    // At least one catalog-only (unregistered but dispatchable) agent appears.
    assert.ok(
      globalScoped.some((a) => a.registered === false && a.dispatchable === true),
      'scope=global should surface catalog-only dispatchable agents',
    );
    // Project scope carries neither flag (it is the plain audit registry).
    assert.equal(projectScoped.find((a) => a.name === 'codex-tester')!.registered, undefined);
  });

  it('find(agent, includeReputation) attaches a reputation field (opt-in), absent otherwise; catalog-only agents never join', () => {
    const plain = listEntities('agent', workspace.dir, {}).items as Array<Record<string, unknown>>;
    const withRep = listEntities('agent', workspace.dir, { includeReputation: true }).items as Array<Record<string, unknown>>;
    const plainHit = plain.find((a) => a.name === 'codex-tester')!;
    const repHit = withRep.find((a) => a.name === 'codex-tester')!;
    // Opt-in: a REGISTERED agent gets the key only when requested. The join maps
    // by agent_id (projected as `id`) using the same code path as the CLI
    // list-agents --with-reputation; here reputation is disabled-by-default so
    // the value is undefined — the presence/absence of the key is what proves the
    // join ran on the registered agent.
    assert.equal('reputation' in plainHit, false);
    assert.equal('reputation' in repHit, true);
    // Redaction still holds with the join on.
    assert.equal(repHit.identity_key, undefined);
    assert.equal(repHit.invoke, undefined);

    // Codex #83 P2 — with scope=global, catalog-only agents (no agent_id) must
    // NOT join a reputation entry (no accidental match via String(null)="null").
    const global = listEntities('agent', workspace.dir, { scope: 'global', includeReputation: true }).items as Array<Record<string, unknown>>;
    const catalogOnly = global.find((a) => a.registered === false);
    assert.ok(catalogOnly, 'expected at least one catalog-only agent under scope=global');
    assert.equal('reputation' in catalogOnly!, false, 'catalog-only agents must never carry a reputation join');
  });
});

describe('core/entity-operations — handoff lifecycle transition (pln#625 Phase 2a)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-handoff-tx-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  function pushHandoff(over: Partial<Handoff> & { id: string; status: Handoff['status'] }): void {
    mutateState((state) => {
      state.open_handoffs.push({
        from: 'alice',
        to: 'bob',
        text: 'ship it',
        created_at: nowISO(),
        author: 'alice',
        tags: [],
        ...over,
      } as Handoff);
    }, workspace.dir);
  }

  it('wires open→accepted→closed and persists each step', () => {
    pushHandoff({ id: 'hnd_tx1', status: 'open' });

    const r1 = transitionEntity('handoff', 'hnd_tx1', 'accepted', workspace.dir);
    assert.equal(r1.from, 'open');
    assert.equal(r1.to, 'accepted');
    assert.equal((getEntity('handoff', 'hnd_tx1', workspace.dir) as { status: string }).status, 'accepted');

    const r2 = transitionEntity('handoff', 'hnd_tx1', 'closed', workspace.dir);
    assert.equal(r2.to, 'closed');
    assert.equal((getEntity('handoff', 'hnd_tx1', workspace.dir) as { status: string }).status, 'closed');
  });

  it('rejects a transition out of a terminal (closed) state', () => {
    pushHandoff({ id: 'hnd_tx2', status: 'closed' });
    assert.throws(
      () => transitionEntity('handoff', 'hnd_tx2', 'accepted', workspace.dir),
      InvalidTransitionError,
    );
  });

  it('tip guard: refuses to transition a superseded (tombstoned) handoff and points at the tip', () => {
    // correctHandoff leaves the original frozen with superseded_by set. Even a
    // registry-valid transition (open→closed) must be refused on it.
    pushHandoff({ id: 'hnd_orig', status: 'open', superseded_by: 'hnd_new' });
    assert.throws(
      () => transitionEntity('handoff', 'hnd_orig', 'closed', workspace.dir),
      /immutable tombstone[\s\S]*Transition the current tip \(hnd_new\)/,
    );
    // The frozen record's status is untouched.
    assert.equal((getEntity('handoff', 'hnd_orig', workspace.dir) as { status: string }).status, 'open');
  });
});

describe('core/entity-operations — handoff update / review-state (pln#625 Phase 3)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-handoff-update-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  function pushHandoff(over: Partial<Handoff> & { id: string; status: Handoff['status'] }): void {
    mutateState((state) => {
      state.open_handoffs.push({
        from: 'alice', to: 'bob', text: 'ship it', created_at: nowISO(),
        author: 'alice', tags: [], ...over,
      } as Handoff);
    }, workspace.dir);
  }

  it('wires narrative/tags update (previously fell through to "not yet wired")', () => {
    pushHandoff({ id: 'hnd_u1', status: 'open' });
    updateEntity('handoff', 'hnd_u1', { narrative: 'picked up the migration', tags: ['migration'] }, workspace.dir);
    const h = getEntity('handoff', 'hnd_u1', workspace.dir) as { narrative: string; tags: string[] };
    assert.equal(h.narrative, 'picked up the migration');
    assert.deepEqual(h.tags, ['migration']);
  });

  it('writes a review verdict and stamps reviewed_at (review-state capability restored)', () => {
    pushHandoff({ id: 'hnd_u2', status: 'open' });
    updateEntity('handoff', 'hnd_u2', { review: { verdict: 'approve', summary: 'LGTM', blocking_issues: [] } }, workspace.dir);
    const h = getEntity('handoff', 'hnd_u2', workspace.dir) as { review: { verdict: string; summary: string; reviewed_at?: string } };
    assert.equal(h.review.verdict, 'approve');
    assert.equal(h.review.summary, 'LGTM');
    assert.ok(h.review.reviewed_at, 'reviewed_at should be stamped when a verdict lands');
  });

  it('merges successive review updates (does not wipe prior fields)', () => {
    pushHandoff({ id: 'hnd_u3', status: 'open' });
    updateEntity('handoff', 'hnd_u3', { review: { requester: 'alice', reviewer: 'codex' } }, workspace.dir);
    updateEntity('handoff', 'hnd_u3', { review: { verdict: 'request_changes' } }, workspace.dir);
    const h = getEntity('handoff', 'hnd_u3', workspace.dir) as { review: { requester?: string; reviewer?: string; verdict?: string } };
    assert.equal(h.review.requester, 'alice', 'earlier review fields must survive a later merge');
    assert.equal(h.review.reviewer, 'codex');
    assert.equal(h.review.verdict, 'request_changes');
  });

  it('rejects an invalid review verdict (Zod-validated)', () => {
    pushHandoff({ id: 'hnd_u4', status: 'open' });
    assert.throws(
      () => updateEntity('handoff', 'hnd_u4', { review: { verdict: 'bogus' } }, workspace.dir),
      /Invalid handoff\.review/,
    );
  });

  it('persists a contract update', () => {
    pushHandoff({ id: 'hnd_u5', status: 'open' });
    updateEntity('handoff', 'hnd_u5', { contract: { files_touched: ['src/a.ts'], tests_to_verify: ['a.test.ts'] } }, workspace.dir);
    const h = getEntity('handoff', 'hnd_u5', workspace.dir) as { contract: { files_touched: string[] } };
    assert.deepEqual(h.contract.files_touched, ['src/a.ts']);
  });

  it('tip guard: refuses to update a superseded (tombstoned) handoff', () => {
    pushHandoff({ id: 'hnd_u6', status: 'open', superseded_by: 'hnd_u6b' });
    assert.throws(
      () => updateEntity('handoff', 'hnd_u6', { review: { verdict: 'approve' } }, workspace.dir),
      /immutable tombstone[\s\S]*Update the current tip \(hnd_u6b\)/,
    );
  });

  // Codex #84 P1 — the completion rule (which fields stamp reviewed_at) is a
  // single source of truth shared with applyHandoffUpdates. Every one of the 5
  // completion fields must stamp, matching the dispatcher path.
  const COMPLETION_PATCHES: Array<Record<string, unknown>> = [
    { verdict: 'approve' },
    { reviewed_by: 'codex' },
    { summary: 'looks good' },
    { blocking_issues: ['none'] },
    { suggestions: ['nit'] },
  ];
  for (const [i, reviewPatch] of COMPLETION_PATCHES.entries()) {
    it(`review completion field #${i + 1} (${Object.keys(reviewPatch)[0]}) stamps reviewed_at`, () => {
      const id = `hnd_cmpl_${i}`;
      pushHandoff({ id, status: 'open' });
      updateEntity('handoff', id, { review: reviewPatch }, workspace.dir);
      const h = getEntity('handoff', id, workspace.dir) as { review: { reviewed_at?: string } };
      assert.ok(h.review.reviewed_at, `${Object.keys(reviewPatch)[0]} must stamp reviewed_at (parity with applyHandoffUpdates)`);
    });
  }

  it('a re-review re-stamps reviewed_at', async () => {
    pushHandoff({ id: 'hnd_rr', status: 'open' });
    updateEntity('handoff', 'hnd_rr', { review: { verdict: 'request_changes' } }, workspace.dir);
    const first = (getEntity('handoff', 'hnd_rr', workspace.dir) as { review: { reviewed_at: string } }).review.reviewed_at;
    // nowISO() is millisecond-resolution; ensure the clock advances before re-review.
    await new Promise((r) => setTimeout(r, 5));
    updateEntity('handoff', 'hnd_rr', { review: { verdict: 'approve' } }, workspace.dir);
    const second = (getEntity('handoff', 'hnd_rr', workspace.dir) as { review: { reviewed_at: string } }).review.reviewed_at;
    assert.notEqual(second, first, 're-review must re-stamp reviewed_at');
  });

  it('rejects an empty review patch (no silent no-op)', () => {
    pushHandoff({ id: 'hnd_empty', status: 'open' });
    assert.throws(
      () => updateEntity('handoff', 'hnd_empty', { review: {} }, workspace.dir),
      /no recognized fields/,
    );
    assert.equal((getEntity('handoff', 'hnd_empty', workspace.dir) as { review?: unknown }).review, undefined);
  });

  it('rejects an unknown review key instead of silently stripping it', () => {
    pushHandoff({ id: 'hnd_unk', status: 'open' });
    // `review_verdict` is a common mistake for `verdict` — Zod would strip it by
    // default (silent no-op); the strict write-path parse must reject it.
    assert.throws(
      () => updateEntity('handoff', 'hnd_unk', { review: { review_verdict: 'approve' } }, workspace.dir),
      /Invalid handoff\.review/,
    );
    assert.equal((getEntity('handoff', 'hnd_unk', workspace.dir) as { review?: unknown }).review, undefined);
  });

  it('rejects an unknown contract key', () => {
    pushHandoff({ id: 'hnd_unkc', status: 'open' });
    assert.throws(
      () => updateEntity('handoff', 'hnd_unkc', { contract: { file_touched: ['a.ts'] } }, workspace.dir),
      /Invalid handoff\.contract/,
    );
  });
});
