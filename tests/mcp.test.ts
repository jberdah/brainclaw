import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import YAML from 'yaml';

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-mcp-'));
}

function run(args: string[], cwd: string, envOverrides: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, USERNAME: 'testuser', USER: 'testuser', ...envOverrides },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

function enableReputation(dir: string): void {
  const configPath = path.join(dir, '.brainclaw', 'config.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
  config.reputation = {
    ...(config.reputation ?? {}),
    enabled: true,
    mcp_exposure: true,
  };
  fs.writeFileSync(configPath, YAML.stringify(config, { lineWidth: 0 }), 'utf-8');
}

function startMcp(cwd: string, envOverrides: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  return spawn(NODE, [CLI_PATH, 'mcp'], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, USERNAME: 'testuser', USER: 'testuser', ...envOverrides },
  });
}

function stopMcp(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) {
      resolve();
      return;
    }

    proc.once('close', () => resolve());
    proc.stdin.end();
    proc.kill();
  });
}

function sendMcpRequest(proc: ChildProcessWithoutNullStreams, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    let stderr = '';

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) {
        return;
      }

      cleanup();
      try {
        resolve(JSON.parse(lines[0]));
      } catch (error) {
        reject(error);
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    };

    const onExit = () => {
      cleanup();
      reject(new Error(`MCP process exited unexpectedly: ${stderr}`));
    };

    const cleanup = () => {
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onStderr);
      proc.off('exit', onExit);
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onStderr);
    proc.on('exit', onExit);
    proc.stdin.write(JSON.stringify(request) + '\n');
  });
}

