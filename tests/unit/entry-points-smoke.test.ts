/**
 * Entry-point smoke test (pln#622 PR4).
 *
 * The mcp.ts decomposition (PR1→PR4) reshaped the assembly point and the
 * module graph feeding both binaries. A pure unit/type gate cannot catch a
 * broken *entry point* — a bad top-level import, a Worker path that no longer
 * resolves, a CLI that throws before parsing. This test boots each binary as a
 * real subprocess and asserts the two coldest paths still work:
 *
 *   1. `cli.js --version` exits 0 and prints the package version.
 *   2. `cli.js mcp` completes the JSON-RPC `initialize` handshake
 *      (Content-Length framed, LSP-style) — which spins up the mcp-worker
 *      Worker thread and exercises the whole commands/mcp*.ts assembly.
 *
 * Deterministic and store-free: a throwaway cwd + fake HOME, agent-detection
 * env stripped. Lives in tests/unit/ so it runs in the default lane (Windows
 * CI included) rather than the serial e2e lane.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AGENT_ENV_KEYS, sanitizedProcessEnv } from '../helpers/workspace.js';

// Compiled test lives at dist-test/tests/unit/ → repo root is 3 levels up.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist-test', 'src', 'cli.js');
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;

/** Store-free, agent-neutral env for booting a binary in a throwaway cwd. */
function smokeEnv(cwd: string): NodeJS.ProcessEnv {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-smoke-home-'));
  const env: NodeJS.ProcessEnv = {
    ...sanitizedProcessEnv(),
    BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
    BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
    USERNAME: 'testuser',
    USER: 'testuser',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };
  for (const key of AGENT_ENV_KEYS) delete env[key];
  return env;
}

function writeFramed(proc: ChildProcessWithoutNullStreams, payload: unknown): void {
  const json = JSON.stringify(payload);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n${json}`);
}

/** Read one Content-Length framed JSON message off stdout, or reject on exit/timeout. */
function readFramed(proc: ChildProcessWithoutNullStreams, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let stderr = '';
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for MCP response.\nstderr:\n${stderr}`)); }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const str = buffer.toString('utf-8');
      const sep = str.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const match = str.slice(0, sep).match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      const bodyStart = Buffer.byteLength(str.slice(0, sep + 4), 'utf-8');
      const len = parseInt(match[1]!, 10);
      if (buffer.length < bodyStart + len) return;
      const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf-8');
      cleanup();
      resolve(JSON.parse(body));
    };
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString('utf-8'); };
    const onExit = () => { cleanup(); reject(new Error(`MCP process exited before responding.\nstderr:\n${stderr}`)); };
    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onStderr);
      proc.off('exit', onExit);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onStderr);
    proc.on('exit', onExit);
  });
}

describe('entry-point smoke (pln#622 PR4)', () => {
  it('cli.js --version exits 0 and prints the package version', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-smoke-cli-'));
    const result = spawnSync(process.execPath, [CLI_PATH, '--version'], {
      cwd,
      env: smokeEnv(cwd),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `--version exited ${result.status}.\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), PKG_VERSION, 'CLI --version output does not match package.json version');
  });

  it('cli.js mcp completes the JSON-RPC initialize handshake', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-smoke-mcp-'));
    const proc = spawn(process.execPath, [CLI_PATH, 'mcp'], { cwd, stdio: 'pipe', env: smokeEnv(cwd) });
    try {
      const responsePromise = readFramed(proc);
      writeFramed(proc, { jsonrpc: '2.0', id: 'smoke-init', method: 'initialize', params: { protocolVersion: '2025-11-25' } });
      const response = await responsePromise;

      assert.equal(response.jsonrpc, '2.0', 'initialize response is not JSON-RPC 2.0');
      assert.equal(response.id, 'smoke-init', 'initialize response id mismatch');
      assert.ok(response.result, `initialize returned an error instead of a result: ${JSON.stringify(response.error ?? response)}`);
      assert.ok(typeof response.result.protocolVersion === 'string' && response.result.protocolVersion.length > 0, 'initialize result missing protocolVersion');
      assert.ok(response.result.capabilities && typeof response.result.capabilities === 'object', 'initialize result missing capabilities');
      assert.ok(response.result.serverInfo && typeof response.result.serverInfo.name === 'string', 'initialize result missing serverInfo.name');
    } finally {
      proc.stdin.end();
      proc.kill();
      await new Promise<void>((resolve) => proc.once('close', () => resolve()));
    }
  });
});
