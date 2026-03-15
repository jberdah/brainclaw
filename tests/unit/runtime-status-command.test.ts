import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runRuntimeStatus } from '../../src/commands/runtime-status.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import type { RuntimeNote } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function captureLogs(fn: () => void): string[] {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    throw new Error(args.map(String).join(' '));
  };

  try {
    fn();
    return logs;
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('commands/runtime-status', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-runtime-status-',
      projectId: 'prj_runtime_status_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('filters runtime notes by agent, plan, and host in JSON mode', () => {
    const notes: RuntimeNote[] = [
      {
        id: 'rtn_shared_plan',
        agent: 'copilot',
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_runtime_status_test',
        session_id: 'sess_shared',
        text: 'Shared plan note',
        created_at: iso(6),
        plan_id: 'pln_auth',
        tags: ['auth'],
        visibility: 'shared',
        note_type: 'observation',
      },
      {
        id: 'rtn_host_a',
        agent: 'copilot',
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_runtime_status_test',
        session_id: 'sess_host_a',
        text: 'Host A note',
        created_at: iso(5),
        tags: ['auth'],
        visibility: 'machine',
        host_id: 'host-a',
        note_type: 'observation',
      },
      {
        id: 'rtn_host_b',
        agent: 'copilot',
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_runtime_status_test',
        session_id: 'sess_host_b',
        text: 'Host B note',
        created_at: iso(4),
        tags: ['auth'],
        visibility: 'machine',
        host_id: 'host-b',
        note_type: 'observation',
      },
      {
        id: 'rtn_other_agent',
        agent: 'claude',
        project_id: 'prj_runtime_status_test',
        session_id: 'sess_other',
        text: 'Other agent note',
        created_at: iso(3),
        tags: ['other'],
        visibility: 'shared',
        note_type: 'observation',
      },
    ];
    for (const note of notes) {
      saveRuntimeNote(note, workspace.dir);
    }

    const byPlanLogs = captureLogs(() => {
      runRuntimeStatus({ json: true, plan: 'pln_auth', cwd: workspace.dir });
    });
    const byPlan = JSON.parse(byPlanLogs.at(-1) as string);
    assert.deepEqual(byPlan.map((note: { id: string }) => note.id), ['rtn_shared_plan']);

    const byAgentLogs = captureLogs(() => {
      runRuntimeStatus({ json: true, agent: 'claude', cwd: workspace.dir });
    });
    const byAgent = JSON.parse(byAgentLogs.at(-1) as string);
    assert.deepEqual(byAgent.map((note: { id: string }) => note.id), ['rtn_other_agent']);

    const hostFilteredLogs = captureLogs(() => {
      runRuntimeStatus({ json: true, visibility: 'machine', host: 'host-a', cwd: workspace.dir });
    });
    const hostFiltered = JSON.parse(hostFilteredLogs.at(-1) as string);
    assert.deepEqual(hostFiltered.map((note: { id: string }) => note.id), ['rtn_host_a']);

    const allHostsLogs = captureLogs(() => {
      runRuntimeStatus({ json: true, visibility: 'machine', host: 'host-a', allHosts: true, cwd: workspace.dir });
    });
    const allHosts = JSON.parse(allHostsLogs.at(-1) as string);
    assert.deepEqual(allHosts.map((note: { id: string }) => note.id), ['rtn_host_a', 'rtn_host_b']);
  });
});