describe('MCP server', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists available tools', async () => {
    const proc = startMcp(dir);
    try {
      const response = await sendMcpRequest(proc, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(response.jsonrpc, '2.0');
      assert.ok(Array.isArray(response.result.tools));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_get_context'));
    } finally {
      await stopMcp(proc);
    }
  });

  it('returns structured context with format and budget controls', async () => {
    run(['decision', 'OAuth migration now goes through auth-gateway', '--tag', 'auth'], dir);
    run(['runtime-note', 'Auth runtime context', '--tag', 'auth'], dir, { BRAINCLAW_SESSION_ID: 'sess_mcp_ctx' });
    run(['trap', 'Auth test is flaky on Windows', '--tag', 'auth'], dir);
    run(['instruction', 'Always check gateway policy before edits'], dir);

    const proc = startMcp(dir);
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_context',
          arguments: {
            path: 'auth',
            format: 'json',
            maxItems: 5,
          },
        },
      });

      assert.equal(response.jsonrpc, '2.0');
      assert.ok(response.result.content[0].text.includes('selected'));
      assert.ok(Array.isArray(response.result.structuredContent.selected));
      assert.ok(Array.isArray(response.result.structuredContent.resolved_instructions));
      assert.ok(response.result.structuredContent.resolved_instructions.length >= 1);
      assert.ok(response.result.structuredContent.selected.length >= 1);
      assert.ok(Array.isArray(response.result.structuredContent.selected[0].reasons));
      const runtimeItem = response.result.structuredContent.selected.find((item: any) => item.section === 'runtime');
      assert.ok(runtimeItem);
      assert.equal(runtimeItem.provenance.actor, 'testuser');
      assert.equal(runtimeItem.provenance.session_id, 'sess_mcp_ctx');
    } finally {
      await stopMcp(proc);
    }
  });

  it('renders explain mode for markdown context responses', async () => {
    run(['decision', 'Auth gateway routes OAuth', '--tag', 'auth'], dir);
    run(['instruction', 'Check auth gateway conventions first'], dir);

    const proc = startMcp(dir);
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_context',
          arguments: {
            path: 'auth',
            explain: true,
          },
        },
      });

      assert.ok(response.result.content[0].text.includes('{why:'));
      assert.ok(response.result.content[0].text.includes('Instructions:'));
      assert.ok(response.result.content[0].text.includes('auth'));
    } finally {
      await stopMcp(proc);
    }
  });

  it('reads handoff details through MCP', async () => {
    const hndRes = run(['handoff', '--from', 'alice', '--to', 'bob', 'Review PR #42', '--tag', 'review'], dir);
    const hndId = extractId(hndRes.stdout);

    const proc = startMcp(dir);
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'bclaw_read_handoff',
          arguments: { id: hndId },
        },
      });

      assert.ok(response.result.content[0].text.includes('From: alice'));
      assert.ok(response.result.content[0].text.includes('To: bob'));
      assert.ok(response.result.content[0].text.includes('Review PR #42'));
    } finally {
      await stopMcp(proc);
    }
  });

  it('returns an agent collaboration board', async () => {
    run(['instruction', 'Read auth memory first', '--layer', 'project', '--project', 'auth'], dir);
    const mcpPlanRes = run(['plan', 'Own auth rollout', '--project', 'auth'], dir);
    const mcpPlanId = extractId(mcpPlanRes.stdout);
    run(['claim', 'Taking auth rollout', '--agent', 'copilot', '--scope', 'src/auth/', '--plan', mcpPlanId], dir);
    run(['runtime-note', 'Started auth rollout', '--agent', 'copilot', '--plan', mcpPlanId], dir);
    run(['handoff', '--from', 'copilot', '--to', 'claude', 'Review auth patch', '--tag', 'auth'], dir);

    const proc = startMcp(dir);
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_agent_board',
          arguments: {
            agent: 'copilot',
            project: 'auth',
          },
        },
      });

      assert.ok(response.result.content[0].text.includes('Agent board for copilot (auth)'));
      assert.match(response.result.structuredContent.project_id, /^prj_[a-f0-9]+$/);
      assert.match(response.result.structuredContent.agent_id, /^agt_[a-f0-9]+$/);
      assert.ok(Array.isArray(response.result.structuredContent.active_plans));
      assert.equal(response.result.structuredContent.active_plans.length, 1);
      assert.equal(response.result.structuredContent.active_claims.length, 1);
      assert.equal(response.result.structuredContent.runtime_notes.length, 1);
      assert.ok(Array.isArray(response.result.structuredContent.resolved_instructions));
    } finally {
      await stopMcp(proc);
    }
  });

  it('can include bounded reputation summaries in MCP board responses when requested', async () => {
    enableReputation(dir);
    run(['register-agent', 'copilot', '--kind', 'agent', '--set-current'], dir);
    const reflectMcpRes = run(['reflect', 'Copilot useful proposal', '--type', 'decision'], dir);
    const cndMcpId = extractId(reflectMcpRes.stdout);
    run(['accept', cndMcpId, '--by', 'testuser'], dir);

    const proc = startMcp(dir);
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_agent_board',
          arguments: {
            agent: 'copilot',
            includeReputation: true,
          },
        },
      });

      assert.ok(response.result.content[0].text.includes('Reputation: tracked='));
      assert.ok(response.result.structuredContent.reputation_summary);
      assert.equal(response.result.structuredContent.reputation_summary.enabled, true);
      assert.ok(response.result.structuredContent.agent_reputation);
      assert.equal(response.result.structuredContent.agent_reputation.agent_name, 'copilot');
    } finally {
      await stopMcp(proc);
    }
  });

  it('keeps machine-local runtime notes host-aware in MCP responses', async () => {
    run(['runtime-note', 'Host A runtime', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    run(['runtime-note', 'Host B runtime', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-b' });

    const proc = startMcp(dir, { BRAINCLAW_HOST_ID: 'host-a' });
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_agent_board',
          arguments: {
            agent: 'copilot',
          },
        },
      });

      assert.equal(response.result.structuredContent.current_host, 'host-a');
      assert.equal(response.result.structuredContent.runtime_notes.length, 1);
      assert.equal(response.result.structuredContent.runtime_notes[0].text, 'Host A runtime');
      assert.ok(!response.result.content[0].text.includes('Host B runtime'));
    } finally {
      await stopMcp(proc);
    }
  });
});
