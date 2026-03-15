import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSync, resolveScopePaths } from '../../src/commands/sync.js';
import { saveClaim } from '../../src/core/claims.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import { saveState } from '../../src/core/state.js';
import { saveOperationalTrap } from '../../src/core/traps.js';
import { saveCandidate } from '../../src/core/candidates.js';
import type { Candidate, State } from '../../src/core/schema.js';
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

describe('commands/sync', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-sync-',
      projectId: 'prj_sync_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('summarizes memory in summary-only mode and excludes machine-local scope by default', () => {
    const previousHost = process.env.BRAINCLAW_HOST_ID;
    process.env.BRAINCLAW_HOST_ID = 'host-a';
    try {
    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_sync',
          text: 'Test decision',
          created_at: iso(10),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_sync_test',
          tags: ['sync'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [
        {
          id: 'pln_sync',
          text: 'Sync plan',
          created_at: iso(12),
          updated_at: iso(9),
          author: workspace.currentAgent.agent_name,
          status: 'in_progress',
          priority: 'medium',
          tags: ['sync'],
          depends_on: [],
        },
      ],
    };
    saveState(state, workspace.dir);

    const pending: Candidate = {
      id: 'cnd_sync',
      type: 'decision',
      text: 'Pending candidate',
      created_at: iso(8),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_sync_test',
      tags: ['sync'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    saveCandidate(pending, workspace.dir);

    saveClaim({
      id: 'clm_sync',
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      project_id: 'prj_sync_test',
      scope: 'src/auth/',
      description: 'Sync claim',
      created_at: iso(7),
      status: 'active',
    }, workspace.dir);

    saveRuntimeNote({
      id: 'rtn_shared',
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      project_id: 'prj_sync_test',
      session_id: 'sess_shared',
      text: 'Shared note',
      created_at: iso(6),
      tags: ['sync'],
      visibility: 'shared',
      note_type: 'observation',
    }, workspace.dir);
    saveRuntimeNote({
      id: 'rtn_machine',
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      project_id: 'prj_sync_test',
      session_id: 'sess_machine',
      text: 'Machine note',
      created_at: iso(5),
      tags: ['sync'],
      visibility: 'machine',
      host_id: 'host-a',
      note_type: 'observation',
    }, workspace.dir);
    saveOperationalTrap({
      id: 'trp_machine',
      text: 'Machine trap',
      created_at: iso(4),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_sync_test',
      severity: 'medium',
      tags: ['sync'],
      visibility: 'machine',
      host_id: 'host-a',
    }, workspace.dir);

    const logs = captureLogs(() => {
      runSync({ summaryOnly: true, cwd: workspace.dir });
    });

    const joined = logs.join('\n');
    assert.match(joined, /Memory sync summary:/);
    assert.match(joined, /Pending candidates: 1/);
    assert.match(joined, /Active claims: 1/);
    assert.match(joined, /Runtime notes: 1 shared, 1 machine-local, 0 private/);
    assert.match(joined, /Local traps: 1 machine-local, 0 private/);
    assert.match(joined, /Summary-only mode enabled/);
    assert.ok(!joined.includes('.brainclaw/runtime-hosts/'));
    } finally {
      if (previousHost === undefined) {
        delete process.env.BRAINCLAW_HOST_ID;
      } else {
        process.env.BRAINCLAW_HOST_ID = previousHost;
      }
    }
  });

  it('resolves sync scopes against the workspace and can include machine-local runtime paths', () => {
    fs.mkdirSync(path.join(workspace.dir, '.brainclaw', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(workspace.dir, '.brainclaw', 'runtime-hosts'), { recursive: true });
    fs.mkdirSync(path.join(workspace.dir, '.brainclaw', 'runtime-private'), { recursive: true });

    const defaultScope = resolveScopePaths('all', false, workspace.dir);
    assert.ok(defaultScope.includes('.brainclaw/runtime/'));
    assert.ok(!defaultScope.includes('.brainclaw/runtime-hosts/'));

    const expandedScope = resolveScopePaths('all', true, workspace.dir);
    assert.ok(expandedScope.includes('.brainclaw/runtime-hosts/'));
    assert.ok(expandedScope.includes('.brainclaw/runtime-private/'));

    const runtimeLocal = resolveScopePaths('runtime-local', false, workspace.dir);
    assert.deepEqual(runtimeLocal, ['.brainclaw/runtime-hosts/', '.brainclaw/runtime-private/']);
  });
});
