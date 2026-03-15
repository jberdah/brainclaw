import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInstruction } from '../../src/core/instructions.js';
import { archiveCandidate, saveCandidate } from '../../src/core/candidates.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../../src/core/context.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import { saveState } from '../../src/core/state.js';
import { saveOperationalTrap } from '../../src/core/traps.js';
import type { Candidate, RuntimeNote, State } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('core/context', () => {
  let workspace: TestWorkspace;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-context-',
      projectId: 'prj_ctx_test',
      knownProjects: ['auth'],
      reputationEnabled: true,
    });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
  });

  it('builds context with layered instructions, pending candidates, and resume summary', () => {
    const currentAgent = workspace.currentAgent;
    const openclaw = workspace.registerAgent('openclaw');

    createInstruction('Always read project memory before edits', {
      layer: 'global',
      author: currentAgent.agent_name,
    }, workspace.dir);
    createInstruction('Prefer auth gateway conventions', {
      layer: 'project',
      scope: 'auth',
      author: currentAgent.agent_name,
    }, workspace.dir);
    createInstruction('OpenClaw must summarize blockers explicitly', {
      layer: 'agent',
      scope: openclaw.agent_name,
      author: currentAgent.agent_name,
    }, workspace.dir);

    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_auth_context',
          text: 'Auth gateway now handles token validation',
          created_at: iso(40),
          author: currentAgent.agent_name,
          author_id: currentAgent.agent_id,
          project_id: 'prj_ctx_test',
          host_id: 'host-a',
          session_id: 'sess_ctx_decision',
          related_paths: ['auth/routes.ts'],
          tags: ['auth'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [
        {
          id: 'pln_auth_context',
          text: 'Ship auth gateway rollout',
          created_at: iso(50),
          updated_at: iso(30),
          author: currentAgent.agent_name,
          status: 'in_progress',
          priority: 'high',
          project: 'auth',
          tags: ['auth'],
          related_paths: ['auth/**'],
          depends_on: [],
        },
      ],
    };
    saveState(state, workspace.dir);

    const pending: Candidate = {
      id: 'cnd_auth_pending',
      type: 'decision',
      text: 'Document auth gateway rollback criteria',
      created_at: iso(15),
      author: currentAgent.agent_name,
      author_id: currentAgent.agent_id,
      project_id: 'prj_ctx_test',
      host_id: 'host-a',
      session_id: 'sess_ctx_pending',
      tags: ['auth'],
      status: 'pending',
      related_paths: ['auth/**'],
      star_count: 2,
      starred_by: ['alice', 'bob'],
      usage_count: 1,
      usage_events: [{ by: 'alice', context: 'auth rollout', created_at: iso(10) }],
    };
    saveCandidate(pending, workspace.dir);

    const accepted: Candidate = {
      ...pending,
      id: 'cnd_auth_accepted',
      text: 'Persist auth gateway findings in canonical memory',
      created_at: iso(25),
      status: 'accepted',
      source: 'runtime-note:testuser:rtn_auth_resume',
      resolved_at: iso(5),
      resolved_by: currentAgent.agent_name,
      resolution_reason: 'Useful and durable.',
    };
    archiveCandidate(accepted, 'accepted', workspace.dir);

    const runtimeNote: RuntimeNote = {
      id: 'rtn_auth_resume',
      agent: currentAgent.agent_name,
      agent_id: currentAgent.agent_id,
      project_id: 'prj_ctx_test',
      session_id: 'sess_ctx_runtime',
      text: 'Observed auth retries during gateway rollout',
      created_at: iso(12),
      project: 'auth',
      plan_id: 'pln_auth_context',
      tags: ['auth', 'gateway'],
      visibility: 'shared',
      host_id: 'host-a',
      note_type: 'observation',
    };
    saveRuntimeNote(runtimeNote, workspace.dir);

    const result = buildContext({
      target: 'auth/routes.ts',
      agent: openclaw.agent_name,
      includePending: true,
      maxItems: 6,
    });

    assert.equal(result.project, 'auth');
    assert.equal(result.agent, openclaw.agent_name);
    assert.equal(result.agent_id, openclaw.agent_id);
    assert.ok(result.resume_summary);
    assert.equal(result.resume_summary?.agent_name, currentAgent.agent_name);
    assert.ok(result.resume_summary && result.resume_summary.internal_trust > 0);
    assert.deepEqual(
      result.resolved_instructions.map((item) => item.text),
      [
        'Always read project memory before edits',
        'Prefer auth gateway conventions',
        'OpenClaw must summarize blockers explicitly',
      ],
    );
    assert.ok(result.selected.some((item) => item.section === 'candidate' && item.id === pending.id));

    const runtimeItem = result.selected.find((item) => item.section === 'runtime');
    assert.ok(runtimeItem);
    assert.equal(runtimeItem?.provenance?.session_id, 'sess_ctx_runtime');

    const markdown = renderContextMarkdown(result, true);
    assert.match(markdown, /Resume summary for testuser:/);
    assert.match(markdown, /Instructions:/);
    assert.match(markdown, /\{why:/);

    const template = renderContextPromptTemplate(result);
    assert.match(template, /```memory-context/);
    assert.match(template, /resume_summary:/);
    assert.match(template, /instructions:/);
  });

  it('keeps semantic matches ahead of higher-trust but irrelevant memory', () => {
    const trusted = workspace.registerAgent('trusted-bot');
    const novice = workspace.registerAgent('novice-bot');

    for (const index of [1, 2, 3]) {
      archiveCandidate({
        id: `cnd_trusted_${index}`,
        type: 'decision',
        text: `Trusted signal ${index}`,
        created_at: iso(20 + index),
        author: trusted.agent_name,
        author_id: trusted.agent_id,
        project_id: 'prj_ctx_test',
        tags: ['ops'],
        status: 'accepted',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
        resolved_at: iso(5),
        resolved_by: workspace.currentAgent.agent_name,
      }, 'accepted', workspace.dir);
    }

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_trusted_queue',
          text: 'Queue worker rollout step trusted',
          created_at: iso(8),
          author: trusted.agent_name,
          author_id: trusted.agent_id,
          project_id: 'prj_ctx_test',
          tags: ['queue'],
        },
        {
          id: 'dec_novice_auth',
          text: 'Auth gateway token validation',
          created_at: iso(7),
          author: novice.agent_name,
          author_id: novice.agent_id,
          project_id: 'prj_ctx_test',
          tags: ['auth'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);

    const result = buildContext({ target: 'auth', maxItems: 3 });
    assert.equal(result.selected[0].text, 'Auth gateway token validation');
    assert.ok(result.selected[0].reasons.some((reason) => reason.includes('auth')));
  });

  it('uses bounded trust bonus to break otherwise similar ties', () => {
    const trusted = workspace.registerAgent('trusted-bot');
    const novice = workspace.registerAgent('novice-bot');

    for (const index of [1, 2, 3]) {
      archiveCandidate({
        id: `cnd_queue_trusted_${index}`,
        type: 'decision',
        text: `Trusted queue signal ${index}`,
        created_at: iso(25 + index),
        author: trusted.agent_name,
        author_id: trusted.agent_id,
        project_id: 'prj_ctx_test',
        tags: ['queue'],
        status: 'accepted',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
        resolved_at: iso(6),
        resolved_by: workspace.currentAgent.agent_name,
      }, 'accepted', workspace.dir);
    }

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_queue_trusted',
          text: 'Queue worker rollout step',
          created_at: iso(8),
          author: trusted.agent_name,
          author_id: trusted.agent_id,
          project_id: 'prj_ctx_test',
          tags: ['queue'],
        },
        {
          id: 'dec_queue_novice',
          text: 'Queue worker rollout step',
          created_at: iso(7),
          author: novice.agent_name,
          author_id: novice.agent_id,
          project_id: 'prj_ctx_test',
          tags: ['queue'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);

    const result = buildContext({ target: 'queue', maxItems: 2 });
    assert.equal(result.selected[0].provenance?.actor, trusted.agent_name);
    assert.ok(result.selected[0].reasons.some((reason) => reason.includes('reputation signal')));
  });

  it('filters machine-local runtime signals by host and applies character budgets', () => {
    const restoreHost = workspace.setHostId('host-a');

    try {
      saveRuntimeNote({
        id: 'rtn_host_a',
        agent: workspace.currentAgent.agent_name,
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_ctx_test',
        session_id: 'sess_host_a',
        text: 'Local npm workaround on host A',
        created_at: iso(9),
        tags: ['windows', 'npm'],
        visibility: 'machine',
        host_id: 'host-a',
        note_type: 'observation',
      }, workspace.dir);
      saveRuntimeNote({
        id: 'rtn_host_b',
        agent: workspace.currentAgent.agent_name,
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_ctx_test',
        session_id: 'sess_host_b',
        text: 'Remote npm workaround on host B',
        created_at: iso(8),
        tags: ['windows', 'npm'],
        visibility: 'machine',
        host_id: 'host-b',
        note_type: 'observation',
      }, workspace.dir);
      saveOperationalTrap({
        id: 'trp_host_a',
        text: 'Windows npm path workaround',
        created_at: iso(7),
        author: workspace.currentAgent.agent_name,
        author_id: workspace.currentAgent.agent_id,
        project_id: 'prj_ctx_test',
        severity: 'medium',
        tags: ['windows'],
        visibility: 'machine',
        host_id: 'host-a',
      }, workspace.dir);

      const localOnly = buildContext({ target: 'npm windows', maxItems: 5 });
      const localTexts = localOnly.selected.map((item) => item.text);
      assert.ok(localTexts.includes('Local npm workaround on host A'));
      assert.ok(localTexts.includes('Windows npm path workaround'));
      assert.ok(!localTexts.includes('Remote npm workaround on host B'));

      const allHosts = buildContext({ target: 'npm windows', allHosts: true, maxItems: 5 });
      assert.ok(allHosts.selected.some((item) => item.text === 'Remote npm workaround on host B'));

      saveState({
        version: 1,
        write_version: 1,
        active_constraints: [],
        recent_decisions: [
          {
            id: 'dec_long_1',
            text: 'A very long auth decision that should consume most of the available character budget',
            created_at: iso(6),
            author: workspace.currentAgent.agent_name,
            author_id: workspace.currentAgent.agent_id,
            project_id: 'prj_ctx_test',
            tags: ['auth'],
          },
          {
            id: 'dec_long_2',
            text: 'Another auth decision that should be excluded when the context payload is tightly bounded',
            created_at: iso(5),
            author: workspace.currentAgent.agent_name,
            author_id: workspace.currentAgent.agent_id,
            project_id: 'prj_ctx_test',
            tags: ['auth'],
          },
        ],
        known_traps: [],
        open_handoffs: [],
        plan_items: [],
      }, workspace.dir);

      const budgeted = buildContext({ target: 'auth', maxChars: 120, maxItems: 5 });
      assert.equal(budgeted.selected.length, 1);
    } finally {
      restoreHost();
    }
  });
});
