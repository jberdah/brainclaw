import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOperationalIdentity,
  loadCurrentSession,
  saveCurrentSession,
  resolveCurrentSessionId,
} from '../../src/core/identity.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/identity implicit sessions', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-identity-session-',
      projectId: 'prj_identity_session',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    delete process.env.BRAINCLAW_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    workspace.cleanup();
  });

  it('prefers an explicit session id over the implicit session file', () => {
    process.env.BRAINCLAW_SESSION_ID = 'sess_explicit';
    const identity = buildOperationalIdentity(undefined, workspace.dir);
    assert.equal(identity.session_id, 'sess_explicit');
    assert.equal(loadCurrentSession(workspace.dir), undefined);
  });

  it('reuses a non-expired implicit session for the same agent and host', () => {
    const first = buildOperationalIdentity(undefined, workspace.dir);
    const second = buildOperationalIdentity(undefined, workspace.dir);

    assert.ok(first.session_id);
    assert.equal(second.session_id, first.session_id);
    assert.equal(loadCurrentSession(workspace.dir)?.session_id, first.session_id);
  });

  it('does not load a different parallel session for the same agent without an explicit id', () => {
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: 'sess_other_parallel',
      started_at: now,
      last_seen_at: now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: process.pid + 100000,
    }, workspace.dir);

    assert.equal(loadCurrentSession(workspace.dir), undefined);

    process.env.BRAINCLAW_SESSION_ID = 'sess_other_parallel';
    assert.equal(loadCurrentSession(workspace.dir)?.session_id, 'sess_other_parallel');
  });

  it('loads Codex sessions when only native Codex env vars identify the agent', () => {
    const codex = workspace.registerAgent('codex');
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: 'sess_codex_native_env',
      started_at: now,
      last_seen_at: now,
      agent: codex.agent_name,
      agent_id: codex.agent_id,
      host_id: 'host-test',
      pid: process.pid,
    }, workspace.dir);

    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT;
    process.env.CODEX_THREAD_ID = 'codex-thread-dgx';

    assert.equal(loadCurrentSession(workspace.dir)?.session_id, 'sess_codex_native_env');
  });

  it('rotates an expired implicit session', () => {
    const first = buildOperationalIdentity(undefined, workspace.dir);
    workspace.updateConfig((config) => {
      config.implicit_session_ttl = '1m';
    });

    const filepath = path.join(workspace.dir, '.brainclaw', 'sessions', `${first.session_id}.json`);
    const raw = loadCurrentSession(workspace.dir);
    assert.ok(raw);
    fs.writeFileSync(filepath, JSON.stringify({
      ...raw,
      last_seen_at: '2020-01-01T00:00:00.000Z',
    }, null, 2), 'utf-8');

    const second = buildOperationalIdentity(undefined, workspace.dir);
    assert.notEqual(second.session_id, first.session_id);
  });

  it('invalidates an implicit session when agent or host changes', () => {
    const first = buildOperationalIdentity(undefined, workspace.dir);
    const otherAgent = workspace.registerAgent('claude');

    const otherIdentity = buildOperationalIdentity(otherAgent.agent_name, workspace.dir);
    assert.notEqual(otherIdentity.session_id, first.session_id);

    const restoreHost = workspace.setHostId('ci-runner-a');
    try {
      const hostIdentity = buildOperationalIdentity(undefined, workspace.dir);
      assert.notEqual(hostIdentity.session_id, otherIdentity.session_id);
    } finally {
      restoreHost();
    }
  });

  it('tolerates a corrupted .current-session file and creates a fresh session', () => {
    const filepath = path.join(workspace.dir, '.brainclaw', '.current-session');
    fs.writeFileSync(filepath, '{not valid json', 'utf-8');

    const sessionId = resolveCurrentSessionId(process.env, workspace.dir, {
      agentName: workspace.currentAgent.agent_name,
      agentId: workspace.currentAgent.agent_id,
      hostId: 'host-test',
    });

    assert.match(sessionId ?? '', /^sess_[a-f0-9]+$/);
    assert.equal(loadCurrentSession(workspace.dir)?.session_id, sessionId);
  });
});
