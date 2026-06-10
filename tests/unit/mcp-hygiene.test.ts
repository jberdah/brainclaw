/**
 * Tests for MCP protocol hygiene fixes:
 *  1. stdio framing fuzz — multibyte/split-chunk payloads (newline + Content-Length)
 *  2. cross-project escape attempt matrix (abs path, ../ traversal, unlinked sibling)
 *  3. session pinning across 3+ consecutive tool calls
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServerConnection, StdioTransport } from '../../src/commands/mcp.js';
import { resolveProjectRef } from '../../src/core/store-resolution.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = 'bclaw-hygiene-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initProject(dir: string, name = 'test-project'): void {
  const cfg = defaultConfig(name);
  ensureMemoryDir(dir);
  saveConfig(cfg, dir);
}

/**
 * Create a minimal StdioTransport and feed raw bytes into it.
 * Returns the list of decoded messages.
 */
function buildTransportHarness(): {
  messages: string[];
  feed: (chunk: Buffer | string) => void;
} {
  const messages: string[] = [];
  const onMessage = (msg: string) => messages.push(msg);
  const transport = new StdioTransport(onMessage, () => {});

  // Directly call the internal drain by accessing the buffer field and drain()
  // via the start() shim we provide: we expose a testFeed() method to push
  // bytes without wiring up process.stdin.
  //
  // Implementation note: StdioTransport.start() binds to process.stdin which
  // is unsuitable for unit tests.  We patch the internal buffer directly.
  const t = transport as unknown as {
    buffer: Buffer;
    detectedMode: string;
    drain: () => void;
  };

  return {
    messages,
    feed(chunk: Buffer | string) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
      t.buffer = Buffer.concat([t.buffer, buf]);
      t.drain();
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Stdio framing fuzz — multibyte / split-chunk
// ---------------------------------------------------------------------------

describe('stdio framing: newline mode multibyte UTF-8', () => {
  it('handles a complete multibyte payload in one chunk', () => {
    const { messages, feed } = buildTransportHarness();
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { text: '日本語テスト' } });
    feed(payload + '\n');
    assert.equal(messages.length, 1);
    assert.deepEqual(JSON.parse(messages[0]!), JSON.parse(payload));
  });

  it('handles a 3-byte UTF-8 character (€) split across two chunks', () => {
    const { messages, feed } = buildTransportHarness();
    const fullMsg = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"cost":"€100"}}\n';
    const fullBuf = Buffer.from(fullMsg, 'utf-8');

    // The € character is E2 82 AC (3 bytes). Find its start and split mid-char.
    // Locate it: first split so that the € char is cut after the first byte.
    const euroIndex = fullBuf.indexOf(0xe2); // first byte of €
    assert.ok(euroIndex !== -1, 'should contain €');

    const chunk1 = fullBuf.subarray(0, euroIndex + 1); // …E2 (incomplete char)
    const chunk2 = fullBuf.subarray(euroIndex + 1);    // 82 AC … rest

    feed(chunk1);
    assert.equal(messages.length, 0, 'no message yet: newline not seen');
    feed(chunk2);
    assert.equal(messages.length, 1, 'exactly one message after second chunk');
    const parsed = JSON.parse(messages[0]!) as { params: { cost: string } };
    assert.equal(parsed.params.cost, '€100', 'multibyte char must be intact');
  });

  it('handles a 4-byte UTF-8 emoji split into three chunks', () => {
    const { messages, feed } = buildTransportHarness();
    const fullMsg = '{"jsonrpc":"2.0","id":2,"method":"ping","params":{"icon":"🚀"}}\n';
    const fullBuf = Buffer.from(fullMsg, 'utf-8');

    // 🚀 is F0 9F 9A 80 (4 bytes). Split it across 3 deliveries.
    const rocketIndex = fullBuf.indexOf(0xf0);
    assert.ok(rocketIndex !== -1, 'should contain rocket');

    feed(fullBuf.subarray(0, rocketIndex + 1));  // …F0
    assert.equal(messages.length, 0);
    feed(fullBuf.subarray(rocketIndex + 1, rocketIndex + 3)); // 9F 9A
    assert.equal(messages.length, 0);
    feed(fullBuf.subarray(rocketIndex + 3));     // 80 + rest + \n
    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]!) as { params: { icon: string } };
    assert.equal(parsed.params.icon, '🚀', 'emoji must be intact');
  });

  it('handles multiple messages in one chunk with multibyte content', () => {
    const { messages, feed } = buildTransportHarness();
    const m1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a', params: { v: 'héllo' } });
    const m2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b', params: { v: '日本語' } });
    feed(m1 + '\n' + m2 + '\n');
    assert.equal(messages.length, 2);
    assert.equal((JSON.parse(messages[0]!) as { params: { v: string } }).params.v, 'héllo');
    assert.equal((JSON.parse(messages[1]!) as { params: { v: string } }).params.v, '日本語');
  });
});

