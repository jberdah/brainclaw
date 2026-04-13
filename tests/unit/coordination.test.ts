import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { archiveCandidate } from '../../src/core/candidates.js';
import { createActionRequired } from '../../src/core/actions.js';
import { saveClaim } from '../../src/core/claims.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { createAgentRun, transitionAgentRun } from '../../src/core/agentruns.js';
import { buildCoordinationSnapshot } from '../../src/core/coordination.js';
import { createInstruction } from '../../src/core/instructions.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import { createSequence } from '../../src/core/sequence.js';
import { saveState } from '../../src/core/state.js';
import { loadState } from '../../src/core/state.js';
import type { Candidate, Claim, RuntimeNote, State } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('core/coordination', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-coordination-',
      projectId: 'prj_coordination_test',
      currentAgent: 'copilot',
      knownProjects: ['auth'],
      reputationEnabled: true,
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('builds an agent board snapshot filtered by project, agent, and host', () => {
    const copilot = workspace.currentAgent;
    const claude = workspace.registerAgent('claude');

    createInstruction('Always read project memory first', {
      layer: 'global',
      author: copilot.agent_name,
    }, workspace.dir);
    createInstruction('Prefer auth gateway conventions', {
      layer: 'project',
      scope: 'auth',
      author: copilot.agent_name,
    }, workspace.dir);
    createInstruction('Copilot owns rollout continuity', {
      layer: 'agent',
      scope: copilot.agent_name,
      author: copilot.agent_name,
    }, workspace.dir);

    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [
        {
          id: 'hnd_auth',
          from: copilot.agent_name,
          to: claude.agent_name,
          text: 'Review auth patch',
          created_at: iso(15),
          author: copilot.agent_name,
          author_id: copilot.agent_id,
          project_id: 'prj_coordination_test',
          status: 'open',
          project: 'auth',
          plan_id: 'pln_auth',
          tags: ['auth'],
        },
        {
          id: 'hnd_payments',
          from: 'human-review',
          to: claude.agent_name,
          text: 'Review payments patch',
          created_at: iso(14),
          author: 'human-review',
          project_id: 'prj_coordination_test',
          status: 'open',
          project: 'payments',
          tags: ['payments'],
        },
      ],
      plan_items: [
        {
          id: 'pln_auth',
          text: 'Own auth rollout',
          created_at: iso(20),
          updated_at: iso(10),
          author: copilot.agent_name,
          status: 'in_progress',
          priority: 'high',
          assignee: copilot.agent_name,
          project: 'auth',
          tags: ['auth'],
          depends_on: [],
        },
        {
          id: 'pln_payments',
          text: 'Own payments rollout',
          created_at: iso(21),
          updated_at: iso(11),
          author: copilot.agent_name,
          status: 'todo',
          priority: 'medium',
          assignee: claude.agent_name,
          project: 'payments',
          tags: ['payments'],
          depends_on: [],
        },
      ],
    };
    saveState(state, workspace.dir);

    const claims: Claim[] = [
      {
        id: 'clm_auth',
        agent: copilot.agent_name,
        agent_id: copilot.agent_id,
        project_id: 'prj_coordination_test',
        scope: 'src/auth/',
        description: 'Taking auth rollout',
        created_at: iso(13),
        project: 'auth',
        plan_id: 'pln_auth',
        status: 'active',
      },
      {
        id: 'clm_payments',
        agent: claude.agent_name,
        agent_id: claude.agent_id,
        project_id: 'prj_coordination_test',
        scope: 'src/payments/',
        description: 'Taking payments rollout',
        created_at: iso(12),
        project: 'payments',
        plan_id: 'pln_payments',
        status: 'active',
      },
    ];
    for (const claim of claims) {
      saveClaim(claim, workspace.dir);
    }
    const assignment = createAssignment({
      claim_id: 'clm_auth',
      plan_id: 'pln_auth',
      sequence_id: 'seq_auth_runtime',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      dispatcher_agent: 'codex',
      scope: 'src/auth/',
      description: 'Auth runtime assignment',
    }, workspace.dir);
    transitionAssignment(assignment.id, 'offered', { actor: 'codex' }, workspace.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: copilot.agent_name, session_id: 'sess_assignment' }, workspace.dir);
    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: 'clm_auth',
      plan_id: 'pln_auth',
      sequence_id: 'seq_auth_runtime',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      transport: 'manual_command',
      scope: 'src/auth/',
      description: 'Auth runtime pickup',
    }, workspace.dir);
    transitionAgentRun(run.id, 'waiting_input', { actor: 'codex' }, workspace.dir);
    const action = createActionRequired({
      assignment_id: assignment.id,
      run_id: run.id,
      claim_id: 'clm_auth',
      plan_id: 'pln_auth',
      sequence_id: 'seq_auth_runtime',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      session_id: 'sess_assignment',
      kind: 'clarification',
      scope: 'src/auth/',
      title: 'Clarify auth rollout',
      prompt: 'Need approval on rollout sequencing',
      options: ['approve', 'revise'],
    }, workspace.dir);

    const notes: RuntimeNote[] = [
      {
        id: 'rtn_auth_shared',
        agent: copilot.agent_name,
        agent_id: copilot.agent_id,
        project_id: 'prj_coordination_test',
        session_id: 'sess_shared',
        text: 'Started auth rollout',
        created_at: iso(11),
        project: 'auth',
        plan_id: 'pln_auth',
        tags: ['auth'],
        visibility: 'shared',
        note_type: 'observation',
      },
      {
        id: 'rtn_auth_host_a',
        agent: copilot.agent_name,
        agent_id: copilot.agent_id,
        project_id: 'prj_coordination_test',
        session_id: 'sess_host_a',
        text: 'Host A auth note',
        created_at: iso(10),
        project: 'auth',
        tags: ['auth'],
        visibility: 'machine',
        host_id: 'host-a',
        note_type: 'observation',
      },
      {
        id: 'rtn_auth_host_b',
        agent: copilot.agent_name,
        agent_id: copilot.agent_id,
        project_id: 'prj_coordination_test',
        session_id: 'sess_host_b',
        text: 'Host B auth note',
        created_at: iso(9),
        project: 'auth',
        tags: ['auth'],
        visibility: 'machine',
        host_id: 'host-b',
        note_type: 'observation',
      },
      {
        id: 'rtn_payments',
        agent: copilot.agent_name,
        agent_id: copilot.agent_id,
        project_id: 'prj_coordination_test',
        session_id: 'sess_payments',
        text: 'Payments note',
        created_at: iso(8),
        project: 'payments',
        tags: ['payments'],
        visibility: 'shared',
        note_type: 'observation',
      },
    ];
    for (const note of notes) {
      saveRuntimeNote(note, workspace.dir);
    }

    createSequence({
      name: 'post-gpt4-review',
      status: 'active',
      author: copilot.agent_name,
      owner: copilot.agent_name,
      items: [
        { planId: 'PROJECT.md', rank: 1, lane: 'vision' },
        { planId: 'constraint-categorization', rank: 2, lane: 'export-foundation' },
        { planId: 'context-metrics', rank: 3, lane: 'hooks' },
        {
          planId: 'export-restructure',
          rank: 4,
          lane: 'export-foundation',
          hard_after: ['PROJECT.md', 'constraint-categorization'],
        },
        {
          planId: 'tier-reclassification',
          rank: 5,
          lane: 'export-foundation',
          soft_after: ['export-restructure'],
        },
      ],
    }, workspace.dir);

    const accepted: Candidate = {
      id: 'cnd_copilot_accepted',
      type: 'decision',
      text: 'Accepted auth improvement',
      created_at: iso(18),
      author: copilot.agent_name,
      author_id: copilot.agent_id,
      project_id: 'prj_coordination_test',
      tags: ['auth'],
      status: 'accepted',
      star_count: 1,
      starred_by: ['claude'],
      usage_count: 1,
      usage_events: [{ by: 'claude', context: 'auth rollout', created_at: iso(6) }],
      resolved_at: iso(5),
      resolved_by: claude.agent_name,
    };
    archiveCandidate(accepted, 'accepted', workspace.dir);

    const board = buildCoordinationSnapshot({
      target: 'auth/routes.ts',
      agent: copilot.agent_name,
      host: 'host-a',
      includeReputation: true,
      cwd: workspace.dir,
    });

    assert.equal(board.project, 'auth');
    assert.equal(board.agent, copilot.agent_name);
    assert.equal(board.agent_id, copilot.agent_id);
    assert.equal(board.active_plans.length, 1);
    assert.equal(board.active_plans[0].id, 'pln_auth');
    assert.equal(board.active_plans[0].claims.length, 1);
    assert.equal(board.active_claims.length, 1);
    assert.equal(board.active_claims[0].id, 'clm_auth');
    assert.equal(board.active_assignments.length, 1);
    assert.equal(board.active_assignments[0].id, assignment.id);
    assert.equal(board.active_assignments[0].status, 'accepted');
    assert.equal(board.active_runs.length, 1);
    assert.equal(board.active_runs[0].id, run.id);
    assert.equal(board.active_runs[0].status, 'waiting_input');
    assert.equal(board.active_actions.length, 1);
    assert.equal(board.active_actions[0].id, action.id);
    assert.equal(board.active_actions[0].kind, 'clarification');
    assert.equal(board.active_sequence?.name, 'post-gpt4-review');
    assert.equal(board.active_sequence?.items[0].lane, 'vision');
    assert.deepEqual(board.active_sequence?.items[3].hard_after, ['PROJECT.md', 'constraint-categorization']);
    assert.deepEqual(board.active_sequence?.items[4].soft_after, ['export-restructure']);
    assert.equal(board.runtime_notes.length, 2);
    assert.deepEqual(
      board.runtime_notes.map((note) => note.id),
      ['rtn_auth_shared', 'rtn_auth_host_a'],
    );
    assert.equal(board.open_handoffs.length, 1);
    assert.equal(board.open_handoffs[0].id, 'hnd_auth');
    assert.deepEqual(
      board.resolved_instructions.map((instruction) => instruction.text),
      [
        'Always read project memory first',
        'Prefer auth gateway conventions',
        'Copilot owns rollout continuity',
      ],
    );
    assert.ok(board.reputation_summary);
    assert.equal(board.reputation_summary?.enabled, true);
    assert.ok(board.agent_reputation);
    assert.equal(board.agent_reputation?.agent_name, copilot.agent_name);
  });

  it('perf.3: filters session_start/session_end notes by default', () => {
    const copilot = workspace.currentAgent;

    saveRuntimeNote({
      id: 'rtn_obs',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      project_id: 'prj_coordination_test',
      session_id: 'sess_a',
      text: 'Real observation',
      created_at: iso(5),
      tags: [],
      visibility: 'shared',
      note_type: 'observation',
    }, workspace.dir);
    saveRuntimeNote({
      id: 'rtn_start',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      project_id: 'prj_coordination_test',
      session_id: 'sess_a',
      text: 'Session started',
      created_at: iso(6),
      tags: ['session'],
      visibility: 'shared',
      note_type: 'session_start',
    }, workspace.dir);
    saveRuntimeNote({
      id: 'rtn_end',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      project_id: 'prj_coordination_test',
      session_id: 'sess_a',
      text: 'Session ended',
      created_at: iso(4),
      tags: ['session'],
      visibility: 'shared',
      note_type: 'session_end',
    }, workspace.dir);

    const boardDefault = buildCoordinationSnapshot({ cwd: workspace.dir });
    assert.equal(boardDefault.runtime_notes.length, 1);
    assert.equal(boardDefault.runtime_notes[0].id, 'rtn_obs');
    assert.equal(boardDefault.session_meta_hidden, 2);

    const boardWithMeta = buildCoordinationSnapshot({ includeSessionMeta: true, cwd: workspace.dir });
    assert.equal(boardWithMeta.runtime_notes.length, 3);
    assert.equal(boardWithMeta.session_meta_hidden, 0);
  });

  it('perf.2: auto-acknowledges open handoffs when autoAcknowledge is true', () => {
    const copilot = workspace.currentAgent;
    const claude = workspace.registerAgent('claude');

    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [
        {
          id: 'hnd_ack_1',
          from: copilot.agent_name,
          to: claude.agent_name,
          text: 'Review this',
          created_at: iso(10),
          author: copilot.agent_name,
          status: 'open',
          tags: [],
        },
        {
          id: 'hnd_ack_2',
          from: copilot.agent_name,
          to: claude.agent_name,
          text: 'Also review this',
          created_at: iso(9),
          author: copilot.agent_name,
          status: 'open',
          tags: [],
        },
      ],
      plan_items: [],
    };
    saveState(state, workspace.dir);

    const board = buildCoordinationSnapshot({
      agent: claude.agent_name,
      autoAcknowledge: true,
      cwd: workspace.dir,
    });

    // Both handoffs were shown to the agent
    assert.equal(board.open_handoffs.length, 2);

    // After the call, both should be marked accepted in persisted state
    const updated = loadState(workspace.dir);
    const statuses = updated.open_handoffs.map((h) => h.status);
    assert.ok(statuses.every((s) => s === 'accepted'), `Expected all accepted, got: ${statuses.join(', ')}`);
  });

  it('perf.2: without autoAcknowledge, handoffs remain open', () => {
    const copilot = workspace.currentAgent;

    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [
        {
          id: 'hnd_noack',
          from: copilot.agent_name,
          to: copilot.agent_name,
          text: 'Keep open',
          created_at: iso(5),
          author: copilot.agent_name,
          status: 'open',
          tags: [],
        },
      ],
      plan_items: [],
    };
    saveState(state, workspace.dir);

    buildCoordinationSnapshot({ cwd: workspace.dir });

    const updated = loadState(workspace.dir);
    assert.equal(updated.open_handoffs[0].status, 'open');
  });

  it('can inspect host-scoped runtime notes across all hosts explicitly', () => {
    const copilot = workspace.currentAgent;

    saveRuntimeNote({
      id: 'rtn_host_a',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      project_id: 'prj_coordination_test',
      session_id: 'sess_host_a',
      text: 'Host A note',
      created_at: iso(6),
      project: 'auth',
      tags: ['auth'],
      visibility: 'machine',
      host_id: 'host-a',
      note_type: 'observation',
    }, workspace.dir);
    saveRuntimeNote({
      id: 'rtn_host_b',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      project_id: 'prj_coordination_test',
      session_id: 'sess_host_b',
      text: 'Host B note',
      created_at: iso(5),
      project: 'auth',
      tags: ['auth'],
      visibility: 'machine',
      host_id: 'host-b',
      note_type: 'observation',
    }, workspace.dir);

    const board = buildCoordinationSnapshot({
      project: 'auth',
      agent: copilot.agent_name,
      host: 'host-a',
      allHosts: true,
      cwd: workspace.dir,
    });

    assert.equal(board.all_hosts, true);
    assert.deepEqual(
      board.runtime_notes.map((note) => note.id),
      ['rtn_host_a', 'rtn_host_b'],
    );
  });

  it('enriches sequence items with step-level status and text when stepId is set', () => {
    const copilot = workspace.currentAgent;

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [],
      plan_items: [
        {
          id: 'pln_auth',
          text: 'Own auth rollout',
          created_at: iso(15),
          updated_at: iso(5),
          author: copilot.agent_name,
          status: 'in_progress',
          priority: 'high',
          assignee: copilot.agent_name,
          tags: ['auth'],
          depends_on: [],
          steps: [
            {
              id: 'stp_done',
              text: 'Ship login route',
              status: 'done',
              created_at: iso(14),
              updated_at: iso(4),
            },
            {
              id: 'stp_todo',
              text: 'Implement session refresh flow',
              status: 'todo',
              created_at: iso(13),
              updated_at: iso(3),
            },
          ],
        },
      ],
    }, workspace.dir);

    createSequence({
      name: 'step-aware-sequence',
      status: 'active',
      author: copilot.agent_name,
      owner: copilot.agent_name,
      items: [
        { planId: 'pln_auth', stepId: 'stp_done', rank: 1, lane: 'lane-a' },
        { planId: 'pln_auth', stepId: 'stp_todo', rank: 2, lane: 'lane-b' },
      ],
    }, workspace.dir);

    const board = buildCoordinationSnapshot({ cwd: workspace.dir });
    const items = board.active_sequence?.items ?? [];
    assert.equal(items.length, 2);

    // Items are enriched at runtime with plan_status/plan_text via spread
    const item0 = items[0] as Record<string, unknown>;
    const item1 = items[1] as Record<string, unknown>;

    assert.equal(item0.stepId, 'stp_done');
    assert.equal(item0.plan_status, 'done');
    assert.equal(item0.plan_text, 'Ship login route');

    assert.equal(item1.stepId, 'stp_todo');
    assert.equal(item1.plan_status, 'in_progress');
    assert.equal(item1.plan_text, 'Implement session refresh flow');
  });
});
