import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

// Expected warning strings must match LEGACY_MCP_TOOL_WARNINGS and
// REMOVED_TOOL_REDIRECTS in src/commands/mcp.ts. bclaw_get_context was
// escalated from "Deprecated" to "Removed in v1.0" when the canonical
// grammar (bclaw_context) promoted to default tier.
const LEGACY_WARNING_BY_TOOL = {
  bclaw_session_start: 'Deprecated: use bclaw_work(intent: execute) which handles session start automatically.',
  bclaw_claim: 'Deprecated: use bclaw_work(intent: execute, scope: ...) which creates claims automatically.',
  bclaw_get_context: 'Removed in v1.0: use bclaw_context(kind: "memory") or bclaw_work(intent: consult).',
  bclaw_check_policy: 'Deprecated: policy checks are now implicit; use bclaw_work which surfaces them at claim time.',
} as const;

const LEGACY_DISABLED_MESSAGE = 'This tool is disabled. Use bclaw_work or bclaw_coordinate instead.';

type LegacyToolName = keyof typeof LEGACY_WARNING_BY_TOOL;

function toolArgs(workspace: TestWorkspace): Record<LegacyToolName, Record<string, unknown>> {
  return {
    bclaw_session_start: {
      agent: workspace.currentAgent.agent_name,
    },
    bclaw_claim: {
      agent: workspace.currentAgent.agent_name,
      scope: 'src/auth',
      description: 'Own auth rollout',
    },
    bclaw_get_context: {
      path: 'src/auth/routes.ts',
      format: 'json',
    },
    bclaw_check_policy: {
      scope: 'src/auth/routes.ts',
      agent: workspace.currentAgent.agent_name,
    },
  };
}

describe('facade deprecation warnings', () => {
  let workspace: TestWorkspace;
  let previousFacadeOnly: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-facade-deprecation-',
      projectId: 'prj_facade_deprecation_test',
      currentAgent: 'codex',
    });
    previousFacadeOnly = process.env.BRAINCLAW_FACADE_ONLY;
    delete process.env.BRAINCLAW_FACADE_ONLY;

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_facade_deprecation',
          text: 'Auth routing now goes through the gateway.',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_facade_deprecation_test',
          related_paths: ['src/auth/routes.ts'],
          tags: ['auth'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);
  });

  afterEach(() => {
    if (previousFacadeOnly === undefined) {
      delete process.env.BRAINCLAW_FACADE_ONLY;
    } else {
      process.env.BRAINCLAW_FACADE_ONLY = previousFacadeOnly;
    }
    workspace.cleanup();
  });

  it('adds deprecation warnings while keeping legacy tools functional', async () => {
    const argsByTool = toolArgs(workspace);

    for (const toolName of Object.keys(LEGACY_WARNING_BY_TOOL) as LegacyToolName[]) {
      const result = await executeMcpToolCall({
        name: toolName,
        args: argsByTool[toolName],
        cwd: workspace.dir,
      });

      assert.equal(result.response.isError, false, toolName);
      assert.ok(
        result.response.content.some((item) => item.text === LEGACY_WARNING_BY_TOOL[toolName]),
        `${toolName} should include its deprecation warning`,
      );
    }

    const sessionResult = await executeMcpToolCall({
      name: 'bclaw_session_start',
      args: argsByTool.bclaw_session_start,
      cwd: workspace.dir,
    });
    assert.ok(typeof (sessionResult.response as { session_id?: unknown }).session_id === 'string');

    const claimResult = await executeMcpToolCall({
      name: 'bclaw_claim',
      args: argsByTool.bclaw_claim,
      cwd: workspace.dir,
    });
    assert.ok(typeof (claimResult.response as { claim_id?: unknown }).claim_id === 'string');

    const contextResult = await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: argsByTool.bclaw_get_context,
      cwd: workspace.dir,
    });
    assert.ok(Array.isArray((contextResult.response.structuredContent as { selected?: unknown[] }).selected));

    const policyResult = await executeMcpToolCall({
      name: 'bclaw_check_policy',
      args: argsByTool.bclaw_check_policy,
      cwd: workspace.dir,
    });
    assert.equal(typeof (policyResult.response.structuredContent as { allowed?: unknown }).allowed, 'boolean');
  });

  it('blocks legacy tools when BRAINCLAW_FACADE_ONLY=1', async () => {
    process.env.BRAINCLAW_FACADE_ONLY = '1';
    const argsByTool = toolArgs(workspace);

    for (const toolName of Object.keys(LEGACY_WARNING_BY_TOOL) as LegacyToolName[]) {
      const result = await executeMcpToolCall({
        name: toolName,
        args: argsByTool[toolName],
        cwd: workspace.dir,
      });

      assert.equal(result.response.isError, true, toolName);
      assert.ok(result.response.content.some((item) => item.text.includes(LEGACY_DISABLED_MESSAGE)));
      assert.equal(
        (result.response.structuredContent as { error?: { message?: string } }).error?.message,
        LEGACY_DISABLED_MESSAGE,
      );
    }
  });
});
