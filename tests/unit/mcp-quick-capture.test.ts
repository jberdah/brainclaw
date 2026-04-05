import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall, McpServerConnection } from '../../src/commands/mcp.js';
import { setAgentTrustLevel } from '../../src/core/agent-registry.js';
import { listCandidates } from '../../src/core/candidates.js';
import { listRuntimeNotes } from '../../src/core/runtime.js';
import { loadState } from '../../src/core/state.js';
import { createTestWorkspace } from '../helpers/workspace.js';

describe('commands/mcp quick capture', () => {
  it('exposes bclaw_quick_capture in tools/list', () => {
    const sent: Array<Record<string, unknown>> = [];
    const connection = new McpServerConnection({
      cwd: process.cwd(),
      send: (message) => sent.push(message),
      executeTool: async () => ({
        response: { content: [{ type: 'text', text: 'ok' }], isError: false, schema_version: '0.6.0' },
      }),
    });

    connection.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }));
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));

    const tools = ((sent[sent.length - 1]?.result as { tools?: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    assert.ok(tools.includes('bclaw_quick_capture'));
  });

  it('captures decision-like text as a pending candidate for contributors', async () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-mcp-quick-capture-' });
    try {
      const result = await executeMcpToolCall({
        name: 'bclaw_quick_capture',
        args: { text: 'Use auth gateway for new routes', context: 'src/auth/routes.ts' },
        cwd: workspace.dir,
      });

      assert.equal(result.response.isError, false);
      const structured = result.response.structuredContent as {
        classification: string;
        candidate_id?: string;
        context?: string;
      };
      assert.equal(structured.classification, 'decision');
      assert.ok(structured.candidate_id);
      assert.equal(structured.context, 'src/auth/routes.ts');

      const pending = listCandidates('pending', workspace.dir);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].type, 'decision');
      assert.deepEqual(pending[0].related_paths, ['src/auth/routes.ts']);
    } finally {
      workspace.cleanup();
    }
  });

  it('captures trap-like text as a direct write for trusted agents', async () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-mcp-quick-capture-' });
    try {
      setAgentTrustLevel(workspace.currentAgent.agent_name, 'trusted', workspace.dir);
      const result = await executeMcpToolCall({
        name: 'bclaw_quick_capture',
        args: { text: 'Warning: race condition in AuthService.refresh causes flaky retries' },
        cwd: workspace.dir,
      });

      assert.equal(result.response.isError, false);
      const structured = result.response.structuredContent as {
        classification: string;
        write_through?: boolean;
        promoted_item_id?: string;
      };
      assert.equal(structured.classification, 'trap');
      assert.equal(structured.write_through, true);
      assert.ok(structured.promoted_item_id);
      assert.ok(loadState(workspace.dir).known_traps.some((item) => item.id === structured.promoted_item_id));
    } finally {
      workspace.cleanup();
    }
  });

  it('falls back to runtime notes when the heuristic is ambiguous', async () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-mcp-quick-capture-' });
    try {
      const result = await executeMcpToolCall({
        name: 'bclaw_quick_capture',
        args: { text: 'Use retries because the upstream API is flaky', context: 'src/api/client.ts' },
        cwd: workspace.dir,
      });

      assert.equal(result.response.isError, false);
      const structured = result.response.structuredContent as {
        classification: string;
        classification_reason?: string;
        note_id?: string;
      };
      assert.equal(structured.classification, 'note');
      assert.equal(structured.classification_reason, 'ambiguous_keywords');
      assert.ok(structured.note_id);

      const notes = listRuntimeNotes(undefined, workspace.dir);
      assert.equal(notes.length, 1);
      assert.ok(notes[0].text.includes('Use retries because the upstream API is flaky'));
      assert.ok(notes[0].text.includes('Context: src/api/client.ts'));
    } finally {
      workspace.cleanup();
    }
  });
});
