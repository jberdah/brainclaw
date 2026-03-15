import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSessionEnd } from '../../src/commands/session-end.js';
import { loadSessionSnapshot, runSessionStart } from '../../src/commands/session-start.js';
import { listCandidates } from '../../src/core/candidates.js';
import { buildContext } from '../../src/core/context.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

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

function createHash(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const chr = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('session commands', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-session-',
      projectId: 'prj_session_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('starts a session by storing a snapshot and a session_start runtime note', () => {
    const previousSession = process.env.BRAINCLAW_SESSION_ID;
    process.env.BRAINCLAW_SESSION_ID = 'sess_start_test';
    try {
      saveState({
        version: 1,
        write_version: 1,
        active_constraints: [],
        recent_decisions: [
          {
            id: 'dec_session',
            text: 'Auth gateway routes OAuth',
            created_at: new Date().toISOString(),
            author: workspace.currentAgent.agent_name,
            author_id: workspace.currentAgent.agent_id,
            project_id: 'prj_session_test',
            tags: ['auth'],
          },
        ],
        known_traps: [],
        open_handoffs: [],
        plan_items: [],
      }, workspace.dir);

      const logs = captureLogs(() => {
        runSessionStart({ context: 'auth', cwd: workspace.dir });
      });

      assert.ok(logs[0].includes('Session started: sess_start_test'));
      const snapshot = loadSessionSnapshot('sess_start_test', workspace.dir);
      assert.ok(snapshot);
      assert.equal(snapshot?.agent, workspace.currentAgent.agent_name);
      assert.equal(snapshot?.context_target, 'auth');
      assert.ok(snapshot?.initial_context_hash);

      const sessionDir = path.join(workspace.dir, '.brainclaw', 'runtime', workspace.currentAgent.agent_name);
      const sessionNotes = fs.readdirSync(sessionDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf-8')));
      assert.ok(sessionNotes.some((note) => note.note_type === 'session_start' && note.session_id === 'sess_start_test'));
    } finally {
      if (previousSession === undefined) {
        delete process.env.BRAINCLAW_SESSION_ID;
      } else {
        process.env.BRAINCLAW_SESSION_ID = previousSession;
      }
    }
  });

  it('ends a session, reports context drift, and auto-reflects observation notes', () => {
    const previousSession = process.env.BRAINCLAW_SESSION_ID;
    process.env.BRAINCLAW_SESSION_ID = 'sess_end_test';
    try {
      captureLogs(() => {
        runSessionStart({ context: 'auth', cwd: workspace.dir });
      });

      saveRuntimeNote({
        id: 'rtn_session_obs',
        agent: workspace.currentAgent.agent_name,
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_session_test',
        session_id: 'sess_end_test',
        text: 'Observed auth rollout insight',
        created_at: new Date().toISOString(),
        tags: ['auth'],
        visibility: 'shared',
        note_type: 'observation',
      }, workspace.dir);

      saveState({
        version: 1,
        write_version: 1,
        active_constraints: [],
        recent_decisions: [
          {
            id: 'dec_session_end',
            text: 'Auth context changed during session',
            created_at: new Date().toISOString(),
            author: workspace.currentAgent.agent_name,
            author_id: workspace.currentAgent.agent_id,
            project_id: 'prj_session_test',
            tags: ['auth'],
          },
        ],
        known_traps: [],
        open_handoffs: [],
        plan_items: [],
      }, workspace.dir);

      const logs = captureLogs(() => {
        runSessionEnd({ session: 'sess_end_test', autoReflect: true, cwd: workspace.dir });
      });

      assert.ok(logs[0].includes('Session ended: sess_end_test'));
      assert.ok(logs.some((line) => line.includes('Candidates created from auto-reflect: 1')));
      assert.ok(logs.some((line) => line.includes('Context changed since session start')));

      const pending = listCandidates('pending', workspace.dir);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].text, 'Observed auth rollout insight');
      assert.equal(pending[0].session_id, 'sess_end_test');
    } finally {
      if (previousSession === undefined) {
        delete process.env.BRAINCLAW_SESSION_ID;
      } else {
        process.env.BRAINCLAW_SESSION_ID = previousSession;
      }
    }
  });

  it('supports JSON session start/end flows without auto-reflect when context stays stable', () => {
    const previousSession = process.env.BRAINCLAW_SESSION_ID;
    process.env.BRAINCLAW_SESSION_ID = 'sess_json_test';
    try {
      saveState({
        version: 1,
        write_version: 1,
        active_constraints: [],
        recent_decisions: [
          {
            id: 'dec_session_json',
            text: 'Stable auth gateway context',
            created_at: new Date().toISOString(),
            author: workspace.currentAgent.agent_name,
            author_id: workspace.currentAgent.agent_id,
            project_id: 'prj_session_test',
            tags: ['auth'],
          },
        ],
        known_traps: [],
        open_handoffs: [],
        plan_items: [],
      }, workspace.dir);

      const startLogs = captureLogs(() => {
        runSessionStart({ context: 'auth', json: true, cwd: workspace.dir });
      });
      const startResult = JSON.parse(startLogs[0] ?? '{}') as { session_id?: string; context_target?: string };
      assert.equal(startResult.session_id, 'sess_json_test');
      assert.equal(startResult.context_target, 'auth');

      const snapshot = loadSessionSnapshot('sess_json_test', workspace.dir);
      assert.ok(snapshot);
      const currentContext = buildContext({
        target: 'auth',
        agent: workspace.currentAgent.agent_name,
        cwd: workspace.dir,
      });
      fs.writeFileSync(
        path.join(workspace.dir, '.brainclaw', 'sessions', 'sess_json_test.json'),
        JSON.stringify({
          ...snapshot,
          initial_context_hash: createHash(JSON.stringify(currentContext.selected)),
        }, null, 2),
        'utf-8',
      );

      const endLogs = captureLogs(() => {
        runSessionEnd({
          session: 'sess_json_test',
          summary: 'Stable session summary',
          autoReflect: false,
          json: true,
          cwd: workspace.dir,
        });
      });
      const endResult = JSON.parse(endLogs[0] ?? '{}') as {
        session_id?: string;
        candidates_created?: number;
        context_diff?: string;
        summary?: string;
      };
      assert.equal(endResult.session_id, 'sess_json_test');
      assert.equal(endResult.candidates_created, 0);
      assert.equal(endResult.context_diff, 'Context unchanged since session start');
      assert.equal(endResult.summary, 'Stable session summary');
    } finally {
      if (previousSession === undefined) {
        delete process.env.BRAINCLAW_SESSION_ID;
      } else {
        process.env.BRAINCLAW_SESSION_ID = previousSession;
      }
    }
  });
});
