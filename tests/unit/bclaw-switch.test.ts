import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { loadCurrentSession } from '../../src/core/identity.js';
import { addCrossProjectLink } from '../../src/core/cross-project.js';

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
  };
}

describe('bclaw_switch — MCP verb (pln#515 step 4, seq #40)', () => {
  let workspace: TestWorkspace;
  let linkedProject: TestWorkspace;
  let previousTestMode: string | undefined;
  let previousCwdEnv: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    previousCwdEnv = process.env.BRAINCLAW_CWD;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-switch-host-', currentAgent: 'claude-code' });
    linkedProject = createTestWorkspace({ prefix: 'bclaw-switch-target-', currentAgent: 'claude-code' });
    restoreCwd = workspace.useCwd();
    // Anchor workspace resolution to the test dir so findOutermostWorkspaceRoot
    // does not walk up to the user's home directory.
    process.env.BRAINCLAW_CWD = workspace.dir;

    addCrossProjectLink({
      path: linkedProject.dir,
      name: 'target-project',
      cwd: workspace.dir,
    });
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    linkedProject.cleanup();
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
  });

  it('sets active_project to a cross_project_linked project', async () => {
    const r = await callTool(workspace, { project: 'target-project' });
    assert.equal(r.isError, false, `expected ok, got error: ${JSON.stringify(r.structuredContent)}`);
    assert.equal(r.structuredContent?.switched, true);
    assert.match(r.structuredContent?.path as string, /bclaw-switch-target-/);
    // scope may be 'session' or 'global' depending on whether a session is
    // active in this test workspace — both are valid switch outcomes.
    assert.ok(['session', 'global'].includes(r.structuredContent?.scope as string));
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
});
