import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextDiff } from '../../src/core/context-diff.js';
import { runSessionStart } from '../../src/commands/session-start.js';
import { saveCandidate } from '../../src/core/candidates.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/context-diff', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-context-diff-',
      projectId: 'prj_context_diff_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    delete process.env.BRAINCLAW_SESSION_ID;
    workspace.cleanup();
  });

  it('returns undefined when no reference point is available', () => {
    const diff = buildContextDiff({ cwd: workspace.dir });
    assert.equal(diff, undefined);
  });

  it('builds counts and changed items from a session reference', () => {
    process.env.BRAINCLAW_SESSION_ID = 'sess_diff_core';
    runSessionStart({ context: 'auth', cwd: workspace.dir });

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [
        {
          id: 'cst_diff_core',
          text: 'Auth deploys are frozen',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_context_diff_test',
          status: 'active',
          tags: ['auth'],
        },
      ],
      recent_decisions: [
        {
          id: 'dec_diff_core',
          text: 'Auth requests now go through the gateway',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_context_diff_test',
          tags: ['auth'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);
    saveCandidate({
      id: 'cnd_diff_core',
      type: 'decision',
      text: 'Document auth rollback flow',
      created_at: new Date().toISOString(),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_context_diff_test',
      tags: ['auth'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    }, workspace.dir);

    const diff = buildContextDiff({
      session: 'sess_diff_core',
      cwd: workspace.dir,
      includeItems: true,
    });

    assert.ok(diff);
    assert.equal(diff?.since_session, 'sess_diff_core');
    assert.equal(diff?.counts.constraints, 1);
    assert.equal(diff?.counts.decisions, 1);
    assert.equal(diff?.counts.pending_candidates, 1);
    assert.equal(diff?.counts.total, 3);
    assert.ok((diff?.changed_items?.length ?? 0) >= 3);
    assert.match(diff?.summary ?? '', /constraint/);
  });
});
