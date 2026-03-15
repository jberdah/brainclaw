import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { endSession } from '../../src/commands/session-end.js';
import { saveClaim, listClaims } from '../../src/core/claims.js';
import { saveState } from '../../src/core/state.js';
import { runSessionStart } from '../../src/commands/session-start.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { State } from '../../src/core/schema.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('0.7.0 session-end hygiene check', () => {
  let workspace: TestWorkspace;
  let savedSessionId: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-hygiene-',
      projectId: 'prj_hygiene_test',
      currentAgent: 'copilot',
    });
    savedSessionId = process.env.BRAINCLAW_SESSION_ID;
    process.env.BRAINCLAW_SESSION_ID = 'sess_hygiene_test';
    runSessionStart({ cwd: workspace.dir });
  });

  afterEach(() => {
    if (savedSessionId === undefined) {
      delete process.env.BRAINCLAW_SESSION_ID;
    } else {
      process.env.BRAINCLAW_SESSION_ID = savedSessionId;
    }
    workspace.cleanup();
  });

  it('open_work_warning is undefined when agent has no active claims', () => {
    const result = endSession({ session: 'sess_hygiene_test', cwd: workspace.dir });
    assert.equal(result.open_work_warning, undefined);
  });

  it('detects active claim in open_work_warning', () => {
    saveClaim({
      id: 'clm_hw001',
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/core/foo.ts',
      description: 'Hygiene test claim',
      created_at: iso(20),
      status: 'active',
      schema_version: 2,
    }, workspace.dir);

    const result = endSession({ session: 'sess_hygiene_test', cwd: workspace.dir });
    assert.ok(result.open_work_warning);
    assert.equal(result.open_work_warning.active_claims.length, 1);
    assert.equal(result.open_work_warning.active_claims[0].id, 'clm_hw001');
    assert.equal(result.open_work_warning.active_claims[0].description, 'Hygiene test claim');
    assert.equal(result.open_work_warning.auto_released, false);
  });

  it('detects in_progress plan by assignee in open_work_warning', () => {
    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [],
      plan_items: [
        {
          id: 'pln_hw001',
          text: 'Hygiene plan item',
          status: 'in_progress',
          priority: 'medium',
          tags: [],
          assignee: workspace.currentAgent.agent_name,
          author: workspace.currentAgent.agent_name,
          created_at: iso(60),
          updated_at: iso(60),
          depends_on: [],
        },
      ],
    };
    saveState(state, workspace.dir);

    const result = endSession({ session: 'sess_hygiene_test', cwd: workspace.dir });
    assert.ok(result.open_work_warning);
    assert.equal(result.open_work_warning.in_progress_plans.length, 1);
    assert.equal(result.open_work_warning.in_progress_plans[0].id, 'pln_hw001');
  });

  it('auto-release releases claims when --auto-release is set', () => {
    saveClaim({
      id: 'clm_hw002',
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      scope: 'src/core/bar.ts',
      description: 'Auto-release test claim',
      created_at: iso(10),
      status: 'active',
      schema_version: 2,
    }, workspace.dir);

    const result = endSession({ session: 'sess_hygiene_test', autoRelease: true, cwd: workspace.dir });
    assert.ok(result.open_work_warning);
    assert.equal(result.open_work_warning.auto_released, true);

    // Claim should now be released
    const claims = listClaims(workspace.dir);
    const claim = claims.find((c) => c.id === 'clm_hw002');
    assert.ok(claim);
    assert.equal(claim.status, 'released');
  });

  it('does not include claims from other agents', () => {
    saveClaim({
      id: 'clm_hw003',
      agent: 'someother',
      agent_id: 'agt_someother',
      scope: 'src/core/baz.ts',
      description: 'Other agent claim',
      created_at: iso(10),
      status: 'active',
      schema_version: 2,
    }, workspace.dir);

    const result = endSession({ session: 'sess_hygiene_test', cwd: workspace.dir });
    assert.equal(result.open_work_warning, undefined);
  });
});
