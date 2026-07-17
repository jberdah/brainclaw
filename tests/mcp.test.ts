import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import YAML from 'yaml';
import { SCHEMA_VERSION } from '../src/commands/mcp.js';
import { saveClaim } from '../src/core/claims.js';
import { saveState } from '../src/core/state.js';
import { AGENT_ENV_KEYS, sanitizedProcessEnv } from './helpers/workspace.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-mcp-'));
}

function run(args: string[], cwd: string, envOverrides: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));
  const env: NodeJS.ProcessEnv = {
    ...sanitizedProcessEnv(),
    BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
    BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '0',
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
    USERNAME: 'testuser',
    USER: 'testuser',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ...envOverrides,
  };
  for (const key of AGENT_ENV_KEYS) {
    delete env[key];
  }
  if (envOverrides.CODEX_HOME) {
    env.CODEX_HOME = envOverrides.CODEX_HOME;
  }
  const configPath = path.join(cwd, '.brainclaw', 'config.yaml');
  if (fs.existsSync(configPath)) {
    const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as { current_agent?: string; current_agent_id?: string };
    if (config.current_agent) {
      env.BRAINCLAW_AGENT_NAME = config.current_agent;
      env.BRAINCLAW_AGENT = config.current_agent;
    }
    if (config.current_agent_id) {
      env.BRAINCLAW_AGENT_ID = config.current_agent_id;
    }
  }
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
    env,
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

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function initGitRepo(dir: string): void {
  git(['init'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
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
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));
  const env: NodeJS.ProcessEnv = {
    ...sanitizedProcessEnv(),
    BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
    BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '0',
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
    USERNAME: 'testuser',
    USER: 'testuser',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ...envOverrides,
  };
  for (const key of AGENT_ENV_KEYS) {
    delete env[key];
  }
  const configPath = path.join(cwd, '.brainclaw', 'config.yaml');
  if (fs.existsSync(configPath)) {
    const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as { current_agent?: string; current_agent_id?: string };
    if (config.current_agent) {
      env.BRAINCLAW_AGENT_NAME = config.current_agent;
      env.BRAINCLAW_AGENT = config.current_agent;
    }
    if (config.current_agent_id) {
      env.BRAINCLAW_AGENT_ID = config.current_agent_id;
    }
  }
  return spawn(NODE, [CLI_PATH, 'mcp'], {
    cwd,
    stdio: 'pipe',
    env,
  });
}

