import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { loadCurrentSession, loadSessionById, saveCurrentSession } from '../../src/core/identity.js';
import { addCrossProjectLink } from '../../src/core/cross-project.js';
import { createEntity } from '../../src/core/entity-operations.js';

/**
 * pln#515 step 4 (seq #40) — bclaw_switch MCP verb.
 *
 * The verb was partially shipped earlier (mcp-read-handlers.ts has the
 * handler + schema). pln#515 step 4's actual gap was that switchProject
 * only resolved via the workspace store-chain (resolveProjectRef), missing
 * cross_project_links — so the MCP verb could not target externally-linked
 * projects. This test covers the fix in src/commands/switch.ts that adds a
 * resolveProjectCwd fallback, AND the existing list/clear/validation paths.
 */

interface ToolEnvelope {
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  errorKind?: string;
  nextConnectionSessionId?: string;
}

async function callTool(
  workspace: TestWorkspace,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_switch',
    args,
    cwd: workspace.dir,
  });
  const structured = outcome.response.structuredContent as Record<string, unknown> | undefined;
  const errorBlock = structured?.error as { kind?: string } | undefined;
  return {
    isError: outcome.response.isError === true,
    structuredContent: structured,
    errorKind: errorBlock?.kind,
    nextConnectionSessionId: outcome.nextConnectionSessionId ?? undefined,
  };
}