describe('stdio framing: Content-Length mode multibyte UTF-8', () => {
  it('handles a multibyte body via Content-Length when split at header/body boundary', () => {
    const { messages, feed } = buildTransportHarness();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: { text: 'こんにちは' } });
    const byteLen = Buffer.byteLength(body, 'utf-8');
    const frame = Buffer.from(`Content-Length: ${byteLen}\r\n\r\n${body}`, 'utf-8');

    // Split at the header/body separator
    const headerEnd = frame.indexOf(0x0a, frame.indexOf(0x0d)); // end of \r\n\r\n
    const splitPoint = headerEnd + 1; // right after \r\n\r\n
    feed(frame.subarray(0, splitPoint));
    assert.equal(messages.length, 0, 'no message yet: body not complete');
    feed(frame.subarray(splitPoint));
    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]!) as { params: { text: string } };
    assert.equal(parsed.params.text, 'こんにちは');
  });

  it('handles a multibyte body split mid-character in Content-Length mode', () => {
    const { messages, feed } = buildTransportHarness();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping', params: { text: '中文內容' } });
    const bodyBuf = Buffer.from(body, 'utf-8');
    const byteLen = bodyBuf.length;
    const headerBuf = Buffer.from(`Content-Length: ${byteLen}\r\n\r\n`, 'utf-8');
    const frame = Buffer.concat([headerBuf, bodyBuf]);

    // Feed header + first byte of body's first multibyte char
    feed(frame.subarray(0, headerBuf.length + 1));
    assert.equal(messages.length, 0);
    // Feed remainder
    feed(frame.subarray(headerBuf.length + 1));
    assert.equal(messages.length, 1);
    const parsed = JSON.parse(messages[0]!) as { params: { text: string } };
    assert.equal(parsed.params.text, '中文內容');
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-project escape attempt matrix
// ---------------------------------------------------------------------------

describe('resolveProjectRef: cross-project allowlist escape prevention', () => {
  let wsRoot: string;
  let childDir: string;
  let siblingDir: string;

  before(() => {
    wsRoot = makeTmpDir('bclaw-ws-');
    initProject(wsRoot, 'workspace');

    childDir = path.join(wsRoot, 'child-project');
    fs.mkdirSync(childDir, { recursive: true });
    initProject(childDir, 'child');

    // Sibling outside workspace
    siblingDir = makeTmpDir('bclaw-sibling-');
    initProject(siblingDir, 'sibling');
  });

  after(() => {
    fs.rmSync(wsRoot, { recursive: true, force: true });
    fs.rmSync(siblingDir, { recursive: true, force: true });
  });

  it('resolves a child project by absolute path within workspace', () => {
    // Use absolute path to childDir — it's inside wsRoot so the boundary allows it
    const resolved = resolveProjectRef(childDir, wsRoot);
    assert.equal(resolved, childDir);
  });

  it('blocks absolute path to a project outside workspace', () => {
    // siblingDir is outside wsRoot → must not be reachable by abs path
    const resolved = resolveProjectRef(siblingDir, wsRoot);
    assert.equal(resolved, undefined, 'abs path outside workspace must be blocked');
  });

  it('blocks ../ traversal to escape the workspace', () => {
    const relEscape = path.relative(wsRoot, siblingDir);
    // If sibling is on a different drive or truly outside, the relative path
    // may not traverse via ../ — but we can construct one explicitly.
    const traversal = '../' + path.basename(siblingDir);
    const resolved = resolveProjectRef(traversal, wsRoot);
    assert.equal(resolved, undefined, '../ traversal must be blocked');
  });

  it('resolves a child project by absolute path when within workspace', () => {
    const resolved = resolveProjectRef(childDir, wsRoot);
    assert.equal(resolved, childDir, 'abs path inside workspace should resolve');
  });

  it('returns undefined for an absolute path pointing to a non-existent project', () => {
    const resolved = resolveProjectRef('/nonexistent/path/that/has/no/store', wsRoot);
    assert.equal(resolved, undefined);
  });

  it('returns undefined for an unknown name', () => {
    const resolved = resolveProjectRef('completely-unknown-ref-xyz', wsRoot);
    assert.equal(resolved, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Session pinning across 3+ consecutive tool calls
// ---------------------------------------------------------------------------

describe('McpServerConnection: connectionSessionId pinned across calls', () => {
  it('preserves session ID across 3+ tool calls returning no nextConnectionSessionId', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const SESSION_ID = 'sess_pin_test_abc';

    const connection = new McpServerConnection({
      cwd: process.cwd(),
      send: (msg) => sent.push(msg),
      executeTool: async (_payload) => {
        callCount++;
        if (callCount === 1) {
          // First call (session_start equivalent) sets the session ID
          return { response: { content: [{ type: 'text' as const, text: 'ok' }] }, nextConnectionSessionId: SESSION_ID };
        }
        // Subsequent calls do NOT return nextConnectionSessionId (undefined = no change)
        return { response: { content: [{ type: 'text' as const, text: 'ok' }] } };
      },
    });

    // Initialize the connection
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    // Call 1 — sets session ID
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bclaw_session_start', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(connection.connectionSessionId, SESSION_ID, 'session ID set after call 1');

    // Call 2 — no nextConnectionSessionId returned → must NOT wipe it
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bclaw_get_context', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(connection.connectionSessionId, SESSION_ID, 'session ID preserved after call 2');

    // Call 3 — still no nextConnectionSessionId → must still be pinned
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bclaw_search', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(connection.connectionSessionId, SESSION_ID, 'session ID preserved after call 3');
  });

  it('clears session ID when nextConnectionSessionId is null (session_end)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let callCount = 0;

    const connection = new McpServerConnection({
      cwd: process.cwd(),
      send: (msg) => sent.push(msg),
      executeTool: async (_payload) => {
        callCount++;
        if (callCount === 1) {
          return { response: { content: [{ type: 'text' as const, text: 'started' }] }, nextConnectionSessionId: 'sess_end_test' };
        }
        // session_end returns null to explicitly clear
        return { response: { content: [{ type: 'text' as const, text: 'ended' }] }, nextConnectionSessionId: null };
      },
    });

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bclaw_session_start', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(connection.connectionSessionId, 'sess_end_test', 'session ID set');

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bclaw_session_end', arguments: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(connection.connectionSessionId, undefined, 'session ID cleared after session_end');
  });

  it('passes pinned session ID to each subsequent tool execution payload', async () => {
    const payloads: Array<{ connectionSessionId?: string }> = [];
    const SESSION_ID = 'sess_payload_check';

    const connection = new McpServerConnection({
      cwd: process.cwd(),
      send: () => {},
      executeTool: async (payload) => {
        payloads.push({ connectionSessionId: payload.connectionSessionId });
        if (payloads.length === 1) {
          return { response: { content: [{ type: 'text' as const, text: 'ok' }] }, nextConnectionSessionId: SESSION_ID };
        }
        return { response: { content: [{ type: 'text' as const, text: 'ok' }] } };
      },
    });

    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
    connection.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    // Calls 1–4
    for (let i = 2; i <= 5; i++) {
      connection.handleLine(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'bclaw_write_note', arguments: {} } }));
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(payloads[0]?.connectionSessionId, undefined, 'call 1: no session yet');
    assert.equal(payloads[1]?.connectionSessionId, SESSION_ID, 'call 2: session pinned');
    assert.equal(payloads[2]?.connectionSessionId, SESSION_ID, 'call 3: session pinned');
    assert.equal(payloads[3]?.connectionSessionId, SESSION_ID, 'call 4: session pinned');
  });
});