function writeMcp(proc: ChildProcessWithoutNullStreams, payload: unknown): void {
  const json = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(json, 'utf-8');
  proc.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${json}`);
}

/**
 * Parse a Content-Length framed message from a buffer.
 * Returns the parsed JSON and the remaining buffer, or null if incomplete.
 */
function parseContentLengthMessage(buffer: Buffer): { message: unknown; remaining: Buffer } | null {
  const str = buffer.toString('utf-8');
  const sepIndex = str.indexOf('\r\n\r\n');
  if (sepIndex === -1) return null;

  const headers = str.slice(0, sepIndex);
  const match = headers.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;

  const contentLength = parseInt(match[1], 10);
  const bodyStartBytes = Buffer.byteLength(str.slice(0, sepIndex + 4), 'utf-8');
  if (buffer.length < bodyStartBytes + contentLength) return null;

  const body = buffer.subarray(bodyStartBytes, bodyStartBytes + contentLength).toString('utf-8');
  return {
    message: JSON.parse(body),
    remaining: buffer.subarray(bodyStartBytes + contentLength),
  };
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
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseContentLengthMessage(buffer);
      if (!parsed) return;

      cleanup();
      resolve(parsed.message);
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
    writeMcp(proc, request);
  });
}

function sendMcpNotification(proc: ChildProcessWithoutNullStreams, notification: unknown): Promise<void> {
  return new Promise((resolve) => {
    writeMcp(proc, notification);
    setTimeout(resolve, 25);
  });
}

function waitForNextMcpMessage(proc: ChildProcessWithoutNullStreams, timeoutMs: number = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response: ${stderr}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseContentLengthMessage(buffer);
      if (!parsed) return;

      cleanup();
      resolve(parsed.message);
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    };

    const onExit = () => {
      cleanup();
      reject(new Error(`MCP process exited unexpectedly: ${stderr}`));
    };

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

async function expectNoMcpMessage(proc: ChildProcessWithoutNullStreams, durationMs: number = 250): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onData = () => {
      cleanup();
      reject(new Error('Unexpected MCP response received'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout.off('data', onData);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    proc.stdout.on('data', onData);
  });
}

async function initializeMcp(proc: ChildProcessWithoutNullStreams, protocolVersion: '2024-11-05' | '2025-11-25' = '2025-11-25'): Promise<any> {
  const response = await sendMcpRequest(proc, {
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocolVersion },
  });
  await sendMcpNotification(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}

describe('MCP server', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y', '--no-analyze-repo'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists available tools', async () => {
    const proc = startMcp(dir);
    try {
      const init = await initializeMcp(proc);
      assert.equal(init.result.protocolVersion, '2025-11-25');
      const response = await sendMcpRequest(proc, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(response.jsonrpc, '2.0');
      assert.ok(Array.isArray(response.result.tools));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_work'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_coordinate'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_context'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_session_start'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_session_end'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_claim'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_release_claim'));
      // Legacy per-entity list/accept/reject tools were removed from the default
      // discoverable surface in v1.0 (canonical grammar: bclaw_find / bclaw_get /
      // bclaw_transition). They remain callable as legacy handlers / via catalog=all.
      assert.ok(!response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_list_plans'));
      assert.ok(!response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_list_claims'));
      assert.ok(!response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_list_candidates'));
      assert.ok(!response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_accept'));
      assert.ok(!response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_reject'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_read_inbox'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_quick_capture'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_switch'));
      assert.ok(!response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_list_agents'));
      assert.ok(!response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_list_instructions'));
    } finally {
      await stopMcp(proc);
    }
  });

  it('routes MCP writes to the switched child project store in a multi-project workspace', async () => {
    run(['init', '-y', '--force', '--project-mode', 'multi-project', '--project-strategy', 'folder', '--no-analyze-repo'], dir);

    const child = path.join(dir, 'applications', 'lodestar');
    fs.mkdirSync(child, { recursive: true });
    run(['init', '-y', '--no-analyze-repo'], child);

    const proc = startMcp(dir, { BRAINCLAW_CWD: dir });
    try {
      await initializeMcp(proc);

      const switched = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 'switch-lodestar',
        method: 'tools/call',
        params: {
          name: 'bclaw_switch',
          arguments: {
            project: 'applications/lodestar',
          },
        },
      });

      assert.equal(switched.result.isError, false);
      assert.equal(switched.result.structuredContent.path, child);

      const created = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 'create-plan-in-child',
        method: 'tools/call',
        params: {
          name: 'bclaw_create',
          arguments: {
            entity: 'plan',
            data: {
              text: 'Plan should follow active switched project',
            },
          },
        },
      });

      assert.equal(created.result.isError, false);
      const planId = created.result.structuredContent.id;
      assert.match(planId, /^pln_[a-f0-9]+$/);

      const childPlanPath = path.join(child, '.brainclaw', 'coordination', 'plans', `${planId}.json`);
      const rootPlanPath = path.join(dir, '.brainclaw', 'coordination', 'plans', `${planId}.json`);
      assert.equal(fs.existsSync(childPlanPath), true, 'plan should be written to the switched child store');
      assert.equal(fs.existsSync(rootPlanPath), false, 'plan should not be written to the workspace store');
    } finally {
      await stopMcp(proc);
    }
  });

  it('returns the full catalog when tools/list requests catalog=all', async () => {
    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { catalog: 'all' },
      });
      assert.equal(response.jsonrpc, '2.0');
      assert.ok(Array.isArray(response.result.tools));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_list_agents'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_list_instructions'));
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'bclaw_dispatch'));
    } finally {
      await stopMcp(proc);
    }
  });

  it('exposes list-oriented coordination views over MCP', async () => {
    run(['register-agent', 'copilot', '--kind', 'agent'], dir);
    run(['instruction', 'Read shared memory before editing'], dir);
    run(['instruction', 'Use auth gateway conventions', '--layer', 'project', '--project', 'auth'], dir);
    const planRes = run(['plan', 'Own auth rollout', '--project', 'auth'], dir);
    const planId = extractId(planRes.stdout);
    run(['claim', 'Taking auth rollout', '--agent', 'copilot', '--scope', 'src/auth/', '--plan', planId], dir);
    run(['set-trust', 'testuser', '--level', 'contributor'], dir);
    const candidateRes = run(['reflect', 'Auth edge-case note', '--type', 'decision'], dir);
    const candidateId = extractId(candidateRes.stdout);

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);

      const plans = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'bclaw_list_plans',
          // `project` is now a cross-project ROUTING key (unknown names throw),
          // not a plan-attribute filter — list within the current store instead.
          arguments: {},
        },
      });
      assert.equal(plans.result.structuredContent.total, 1);
      assert.equal(plans.result.structuredContent.plans[0].id, planId);

      const claims = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'bclaw_list_claims',
          arguments: { agent: 'github-copilot' },
        },
      });
      assert.equal(claims.result.structuredContent.total, 1);
      assert.equal(claims.result.structuredContent.claims[0].plan_id, planId);

      const agents = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
          name: 'bclaw_list_agents',
          arguments: {},
        },
      });
      // pln#625 Phase 2c — bclaw_list_agents now redacts through projectAgentForRead:
      // agent_name → name, and NO key material / invoke.env leaks.
      assert.ok(agents.result.structuredContent.agents.some((agent: any) => agent.name === 'github-copilot'));
      assert.ok(
        agents.result.structuredContent.agents.every((agent: any) => agent.identity_key === undefined && agent.invoke === undefined),
        'bclaw_list_agents must not surface identity_key or invoke',
      );
      assert.equal(agents.result.structuredContent.current_agent, 'testuser');

      const instructions = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          // `project` is cross-project routing now (throws on unknown names),
          // so list the raw active instructions in this store instead of
          // resolving against a project scope.
          name: 'bclaw_list_instructions',
          arguments: { active: true },
        },
      });
      assert.equal(instructions.result.structuredContent.total, 2);
      assert.ok(instructions.result.structuredContent.instructions.some((entry: any) => entry.text.includes('Use auth gateway conventions')));

      const candidates = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/call',
        params: {
          name: 'bclaw_list_candidates',
          arguments: { status: 'pending' },
        },
      });
      assert.equal(candidates.result.structuredContent.total, 1);
      assert.equal(candidates.result.structuredContent.candidates[0].id, candidateId);
    } finally {
      await stopMcp(proc);
    }
  });

  it('requires initialization before tool access and supports the legacy protocol version', async () => {
    const proc = startMcp(dir);
    try {
      const beforeInit = await sendMcpRequest(proc, { jsonrpc: '2.0', id: 'pre', method: 'tools/list' });
      assert.equal(beforeInit.error.code, -32002);

      const init = await initializeMcp(proc, '2024-11-05');
      assert.equal(init.result.protocolVersion, '2024-11-05');

      const response = await sendMcpRequest(proc, { jsonrpc: '2.0', id: 'list-legacy', method: 'tools/list' });
      assert.ok(Array.isArray(response.result.tools));
    } finally {
      await stopMcp(proc);
    }
  });

  it('negotiates down to the latest supported protocol version for newer clients', async () => {
    const proc = startMcp(dir);
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 'init-future',
        method: 'initialize',
        params: { protocolVersion: '2099-01-01' },
      });

      assert.equal(response.result.protocolVersion, '2024-11-05');

      await sendMcpNotification(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const tools = await sendMcpRequest(proc, { jsonrpc: '2.0', id: 'list-after-future-init', method: 'tools/list' });
      assert.ok(Array.isArray(tools.result.tools));
    } finally {
      await stopMcp(proc);
    }
  });

  it('returns MCP tool errors instead of protocol errors for invalid tool calls', async () => {
    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 'bad-tool',
        method: 'tools/call',
        params: {
          name: 'bclaw_search',
          arguments: {},
        },
      });

      assert.equal(response.result.isError, true);
      assert.equal(response.result.schema_version, SCHEMA_VERSION);
      assert.equal(response.result.structuredContent.error.kind, 'command_error');
    } finally {
      await stopMcp(proc);
    }
  });

  it('persists critical-priority plans so they remain listable and step-editable', async () => {
    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);

      const created = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 'create-critical-plan',
        method: 'tools/call',
        params: {
          name: 'bclaw_create_plan',
          arguments: {
            text: 'Critical MCP plan persistence regression',
            type: 'fix',
            priority: 'critical',
            estimate: 15,
          },
        },
      });

      assert.equal(created.result.isError, false);
      const planId = created.result.plan_id;
      assert.ok(typeof planId === 'string' && planId.startsWith('pln_'));

      const listed = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 'list-critical-plan',
        method: 'tools/call',
        params: {
          name: 'bclaw_list_plans',
          arguments: {
            id: planId,
            all: true,
          },
        },
      });

      assert.equal(listed.result.isError, false);
      assert.equal(listed.result.structuredContent.total, 1);
      assert.equal(listed.result.structuredContent.plans[0].id, planId);
      assert.equal(listed.result.structuredContent.plans[0].priority, 'critical');

      const addedStep = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 'add-step-critical-plan',
        method: 'tools/call',
        params: {
          name: 'bclaw_add_step',
          arguments: {
            planId,
            text: 'Verify step persistence after critical priority create',
          },
        },
      });

      assert.equal(addedStep.result.isError, false);
      assert.equal(addedStep.result.plan_id, planId);
      assert.equal(addedStep.result.progress.total, 1);
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
      await initializeMcp(proc);
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

  it('includes digest and scoped activity in MCP context responses when requested', async () => {
    run(['decision', 'Auth gateway owns OAuth routing', '--tag', 'auth', '--path', 'src/auth/routes.ts'], dir);
    run(['trap', 'Auth routes fail without the gateway policy sync', '--severity', 'high', '--tag', 'auth', '--path', 'src/auth/routes.ts'], dir);
    run(['runtime-note', 'Auth routes rollout in progress', '--tag', 'auth'], dir, {
      BRAINCLAW_SESSION_ID: 'sess_digest_ctx',
    });

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_context',
          arguments: {
            path: 'src/auth/routes.ts',
            digest: true,
          },
        },
      });

      const text = response.result.content[0].text as string;
      assert.match(text, /^Digest:/m);
      assert.ok(typeof response.result.structuredContent.digest === 'string');
      assert.equal(response.result.structuredContent.scoped_activity.scope, 'src/auth/routes.ts');
      assert.equal(response.result.structuredContent.scoped_activity.recent_notes, 1);
    } finally {
      await stopMcp(proc);
    }
  });

  it('supports brownfield bootstrap and sparse-memory context fallback over MCP', async () => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Brownfield Auth\n\n## Test\n\n- npm test\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent Guide\n\n- Read AGENTS.md before edits\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { test: 'npm test' },
    }, null, 2), 'utf-8');

    // This test exercises the real brownfield bootstrap probe, which is skipped
    // when BRAINCLAW_TEST_MODE=1 (context.ts) — the harness sets that globally,
    // so it must be turned off here or bootstrap_available is always false.
    const proc = startMcp(dir, { BRAINCLAW_TEST_MODE: '0' });
    try {
      await initializeMcp(proc);
      const bootstrap = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'bclaw_bootstrap',
          arguments: {
            target: 'src/auth/routes.ts',
          },
        },
      });

      assert.equal(bootstrap.result.isError, false);
      assert.ok(bootstrap.result.structuredContent.seed_count > 0);
      assert.ok(Array.isArray(bootstrap.result.structuredContent.seeds));

      const context = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_context',
          arguments: {
            path: 'src/auth/routes.ts',
            format: 'json',
          },
        },
      });

      assert.equal(context.result.structuredContent.context_schema, '1.2');
      assert.equal(context.result.structuredContent.memory_density, 'low');
      assert.equal(context.result.structuredContent.bootstrap_available, true);
      assert.ok(Array.isArray(context.result.structuredContent.derived_signals));
      assert.ok(context.result.structuredContent.derived_signals.length > 0);
      assert.deepEqual(context.result.structuredContent.agent_tooling.agents_rules, ['Read AGENTS.md before edits']);

      const started = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 26,
        method: 'tools/call',
        params: {
          name: 'bclaw_session_start',
          arguments: {
            agent: 'testuser',
            context: 'auth',
          },
        },
      });
      const startedSessionId = started.result.session_id;
      run(['decision', 'Auth deploys are frozen', '--tag', 'auth'], dir);

      const diffedContext = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 27,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_context',
          arguments: {
            path: 'auth',
            format: 'json',
            since_session: startedSessionId,
          },
        },
      });
      assert.equal(diffedContext.result.structuredContent.context_schema, '1.2');
      assert.equal(diffedContext.result.structuredContent.context_diff.since_session, startedSessionId);
      assert.equal(diffedContext.result.structuredContent.context_diff.counts.decisions, 1);
    } finally {
      await stopMcp(proc);
    }
  });

  it('bclaw_session_start returns context and board inline when requested', async () => {
    run(['decision', 'Auth gateway routes OAuth', '--tag', 'auth'], dir);
    run(['plan', 'Fix auth expiry bug'], dir);

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: 'bclaw_session_start',
          arguments: {
            agent: 'testuser',
            context: 'auth',
            includeContext: true,
            includeBoard: true,
          },
        },
      });

      assert.equal(response.result.isError, false);
      assert.ok(response.result.session_id);

      // context embedded
      assert.ok(response.result.context, 'context should be present in structured output');
      assert.equal(response.result.context.context_schema, '1.2');

      // board embedded
      assert.ok(response.result.board, 'board should be present in structured output');
      assert.ok(Array.isArray(response.result.board.active_plans));
      assert.ok(response.result.board.active_plans.length > 0);

      // content should include at least 3 parts (session + context + board)
      assert.ok(response.result.content.length >= 3);
    } finally {
      await stopMcp(proc);
    }
  });

  it('bclaw_session_start allows opting into the fast path explicitly', async () => {
    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [],
      plan_items: Array.from({ length: 50 }, (_, index) => ({
        id: `pln_done_${index}`,
        text: `Completed plan ${index}`,
        status: 'done',
        priority: 'medium',
        type: 'chore',
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        author: 'testuser',
        project_id: 'prj_test',
        tags: [],
        depends_on: [],
      })),
    }, dir);

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);

      const fullResponse = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'bclaw_session_start',
          arguments: {
            agent: 'testuser',
            maintenanceMode: 'full',
          },
        },
      });
      assert.equal(fullResponse.result.memory_pressure.memory_pressure, true);
      assert.equal(fullResponse.result.memory_pressure.done_plans, 50);

      const fastResponse = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'bclaw_session_start',
          arguments: {
            agent: 'testuser',
            maintenanceMode: 'fast',
          },
        },
      });
      assert.equal(fastResponse.result.memory_pressure, undefined);
    } finally {
      await stopMcp(proc);
    }
  });

  it('bclaw_session_end can reflect a handoff and auto-dispatch review', async () => {
    initGitRepo(dir);
    run(['register-agent', 'codex', '--kind', 'agent'], dir);
    fs.writeFileSync(path.join(dir, 'tracked.ts'), 'export const value = 1;\n', 'utf-8');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'init'], dir);

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [],
      plan_items: [{
        id: 'pln_review_loop',
        text: 'Implement the review loop handoff',
        status: 'done',
        priority: 'high',
        type: 'feat',
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        completed_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        author: 'testuser',
        tags: ['review-loop'],
        depends_on: [],
      }],
    }, dir);
    saveClaim({
      schema_version: 2,
      id: 'clm_review_loop',
      agent: 'testuser',
      scope: 'tracked.ts',
      description: 'Completed the review loop slice',
      created_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      released_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      plan_id: 'pln_review_loop',
      status: 'released',
    }, dir);

    const proc = startMcp(dir, { BRAINCLAW_SESSION_ID: 'sess_review_loop' });
    try {
      await initializeMcp(proc);

      await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'bclaw_session_start',
          arguments: {
            agent: 'testuser',
          },
        },
      });

      fs.writeFileSync(path.join(dir, 'tracked.ts'), 'export const value = 2;\n', 'utf-8');
      git(['add', 'tracked.ts'], dir);
      git(['commit', '-m', 'feat: update tracked value'], dir);

      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'bclaw_session_end',
          arguments: {
            agent: 'testuser',
            reflectHandoff: true,
            dispatchReview: true,
            reviewer: 'codex',
          },
        },
      });

      assert.equal(response.result.isError, false);
      assert.ok(response.result.handoff);
      assert.equal(response.result.handoff.plan_id, 'pln_review_loop');
      assert.equal(response.result.handoff.review_dispatched, true);
      assert.equal(response.result.handoff.reviewer, 'codex');

      const inboxDir = path.join(dir, '.brainclaw', 'coordination', 'inbox', 'codex');
      const reviewFiles = fs.readdirSync(inboxDir).filter((file) => file.endsWith('.json'));
      assert.equal(reviewFiles.length, 1);
    } finally {
      await stopMcp(proc);
    }
  });

  it('returns execution context and local agent tooling through MCP', async () => {
    const configPath = path.join(dir, '.brainclaw', 'config.yaml');
    const config = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
    config.brainclaw_update_source = {
      type: 'local-pack',
      manifest_path: '.releases/brainclaw-local.json',
    };
    fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8');
    fs.mkdirSync(path.join(dir, '.releases'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.releases', 'brainclaw-local.json'), JSON.stringify({
      version: 1,
      channel: 'local-pack',
      package_name: 'brainclaw',
      latest_installable_version: '99.0.0',
      artifact_path: './brainclaw-99.0.0.tgz',
      install_command: 'npm install -g "./.releases/brainclaw-99.0.0.tgz"',
      release_notes: 'Local release ready for upgrade.',
    }, null, 2), 'utf-8');

    const codexHome = path.join(dir, '.codex');
    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'openai-docs'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'skills', '.system', 'openai-docs', 'SKILL.md'),
      '# OpenAI Docs\n\nUse when official OpenAI docs are needed.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.atlassian]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]\n',
      'utf-8',
    );

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 26,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_execution_context',
          arguments: {
            includeAgentTooling: true,
          },
        },
      });

      assert.equal(response.result.isError, false);
      assert.ok(response.result.structuredContent.execution_context);
      assert.equal(response.result.structuredContent.installable_update.status, 'update_available');
      assert.equal(response.result.structuredContent.installable_update.latest_installable_version, '99.0.0');
      assert.ok(Array.isArray(response.result.structuredContent.execution_context.toolchains));
      assert.ok(response.result.structuredContent.agent_tooling.skills.some((skill: { name?: string }) => skill.name === 'openai-docs'));
      assert.ok(response.result.structuredContent.agent_tooling.mcp_servers.some((server: { name?: string; availability?: string }) => server.name === 'atlassian' && server.availability === 'remote'));
    } finally {
      await stopMcp(proc);
    }
  });

  it('renders explain mode for markdown context responses', async () => {
    run(['decision', 'Auth gateway routes OAuth', '--tag', 'auth'], dir);
    run(['instruction', 'Check auth gateway conventions first'], dir);

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
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
      await initializeMcp(proc);
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
    run(['register-agent', 'copilot', '--kind', 'agent'], dir);
    run(['instruction', 'Read auth memory first', '--layer', 'project', '--project', 'auth'], dir);
    const mcpPlanRes = run(['plan', 'Own auth rollout', '--project', 'auth'], dir);
    const mcpPlanId = extractId(mcpPlanRes.stdout);
    run(['claim', 'Taking auth rollout', '--agent', 'copilot', '--scope', 'src/auth/', '--plan', mcpPlanId], dir);
    run(['runtime-note', 'Started auth rollout', '--agent', 'copilot', '--plan', mcpPlanId], dir);
    run(['handoff', '--from', 'copilot', '--to', 'claude', 'Review auth patch', '--tag', 'auth'], dir);

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_agent_board',
          arguments: {
            // Query by the canonical name — writes store under 'github-copilot'
            // (pln#562) and board reads resolve the agent scope verbatim. No
            // `project`/`path`: `project` is now a cross-project ROUTING key that
            // throws on a plain namespace like 'auth', and the "(project)" header
            // suffix only appears for a routed project, not a plan attribute.
            agent: 'github-copilot',
          },
        },
      });

      assert.ok(response.result.content[0].text.includes('Agent board for github-copilot'));
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
    run(['set-trust', 'testuser', '--level', 'curator'], dir);
    run(['register-agent', 'copilot', '--kind', 'agent', '--set-current'], dir);
    const reflectMcpRes = run(['reflect', 'Copilot useful proposal', '--type', 'decision'], dir);
    const cndMcpId = extractId(reflectMcpRes.stdout);
    run(['accept', cndMcpId, '--by', 'testuser'], dir);

    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
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
      assert.equal(response.result.structuredContent.agent_reputation.agent_name, 'github-copilot');
    } finally {
      await stopMcp(proc);
    }
  });

  it('keeps machine-local runtime notes host-aware in MCP responses', async () => {
    run(['register-agent', 'copilot', '--kind', 'agent'], dir);
    run(['runtime-note', 'Host A runtime', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    run(['runtime-note', 'Host B runtime', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-b' });

    const proc = startMcp(dir, { BRAINCLAW_HOST_ID: 'host-a' });
    try {
      await initializeMcp(proc);
      const response = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'bclaw_get_agent_board',
          arguments: {
            // Canonical name — machine-local notes are stored under
            // 'github-copilot' (pln#562); board reads don't canonicalize input.
            agent: 'github-copilot',
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

  it('reuses one implicit MCP session across writes and returns auto-reflect metadata', async () => {
    run(['register-agent', 'copilot', '--kind', 'agent'], dir);
    const proc = startMcp(dir);
    try {
      await initializeMcp(proc);
      const first = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'bclaw_write_note',
          arguments: {
            agent: 'copilot',
            text: 'Use auth gateway convention for new routes',
            tags: ['auth'],
            autoReflect: true,
          },
        },
      });

      const second = await sendMcpRequest(proc, {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'bclaw_write_note',
          arguments: {
            agent: 'copilot',
            text: 'Second auth runtime note',
            tags: ['auth'],
          },
        },
      });

      assert.match(first.result.session_id, /^sess_[a-f0-9]+$/);
      assert.equal(second.result.session_id, first.result.session_id);
      assert.equal(first.result.auto_reflect_attempted, true);
      assert.match(first.result.candidate_id, /^cnd_[a-f0-9]+$/);
      assert.equal(first.result.skip_reason, undefined);
      assert.equal(second.result.auto_reflect_attempted, false);

      const currentSession = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'sessions', `${first.result.session_id}.json`), 'utf-8'));
      assert.equal(currentSession.session_id, first.result.session_id);

      const inboxFile = path.join(dir, '.brainclaw', 'coordination', 'inbox', `${first.result.candidate_id}.json`);
      assert.equal(fs.existsSync(inboxFile), true);
    } finally {
      await stopMcp(proc);
    }
  });

  it('cancels an in-flight write request without corrupting the next session-aware write', async () => {
    run(['register-agent', 'copilot', '--kind', 'agent'], dir);
    const proc = startMcp(dir, { BRAINCLAW_MCP_TEST_DELAY_MS: '150' });
    try {
      await initializeMcp(proc);

      writeMcp(proc, {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'bclaw_write_note',
          arguments: {
            agent: 'copilot',
            text: 'Delayed note',
            tags: ['auth'],
          },
        },
      });

      await sendMcpNotification(proc, {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 30 },
      });

      writeMcp(proc, {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'bclaw_write_note',
          arguments: {
            agent: 'copilot',
            text: 'Follow-up note',
            tags: ['auth'],
          },
        },
      });

      const response = await waitForNextMcpMessage(proc, 10000);
      assert.equal(response.id, 31);
      assert.equal(response.result.isError, false);
      assert.match(response.result.session_id, /^sess_[a-f0-9]+$/);
      await expectNoMcpMessage(proc, 300);

      // Notes written via agent 'copilot' are stored under the canonical
      // 'github-copilot' directory (pln#562 alias normalization on write).
      const runtimeDir = path.join(dir, '.brainclaw', 'coordination', 'runtime', 'github-copilot');
      const runtimeFiles = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir).filter((file) => file.endsWith('.json')) : [];
      assert.equal(runtimeFiles.length, 1);

      const note = JSON.parse(fs.readFileSync(path.join(runtimeDir, runtimeFiles[0]!), 'utf-8'));
      assert.equal(note.text, 'Follow-up note');

      const currentSession = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'sessions', `${response.result.session_id}.json`), 'utf-8'));
      assert.equal(currentSession.session_id, response.result.session_id);
    } finally {
      await stopMcp(proc);
    }
  });
});