describe('bclaw_switch — MCP verb (pln#515 step 4, seq #40)', () => {
  let workspace: TestWorkspace;
  let linkedProject: TestWorkspace;
  let linkedProjectB: TestWorkspace;
  let previousTestMode: string | undefined;
  let previousCwdEnv: string | undefined;
  let previousSessionId: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    previousCwdEnv = process.env.BRAINCLAW_CWD;
    previousSessionId = process.env.BRAINCLAW_SESSION_ID;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-switch-host-', currentAgent: 'claude-code' });
    linkedProject = createTestWorkspace({ prefix: 'bclaw-switch-target-', currentAgent: 'claude-code' });
    linkedProjectB = createTestWorkspace({ prefix: 'bclaw-switch-target-b-', currentAgent: 'claude-code' });
    restoreCwd = workspace.useCwd();
    // Anchor workspace resolution to the test dir so findOutermostWorkspaceRoot
    // does not walk up to the user's home directory.
    process.env.BRAINCLAW_CWD = workspace.dir;

    addCrossProjectLink({
      path: linkedProject.dir,
      name: 'target-project',
      cwd: workspace.dir,
    });
    addCrossProjectLink({
      path: linkedProjectB.dir,
      name: 'target-project-b',
      cwd: workspace.dir,
    });
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    linkedProject.cleanup();
    linkedProjectB.cleanup();
    if (previousTestMode === undefined) {
      delete process.env.BRAINCLAW_TEST_MODE;
    } else {
      process.env.BRAINCLAW_TEST_MODE = previousTestMode;
    }
    if (previousCwdEnv === undefined) {
      delete process.env.BRAINCLAW_CWD;
    } else {
      process.env.BRAINCLAW_CWD = previousCwdEnv;
    }
    if (previousSessionId === undefined) {
      delete process.env.BRAINCLAW_SESSION_ID;
    } else {
      process.env.BRAINCLAW_SESSION_ID = previousSessionId;
    }
  });

  it('sets active_project to a cross_project_linked project', async () => {
    const r = await callTool(workspace, { project: 'target-project' });
    assert.equal(r.isError, false, `expected ok, got error: ${JSON.stringify(r.structuredContent)}`);
    assert.equal(r.structuredContent?.switched, true);
    assert.match(r.structuredContent?.path as string, /bclaw-switch-target-/);
    assert.equal(r.structuredContent?.scope, 'session');
    assert.equal(r.nextConnectionSessionId, r.structuredContent?.session_id);
    assert.match(r.nextConnectionSessionId ?? '', /^sess_/);
    assert.match(loadCurrentSession(workspace.dir)?.active_project?.path ?? '', /bclaw-switch-target-/);
  });

  it('clears active_project with clear=true', async () => {
    await callTool(workspace, { project: 'target-project' });

    const r = await callTool(workspace, { clear: true });
    assert.equal(r.isError, false, `expected ok, got error: ${JSON.stringify(r.structuredContent)}`);
    assert.equal(r.structuredContent?.cleared, true);
  });

  it('rejects unknown project name', async () => {
    const r = await callTool(workspace, { project: 'no-such-project' });
    // NOTE: read-handler routing wraps responses through a second toolResponse
    // call which drops the inner isError flag. The truthy signal is the error
    // envelope shape in structuredContent.error.kind.
    assert.equal(r.errorKind, 'switch_error');
    assert.match((r.structuredContent?.error as { message?: string })?.message ?? '', /Cannot resolve project/i);
  });

  it('rejects missing project + no clear/list (validation error)', async () => {
    const r = await callTool(workspace, {});
    assert.equal(r.errorKind, 'validation_error');
  });

  it('list=true returns project list without switching', async () => {
    const r = await callTool(workspace, { list: true });
    assert.equal(r.isError, false);
    assert.ok(Array.isArray(r.structuredContent?.projects), 'list response must include projects array');
  });

  it('list=true marks the session active project when one is set', async () => {
    await callTool(workspace, { project: 'target-project' });

    const r = await callTool(workspace, { list: true });
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent?.active_source, 'session');
    const projects = r.structuredContent?.projects as Array<{ path: string; active: boolean }>;
    const active = projects.filter((p) => p.active);
    assert.equal(active.length, 1);
    assert.match(active[0]?.path ?? '', /bclaw-switch-target-/);
  });

  it('keeps active_project isolated between explicit parallel sessions for the same agent', async () => {
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: 'sess_parallel_a',
      started_at: now,
      last_seen_at: now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: 111111,
    }, workspace.dir);
    saveCurrentSession({
      session_id: 'sess_parallel_b',
      started_at: now,
      last_seen_at: now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: 222222,
    }, workspace.dir);

    process.env.BRAINCLAW_SESSION_ID = 'sess_parallel_a';
    const first = await callTool(workspace, { project: 'target-project' });
    assert.equal(first.isError, false, `expected ok, got error: ${JSON.stringify(first.structuredContent)}`);

    process.env.BRAINCLAW_SESSION_ID = 'sess_parallel_b';
    const second = await callTool(workspace, { project: 'target-project-b' });
    assert.equal(second.isError, false, `expected ok, got error: ${JSON.stringify(second.structuredContent)}`);

    assert.match(loadSessionById('sess_parallel_a', workspace.dir)?.active_project?.path ?? '', /bclaw-switch-target-/);
    assert.match(loadSessionById('sess_parallel_b', workspace.dir)?.active_project?.path ?? '', /bclaw-switch-target-b-/);
    assert.notEqual(
      loadSessionById('sess_parallel_a', workspace.dir)?.active_project?.path,
      loadSessionById('sess_parallel_b', workspace.dir)?.active_project?.path,
    );

    process.env.BRAINCLAW_SESSION_ID = 'sess_parallel_a';
    assert.equal(loadCurrentSession(workspace.dir)?.session_id, 'sess_parallel_a');
    process.env.BRAINCLAW_SESSION_ID = 'sess_parallel_b';
    assert.equal(loadCurrentSession(workspace.dir)?.session_id, 'sess_parallel_b');
  });

  it('routes canonical reads through the connection session active project', async () => {
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: 'sess_connection_switch',
      started_at: now,
      last_seen_at: now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: 333333,
    }, workspace.dir);

    const hostConstraint = createEntity('constraint', {
      text: 'Host workspace constraint',
      author: 'claude-code',
      category: 'process',
    }, workspace.dir);
    const targetConstraint = createEntity('constraint', {
      text: 'Target project constraint',
      author: 'claude-code',
      category: 'process',
    }, linkedProject.dir);

    const switched = await executeMcpToolCall({
      name: 'bclaw_switch',
      args: { project: 'target-project' },
      cwd: workspace.dir,
      connectionSessionId: 'sess_connection_switch',
    });
    assert.equal(switched.response.isError, false);

    const found = await executeMcpToolCall({
      name: 'bclaw_find',
      args: { entity: 'constraint' },
      cwd: workspace.dir,
      connectionSessionId: 'sess_connection_switch',
    });
    const structured = found.response.structuredContent as {
      total: number;
      items: Array<{ id: string; text: string }>;
      active_source?: string;
      resolved_project?: { path?: string };
    };

    assert.equal(structured.active_source, 'session');
    assert.match(structured.resolved_project?.path ?? '', /bclaw-switch-target-/);
    assert.equal(structured.total, 1);
    assert.equal(structured.items[0].id, targetConstraint.id);
    assert.notEqual(structured.items[0].id, hostConstraint.id);
  });

  it('preserves session active_source for external linked projects without BRAINCLAW_CWD', async () => {
    delete process.env.BRAINCLAW_CWD;
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: 'sess_no_env_anchor',
      started_at: now,
      last_seen_at: now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: 444444,
    }, workspace.dir);

    const targetConstraint = createEntity('constraint', {
      text: 'Target without env anchor',
      author: 'claude-code',
      category: 'process',
    }, linkedProject.dir);

    const switched = await executeMcpToolCall({
      name: 'bclaw_switch',
      args: { project: 'target-project' },
      cwd: workspace.dir,
      connectionSessionId: 'sess_no_env_anchor',
    });
    assert.equal(switched.response.isError, false);

    const found = await executeMcpToolCall({
      name: 'bclaw_find',
      args: { entity: 'constraint' },
      cwd: workspace.dir,
      connectionSessionId: 'sess_no_env_anchor',
    });
    const structured = found.response.structuredContent as {
      total: number;
      items: Array<{ id: string }>;
      active_source?: string;
      resolved_project?: { path?: string };
    };
    assert.equal(structured.active_source, 'session');
    assert.match(structured.resolved_project?.path ?? '', /bclaw-switch-target-/);
    assert.equal(structured.total, 1);
    assert.equal(structured.items[0].id, targetConstraint.id);
  });

  it('echoes resolved project metadata for canonical writes after a session switch', async () => {
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: 'sess_write_echo',
      started_at: now,
      last_seen_at: now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: 555555,
    }, workspace.dir);

    await executeMcpToolCall({
      name: 'bclaw_switch',
      args: { project: 'target-project' },
      cwd: workspace.dir,
      connectionSessionId: 'sess_write_echo',
    });
    const created = await executeMcpToolCall({
      name: 'bclaw_create',
      args: {
        entity: 'constraint',
        data: { text: 'Write echo constraint', category: 'process' },
      },
      cwd: workspace.dir,
      connectionSessionId: 'sess_write_echo',
    });
    const structured = created.response.structuredContent as {
      id: string;
      active_source?: string;
      resolved_project?: { path?: string };
    };
    assert.equal(created.response.isError, false);
    assert.equal(structured.active_source, 'session');
    assert.match(structured.resolved_project?.path ?? '', /bclaw-switch-target-/);

    const found = await executeMcpToolCall({
      name: 'bclaw_find',
      args: { entity: 'constraint', project: 'target-project' },
      cwd: workspace.dir,
    });
    const foundStructured = found.response.structuredContent as { items: Array<{ id: string }> };
    assert.ok(foundStructured.items.some((item) => item.id === structured.id));
  });
});
