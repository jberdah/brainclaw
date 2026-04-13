/**
 * Tests that session resume automatically surfaces a context_diff
 * showing what changed since the previous session.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../../src/core/context.js';
import { startSession } from '../../src/commands/session-start.js';
import { saveState } from '../../src/core/state.js';
import { loadAllSessions } from '../../src/core/identity.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('session resume: context_diff auto-surfacing', { concurrency: false }, () => {
  let workspace: TestWorkspace;
  let previousSessionId: string | undefined;
  let previousAgentName: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-resume-diff-',
      projectId: 'prj_resume_diff_test',
      currentAgent: 'copilot',
    });
    previousSessionId = process.env.BRAINCLAW_SESSION_ID;
    previousAgentName = process.env.BRAINCLAW_AGENT_NAME;
    process.env.BRAINCLAW_AGENT_NAME = workspace.currentAgent.agent_name;
    delete process.env.BRAINCLAW_AGENT;
  });

  afterEach(() => {
    if (previousSessionId === undefined) delete process.env.BRAINCLAW_SESSION_ID;
    else process.env.BRAINCLAW_SESSION_ID = previousSessionId;
    if (previousAgentName === undefined) delete process.env.BRAINCLAW_AGENT_NAME;
    else process.env.BRAINCLAW_AGENT_NAME = previousAgentName;
    workspace.cleanup();
  });

  it('includes context_diff when sinceSession points at a previous session snapshot', () => {
    // Start a first session — this creates the snapshot baseline
    process.env.BRAINCLAW_SESSION_ID = 'sess_resume_first';
    const firstSnapshot = startSession({ cwd: workspace.dir, maintenanceMode: 'fast' });
    assert.equal(firstSnapshot.session_id, 'sess_resume_first');

    // Add memory items AFTER the first session started
    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [
        {
          id: 'cst_resume_new',
          text: 'Deploy requires review approval',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_resume_diff_test',
          status: 'active',
          tags: ['deploy'],
        },
      ],
      recent_decisions: [
        {
          id: 'dec_resume_new',
          text: 'Switch to rolling deploys',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_resume_diff_test',
          tags: ['deploy'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);

    // Start a second session — this is the "resume" scenario
    process.env.BRAINCLAW_SESSION_ID = 'sess_resume_second';
    startSession({ cwd: workspace.dir, maintenanceMode: 'fast' });

    // Build context with sinceSession pointing at the first session
    const result = buildContext({
      agent: workspace.currentAgent.agent_name,
      cwd: workspace.dir,
      sinceSession: 'sess_resume_first',
    });

    // The context_diff should surface items created after the first session started
    assert.ok(result.context_diff, 'context_diff should be present when sinceSession is set');
    assert.ok(result.context_diff.counts.total >= 2, `Expected at least 2 changed items, got ${result.context_diff.counts.total}`);
    assert.ok(result.context_diff.counts.constraints >= 1);
    assert.ok(result.context_diff.counts.decisions >= 1);
    assert.ok(result.context_diff.summary.includes('constraint'));
  });

  it('buildContext exposes no context_diff when sinceSession is absent', () => {
    const result = buildContext({
      agent: workspace.currentAgent.agent_name,
      cwd: workspace.dir,
    });
    assert.equal(result.context_diff, undefined);
  });

  it('previous session lookup finds correct session for same agent', () => {
    // Simulate the lookup logic used in session-start --include-context
    process.env.BRAINCLAW_SESSION_ID = 'sess_lookup_first';
    startSession({ cwd: workspace.dir, maintenanceMode: 'fast' });

    process.env.BRAINCLAW_SESSION_ID = 'sess_lookup_second';
    const secondSnapshot = startSession({ cwd: workspace.dir, maintenanceMode: 'fast' });

    const allSessions = loadAllSessions(workspace.dir);
    const previousSession = allSessions.find(
      (s) => s.agent === secondSnapshot.agent && s.session_id !== secondSnapshot.session_id,
    );

    assert.ok(previousSession, 'Should find a previous session for the same agent');
    assert.equal(previousSession.session_id, 'sess_lookup_first');
  });
});
