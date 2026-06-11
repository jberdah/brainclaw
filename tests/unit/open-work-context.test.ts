import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../../src/core/context.js';
import { saveClaim } from '../../src/core/claims.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { State } from '../../src/core/schema.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('open_work in context', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-open-work-',
      projectId: 'prj_open_work_test',
      currentAgent: 'testuser',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('open_work is undefined when agent has no active claims or in_progress plans', () => {
    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.equal(result.open_work, undefined);
  });

  it('open_work includes active claims matching by agent_id', () => {
    saveClaim({
      id: 'clm_test001',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/commands/init.ts',
      description: 'Implementing 0.6.9',
      created_at: iso(30),
      status: 'active',
      schema_version: 2,
    }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.ok(result.open_work);
    assert.equal(result.open_work.active_claims.length, 1);
    assert.equal(result.open_work.active_claims[0].id, 'clm_test001');
    assert.equal(result.open_work.active_claims[0].scope, 'src/commands/init.ts');
    assert.equal(result.open_work.active_claims[0].description, 'Implementing 0.6.9');
  });

  it('does not include released claims', () => {
    saveClaim({
      id: 'clm_test002',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/core/foo.ts',
      description: 'Old work',
      created_at: iso(60),
      released_at: iso(10),
      status: 'released',
      schema_version: 2,
    }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.equal(result.open_work, undefined);
  });

  it('does not include claims belonging to a different agent', () => {
    saveClaim({
      id: 'clm_test003',
      agent: 'otheragent',
      agent_id: 'agt_somebodyelse',
      scope: 'src/other.ts',
      description: "Other agent's work",
      created_at: iso(10),
      status: 'active',
      schema_version: 2,
    }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.equal(result.open_work, undefined);
  });

  it('open_work includes in_progress plan items matching by assignee', () => {
    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [],
      plan_items: [
        { id: 'pln_inprog01', text: 'Refactor auth layer', status: 'in_progress', priority: 'medium', tags: [], assignee: 'testuser', author: 'testuser', created_at: iso(60), updated_at: iso(60), depends_on: [] },
        { id: 'pln_todo01', text: 'Write docs', status: 'todo', priority: 'low', tags: [], author: 'testuser', created_at: iso(60), updated_at: iso(60), depends_on: [] },
      ],
    };
    saveState(state, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.ok(result.open_work);
    assert.equal(result.open_work.in_progress_plans.length, 1);
    assert.equal(result.open_work.in_progress_plans[0].id, 'pln_inprog01');
    assert.equal(result.open_work.in_progress_plans[0].text, 'Refactor auth layer');
  });

  it('open_work pulls in_progress plan linked to active claim via plan_id', () => {
    saveClaim({
      id: 'clm_test004',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/core/context.ts',
      description: 'State hygiene work',
      created_at: iso(20),
      status: 'active',
      plan_id: 'pln_linked01',
      schema_version: 2,
    }, workspace.dir);

    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [],
      plan_items: [
        { id: 'pln_linked01', text: 'Implement state hygiene', status: 'in_progress', priority: 'high', tags: [], author: 'testuser', created_at: iso(60), updated_at: iso(60), depends_on: [] },
      ],
    };
    saveState(state, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.ok(result.open_work);
    assert.equal(result.open_work.active_claims.length, 1);
    assert.equal(result.open_work.active_claims[0].plan_id, 'pln_linked01');
    assert.equal(result.open_work.in_progress_plans.length, 1);
    assert.equal(result.open_work.in_progress_plans[0].id, 'pln_linked01');
  });

  it('open_work includes active assignments for the current agent', () => {
    const assignment = createAssignment({
      claim_id: 'clm_assignment_ctx',
      plan_id: 'pln_assignment_ctx',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      dispatcher_agent: 'codex',
      scope: 'src/core/context.ts',
      description: 'Context runtime assignment',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'codex' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: 'testuser', session_id: 'sess_assignment_ctx' }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.ok(result.open_work);
    assert.equal(result.open_work.active_assignments.length, 1);
    assert.equal(result.open_work.active_assignments[0].id, assignment.id);
    assert.equal(result.open_work.active_assignments[0].status, 'accepted');
    assert.equal(result.open_work.active_assignments[0].scope, 'src/core/context.ts');
  });

  it('open_work excludes timed_out assignments', () => {
    const assignment = createAssignment({
      claim_id: 'clm_assignment_timed_out',
      plan_id: 'pln_assignment_timed_out',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      dispatcher_agent: 'codex',
      scope: 'src/core/context.ts',
      description: 'Timed out assignment should not be open work',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'codex' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: 'testuser', session_id: 'sess_assignment_timed_out' }, workspace.dir);
    transitionAssignment(assignment.id, 'timed_out', { actor: 'sweeper', status_reason: 'No heartbeat' }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    assert.equal(result.open_work, undefined);
  });

  it('renderContextMarkdown shows open_work section at the top', () => {
    saveClaim({
      id: 'clm_test005',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/commands/init.ts src/core/context.ts',
      description: 'Implementing 0.6.9 state hygiene',
      created_at: iso(15),
      status: 'active',
      plan_id: 'pln_8ed15fdc',
      schema_version: 2,
    }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    const md = renderContextMarkdown(result);

    // Open work section must come before instructions
    const openWorkPos = md.indexOf('⚠ Your open work');
    const instructionsPos = md.indexOf('Instructions:');
    assert.ok(openWorkPos !== -1, 'should contain open work section');
    assert.ok(openWorkPos < instructionsPos, 'open work section must appear before instructions');
    assert.ok(md.includes('clm_test005'));
    assert.ok(md.includes('Implementing 0.6.9 state hygiene'));
    assert.ok(md.includes('release when done'));
  });

  it('renderContextMarkdown shows active assignments in open_work', () => {
    const assignment = createAssignment({
      claim_id: 'clm_test_assignment_md',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      dispatcher_agent: 'codex',
      scope: 'src/core/runtime.ts',
      description: 'Markdown assignment visibility',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'codex' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: 'testuser' }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    const md = renderContextMarkdown(result);
    assert.ok(md.includes('Active assignments (runtime state):'));
    assert.ok(md.includes(assignment.id));
    assert.ok(md.includes('Markdown assignment visibility'));
  });

  it('renderContextPromptTemplate (non-compact) includes open_work block', () => {
    saveClaim({
      id: 'clm_test006',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/core/context.ts',
      description: 'Template test claim',
      created_at: iso(5),
      status: 'active',
      schema_version: 2,
    }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    const tmpl = renderContextPromptTemplate(result, false);
    assert.ok(tmpl.includes('open_work:'));
    assert.ok(tmpl.includes('clm_test006'));
    assert.ok(tmpl.includes('Template test claim'));
  });

  it('renderContextPromptTemplate includes active_assignments block when present', () => {
    const assignment = createAssignment({
      claim_id: 'clm_test_assignment_tmpl',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      dispatcher_agent: 'codex',
      scope: 'src/core/foo.ts',
      description: 'Template assignment visibility',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'codex' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: 'testuser' }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    const tmpl = renderContextPromptTemplate(result, false);
    assert.ok(tmpl.includes('active_assignments:'));
    assert.ok(tmpl.includes(assignment.id));
    assert.ok(tmpl.includes('Template assignment visibility'));
  });

  it('renderContextPromptTemplate (compact) includes ow: block', () => {
    saveClaim({
      id: 'clm_test007',
      agent: 'testuser',
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/core/foo.ts',
      description: 'Compact template claim',
      created_at: iso(5),
      status: 'active',
      schema_version: 2,
    }, workspace.dir);

    const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
    const tmpl = renderContextPromptTemplate(result, true);
    assert.ok(tmpl.includes('ow:'));
    assert.ok(tmpl.includes('clm_test007'));
  });

  // ── pln#388 stp_aa095668: claim-state observability in context ───────────

  describe('claim liveness is surfaced (pln#388 stp_aa095668)', () => {
    it('active_claims entries carry a liveness field', () => {
      // Fresh claim with no session → should surface as "young"
      saveClaim({
        id: 'clm_liveness_young',
        agent: 'testuser',
        agent_id: workspace.currentAgent.agent_id,
        scope: 'src/core/x.ts',
        description: 'fresh claim',
        created_at: iso(5),
        status: 'active',
        schema_version: 2,
      }, workspace.dir);

      const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
      assert.ok(result.open_work);
      assert.equal(result.open_work.active_claims.length, 1);
      assert.equal(result.open_work.active_claims[0].liveness, 'young');
    });

    it('never-adopted coordinator claim surfaces with liveness="never-adopted"', () => {
      // Old claim with no session_id → never-adopted (past 24h threshold)
      saveClaim({
        id: 'clm_liveness_never',
        agent: 'testuser',
        agent_id: workspace.currentAgent.agent_id,
        scope: 'src/core/abandoned.ts',
        description: 'old coordinator claim',
        created_at: iso(60 * 30), // 30h ago
        status: 'active',
        schema_version: 2,
      }, workspace.dir);

      const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
      assert.ok(result.open_work);
      assert.equal(result.open_work.active_claims[0].liveness, 'never-adopted');
    });

    it('renderContextMarkdown tags non-healthy liveness states', () => {
      saveClaim({
        id: 'clm_md_tag',
        agent: 'testuser',
        agent_id: workspace.currentAgent.agent_id,
        scope: 'src/core/md.ts',
        description: 'stale coordinator claim',
        created_at: iso(60 * 30),
        status: 'active',
        schema_version: 2,
      }, workspace.dir);

      const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
      const md = renderContextMarkdown(result);
      assert.match(md, /\[NEVER-ADOPTED\]/, 'markdown should tag never-adopted');
    });

    it('renderContextMarkdown omits tag for healthy young claims', () => {
      saveClaim({
        id: 'clm_md_young',
        agent: 'testuser',
        agent_id: workspace.currentAgent.agent_id,
        scope: 'src/core/y.ts',
        description: 'young claim',
        created_at: iso(5),
        status: 'active',
        schema_version: 2,
      }, workspace.dir);

      const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
      const md = renderContextMarkdown(result);
      assert.ok(!/\[YOUNG\]/i.test(md), 'young claims should not be tagged in markdown (healthy)');
      assert.ok(!/\[LIVE\]/i.test(md), 'live claims should not be tagged in markdown (healthy)');
    });

    it('renderContextPromptTemplate (compact) emits lv= token for each claim', () => {
      saveClaim({
        id: 'clm_tpl_compact',
        agent: 'testuser',
        agent_id: workspace.currentAgent.agent_id,
        scope: 'src/core/t.ts',
        description: 'compact template',
        created_at: iso(60 * 30),
        status: 'active',
        schema_version: 2,
      }, workspace.dir);

      const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
      const tmpl = renderContextPromptTemplate(result, true);
      assert.match(tmpl, /lv=never-adopted/);
    });

    it('renderContextPromptTemplate (full) emits liveness= token for each claim', () => {
      saveClaim({
        id: 'clm_tpl_full',
        agent: 'testuser',
        agent_id: workspace.currentAgent.agent_id,
        scope: 'src/core/t2.ts',
        description: 'full template',
        created_at: iso(60 * 30),
        status: 'active',
        schema_version: 2,
      }, workspace.dir);

      const result = buildContext({ agent: 'testuser', cwd: workspace.dir });
      const tmpl = renderContextPromptTemplate(result, false);
      assert.match(tmpl, /liveness=never-adopted/);
    });
  });
});
