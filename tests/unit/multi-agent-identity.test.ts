import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import {
  resolveCurrentAgentIdentity,
  resolveCurrentAgentName,
  registerAgentIdentity,
} from '../../src/core/agent-registry.js';
import {
  buildOperationalIdentity,
  loadAllSessions,
  saveCurrentSession,
} from '../../src/core/identity.js';
import { startSession } from '../../src/commands/session-start.js';
import { detectAiAgent } from '../../src/core/ai-agent-detection.js';

/**
 * Multi-agent identity tests.
 *
 * Simulates a DGX-like scenario: same store, same OS user, multiple agents
 * (claude-code, codex, copilot) each with different env vars. Verifies that:
 * - Each agent is identified correctly via detectAiAgent()
 * - Sessions are distinct per agent
 * - config.current_agent does NOT influence identity resolution
 * - Auto-registration works for newly detected agents
 */
describe('multi-agent identity on shared host', () => {
  let workspace: TestWorkspace;
  const savedEnv: Record<string, string | undefined> = {};

  // Env vars to save/restore
  const ENV_KEYS = [
    'BRAINCLAW_AGENT', 'BRAINCLAW_AGENT_NAME', 'BRAINCLAW_AGENT_ID',
    'CLAUDECODE', 'CLAUDE_CODE_VERSION', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'GITHUB_COPILOT_PRODUCT', 'GITHUB_COPILOT_TOKEN',
    'CURSOR_TRACE_ID', 'CURSOR_SESSION_ID',
    'BRAINCLAW_HOST_ID',
  ];

  function clearAgentEnv(): void {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  }

  function setClaudeCodeEnv(): void {
    clearAgentEnv();
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
  }

  function setCodexEnv(): void {
    clearAgentEnv();
    process.env.CODEX_THREAD_ID = '019d2938-test-thread';
    process.env.CODEX_CI = '1';
  }

  function setCopilotEnv(): void {
    clearAgentEnv();
    process.env.GITHUB_COPILOT_PRODUCT = 'copilot-chat/1.0';
  }

  beforeEach(() => {
    // Save all env vars
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }

    workspace = createTestWorkspace({
      prefix: 'bclaw-multi-agent-',
      projectId: 'prj_multi_agent_test',
      currentAgent: 'ai_root',
    });
    process.env.BRAINCLAW_HOST_ID = 'test-host';
  });

  afterEach(() => {
    // Restore all env vars
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    workspace.cleanup();
  });

  it('detectAiAgent returns correct agent for each env configuration', () => {
    setClaudeCodeEnv();
    const claude = detectAiAgent();
    assert.ok(claude);
    assert.equal(claude.name, 'claude-code');

    setCodexEnv();
    const codex = detectAiAgent();
    assert.ok(codex);
    assert.equal(codex.name, 'codex');

    setCopilotEnv();
    const copilot = detectAiAgent();
    assert.ok(copilot);
    assert.equal(copilot.name, 'github-copilot');

    clearAgentEnv();
    const nothing = detectAiAgent(process.env);
    assert.equal(nothing, undefined);
  });

  // pln#562 step 2 — read-path resolution never registers; registration is an
  // explicit act (setup, session start, dispatch).
  it('resolveCurrentAgentIdentity resolves registered agents but does NOT auto-register detected ones', () => {
    // Register claude-code explicitly
    workspace.registerAgent('claude-code');

    setClaudeCodeEnv();
    const claude = resolveCurrentAgentIdentity(workspace.dir);
    assert.ok(claude);
    assert.equal(claude.agent_name, 'claude-code');

    // Codex is NOT pre-registered — detection alone must not mint an identity
    setCodexEnv();
    const codex = resolveCurrentAgentIdentity(workspace.dir);
    assert.equal(codex, undefined, 'read-path resolution must not auto-register codex');
  });

  it('session start (explicit act) auto-registers the detected agent at contributor', async () => {
    setCodexEnv();
    const session = await startSession({ cwd: workspace.dir });
    assert.equal(session.agent, 'codex');
    const codex = resolveCurrentAgentIdentity(workspace.dir);
    assert.ok(codex, 'codex registered by session start');
    assert.equal(codex.trust_level, 'contributor', 'auto-registration never exceeds contributor');
  });

  it('config.current_agent does NOT influence identity resolution', () => {
    // Config says current_agent is ai_root
    workspace.updateConfig(c => {
      c.current_agent = 'ai_root';
      c.current_agent_id = workspace.currentAgent.agent_id;
    });

    // But env says claude-code
    workspace.registerAgent('claude-code');
    setClaudeCodeEnv();
    const resolved = resolveCurrentAgentIdentity(workspace.dir);
    assert.ok(resolved);
    assert.equal(resolved.agent_name, 'claude-code', 'should resolve from env, not config');
  });

  it('resolveCurrentAgentName uses detectAiAgent, not config fallback', () => {
    workspace.updateConfig(c => {
      c.current_agent = 'ai_root';
    });

    setCodexEnv();
    const name = resolveCurrentAgentName(workspace.dir);
    assert.equal(name, 'codex', 'should detect codex from env, not ai_root from config');
  });

  it('sessions are distinct per agent on the same store', async () => {
    workspace.registerAgent('claude-code');
    workspace.registerAgent('codex');

    // Claude Code starts a session
    setClaudeCodeEnv();
    const claudeSession = await startSession({ cwd: workspace.dir });
    assert.equal(claudeSession.agent, 'claude-code');

    // Codex starts a session
    setCodexEnv();
    const codexSession = await startSession({ cwd: workspace.dir });
    assert.equal(codexSession.agent, 'codex');

    // Sessions should be different
    assert.notEqual(claudeSession.session_id, codexSession.session_id);

    // Both sessions visible in loadAllSessions
    const all = loadAllSessions(workspace.dir);
    const agents = all.map(s => s.agent);
    assert.ok(agents.includes('claude-code'), 'claude-code session should be listed');
    assert.ok(agents.includes('codex'), 'codex session should be listed');
  });

  it('PID-aware resolution gives distinct sessions for same agent', async () => {
    workspace.registerAgent('claude-code');
    setClaudeCodeEnv();

    // First session (current PID)
    const session1 = await startSession({ cwd: workspace.dir });
    assert.equal(session1.agent, 'claude-code');

    // Simulate a second session from a different PID by saving a session with a fake PID
    saveCurrentSession({
      schema_version: 2,
      session_id: 'sess_fake_pid',
      started_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      agent: 'claude-code',
      agent_id: session1.agent_id!,
      host_id: 'test-host',
      user: process.env.USER ?? process.env.USERNAME,
      pid: 99999, // fake PID — will be detected as dead
    }, workspace.dir);

    const all = loadAllSessions(workspace.dir);
    const claudeSessions = all.filter(s => s.agent === 'claude-code');
    assert.ok(claudeSessions.length >= 2, 'should have at least 2 claude-code sessions');
  });

  it('MCP scenario: no agent env vars falls through to undefined (not config)', () => {
    // Simulate MCP process that only has VS Code env vars (no CLAUDECODE, no CODEX_*)
    clearAgentEnv();

    // Register a SECOND agent so this is a genuine multi-agent host. pln#596 added
    // a single-registered-agent fallback that fires only at exactly one agent; with
    // >=2 registered agents and no env/detection signal, resolution must stay
    // undefined — and crucially must NOT fall back to config.current_agent.
    workspace.registerAgent('second-agent');
    workspace.updateConfig(c => {
      c.current_agent = 'ai_root';
      c.current_agent_id = workspace.currentAgent.agent_id;
    });

    const resolved = resolveCurrentAgentIdentity(workspace.dir);
    assert.equal(resolved, undefined,
      'multi-agent host with no env/detection resolves to undefined, never config.current_agent');
  });
});
