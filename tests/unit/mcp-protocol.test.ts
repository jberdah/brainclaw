import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_SERVER_NOT_INITIALIZED,
  McpServerConnection,
  createInitializeResult,
  executeMcpToolCall,
  parseMcpLine,
  type McpToolExecutionPayload,
} from '../../src/commands/mcp.js';
import { setAgentTrustLevel } from '../../src/core/agent-registry.js';
import { createTestWorkspace } from '../helpers/workspace.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('commands/mcp protocol core', () => {
  it('parses valid JSON-RPC messages and rejects malformed envelopes', () => {
    const parsed = parseMcpLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    }));
    assert.equal(parsed.method, 'ping');
    assert.equal(parsed.id, 1);
    assert.equal(parsed.isNotification, false);

    assert.throws(() => parseMcpLine('{bad json'), /Parse error/);
    assert.throws(() => parseMcpLine(JSON.stringify([])), /Batch requests are not supported/);
    assert.throws(() => parseMcpLine(JSON.stringify({ method: 'ping' })), /Invalid Request/);
  });

  it('creates initialize payloads for supported protocol versions', () => {
    assert.deepEqual(createInitializeResult('2025-11-25'), {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'brainclaw', version: '0.6.0' },
      capabilities: { tools: { listChanged: false } },
    });
    assert.equal(createInitializeResult('2024-11-05').protocolVersion, '2024-11-05');
  });

  it('enforces initialize and initialized before tools access', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const payloads: McpToolExecutionPayload[] = [];
    const connection = new McpServerConnection({
      cwd: process.cwd(),
      send: (message) => sent.push(message),
      executeTool: async (payload) => {
        payloads.push(payload);
        return {
          response: {
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
            schema_version: '0.6.0',
          },
          nextConnectionSessionId: 'sess_conn_1',
        };
      },
    });

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    assert.equal((sent[0]?.error as { code: number }).code, MCP_SERVER_NOT_INITIALIZED);

    connection.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }));
    assert.equal(connection.state, 'awaiting_initialized');
    assert.equal((sent[1]?.result as { protocolVersion: string }).protocolVersion, '2025-11-25');

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.equal(connection.state, 'ready');

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }));
    assert.deepEqual(sent[2], { jsonrpc: '2.0', id: 3, result: {} });

    connection.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'bclaw_write_note', arguments: { agent: 'copilot', text: 'hello' } },
    }));
    await tick();
    assert.equal(payloads[0]?.connectionSessionId, undefined);
    assert.equal(connection.connectionSessionId, 'sess_conn_1');

    connection.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'bclaw_write_note', arguments: { agent: 'copilot', text: 'again' } },
    }));
    await tick();
    assert.equal(payloads[1]?.connectionSessionId, 'sess_conn_1');

    connection.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }));
    assert.equal((sent[sent.length - 1]?.error as { code: number }).code, -32600);
  });

  it('supports both protocol versions and negotiates down unknown protocol versions', () => {
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
      id: 10,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }));
    assert.equal((sent[0]?.result as { protocolVersion: string }).protocolVersion, '2024-11-05');

    const negotiatedSent: Array<Record<string, unknown>> = [];
    const negotiated = new McpServerConnection({
      cwd: process.cwd(),
      send: (message) => negotiatedSent.push(message),
      executeTool: async () => ({
        response: { content: [{ type: 'text', text: 'ok' }], isError: false, schema_version: '0.6.0' },
      }),
    });
    negotiated.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    }));
    assert.equal((negotiatedSent[0]?.result as { protocolVersion: string }).protocolVersion, '2025-11-25');
  });

  it('rejects initialize requests with missing or non-string protocol versions', () => {
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
      id: 12,
      method: 'initialize',
      params: {},
    }));
    assert.equal((sent[0]?.error as { code: number }).code, -32602);

    connection.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 13,
      method: 'initialize',
      params: { protocolVersion: 42 },
    }));
    assert.equal((sent[1]?.error as { code: number }).code, -32602);
  });

  it('returns protocol errors for unknown methods and invalid params', () => {
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

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope' }));
    assert.equal((sent[sent.length - 1]?.error as { code: number }).code, -32601);

    connection.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { arguments: {} },
    }));
    assert.equal((sent[sent.length - 1]?.error as { code: number }).code, -32602);
  });

  it('maps tool command failures to MCP tool errors without breaking the session', async () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-mcp-protocol-' });
    try {
      setAgentTrustLevel(workspace.currentAgent.agent_name, 'trusted', workspace.dir);
      const result = await executeMcpToolCall({
        name: 'bclaw_accept',
        args: { id: 'cnd_missing', by: workspace.currentAgent.agent_name },
        cwd: workspace.dir,
      });
      assert.equal(result.response.isError, true);
      assert.ok(typeof (result.response.structuredContent as { error: { kind: string } }).error.kind === 'string');
      assert.equal(result.response.schema_version, '0.6.0');
    } finally {
      workspace.cleanup();
    }
  });

  it('rejects unregistered identities and mismatched id/name pairs on write tools', async () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-mcp-protocol-' });
    try {
      const missingIdentity = await executeMcpToolCall({
        name: 'bclaw_write_note',
        args: { agent: 'ghost', text: 'hello' },
        cwd: workspace.dir,
      });
      assert.equal(missingIdentity.response.isError, true);
      assert.equal((missingIdentity.response.structuredContent as { error: { kind: string } }).error.kind, 'identity_error');

      const mismatch = await executeMcpToolCall({
        name: 'bclaw_write_note',
        args: { agent: 'ghost', agentId: workspace.currentAgent.agent_id, text: 'hello' },
        cwd: workspace.dir,
      });
      assert.equal(mismatch.response.isError, true);
      assert.equal((mismatch.response.structuredContent as { error: { kind: string } }).error.kind, 'identity_error');
    } finally {
      workspace.cleanup();
    }
  });

  it('enforces trusted review rights and supports explicit byId parameters', async () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-mcp-protocol-' });
    try {
      const rejectBlocked = await executeMcpToolCall({
        name: 'bclaw_reject',
        args: { id: 'cnd_missing', by: workspace.currentAgent.agent_name },
        cwd: workspace.dir,
      });
      assert.equal(rejectBlocked.response.isError, true);
      assert.equal((rejectBlocked.response.structuredContent as { error: { kind: string } }).error.kind, 'trust_error');

      const mismatch = await executeMcpToolCall({
        name: 'bclaw_accept',
        args: { id: 'cnd_missing', by: 'ghost', byId: workspace.currentAgent.agent_id },
        cwd: workspace.dir,
      });
      assert.equal(mismatch.response.isError, true);
      assert.equal((mismatch.response.structuredContent as { error: { kind: string } }).error.kind, 'identity_error');

      setAgentTrustLevel(workspace.currentAgent.agent_name, 'trusted', workspace.dir);
      const trusted = await executeMcpToolCall({
        name: 'bclaw_accept',
        args: { id: 'cnd_missing', byId: workspace.currentAgent.agent_id },
        cwd: workspace.dir,
      });
      assert.equal(trusted.response.isError, true);
      assert.ok(typeof (trusted.response.structuredContent as { error: { kind: string } }).error.kind === 'string');
    } finally {
      workspace.cleanup();
    }
  });
});
