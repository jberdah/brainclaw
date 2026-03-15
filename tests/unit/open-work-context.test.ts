import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../../src/core/context.js';
import { saveClaim } from '../../src/core/claims.js';
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
});
