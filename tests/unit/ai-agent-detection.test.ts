import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { detectAiAgent } from '../../src/core/ai-agent-detection.js';
import { buildAgentInventory, isAgentInstalledPerInventory } from '../../src/core/agent-inventory.js';

describe('detectAiAgent', () => {
  it('returns undefined when no relevant env vars are present', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = detectAiAgent(env);
    assert.equal(result, undefined);
  });

  it('BRAINCLAW_AGENT override takes highest priority', () => {
    const env: NodeJS.ProcessEnv = {
      BRAINCLAW_AGENT: 'my-custom-agent',
      CLAUDE_CODE_VERSION: '1.0.0',
      CURSOR_TRACE_ID: 'abc',
    };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'my-custom-agent');
    assert.equal(result.detection_source, 'BRAINCLAW_AGENT env var');
  });

  it('BRAINCLAW_AGENT trims whitespace', () => {
    const env: NodeJS.ProcessEnv = { BRAINCLAW_AGENT: '  trimmed-agent  ' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'trimmed-agent');
  });

  it('ignores empty BRAINCLAW_AGENT and falls through', () => {
    const env: NodeJS.ProcessEnv = { BRAINCLAW_AGENT: '   ', CLAUDE_CODE_VERSION: '1.2.3' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'claude-code');
  });

  it('detects GitHub Copilot via GITHUB_COPILOT_TOKEN', () => {
    const env: NodeJS.ProcessEnv = { GITHUB_COPILOT_TOKEN: 'token-abc' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'github-copilot');
    assert.equal(result.kind, 'agent');
  });

  it('detects GitHub Copilot via GITHUB_COPILOT_PRODUCT', () => {
    const env: NodeJS.ProcessEnv = { GITHUB_COPILOT_PRODUCT: 'copilot-chat' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'github-copilot');
  });

  it('detects Claude Code via CLAUDE_CODE_VERSION', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_VERSION: '1.0.0' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'claude-code');
    assert.equal(result.detection_source, 'CLAUDE_CODE_VERSION env var');
  });

  it('detects Claude Code via ANTHROPIC_AI_PRODUCT', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_AI_PRODUCT: 'claude-code' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'claude-code');
  });

  it('detects Claude Code via CLAUDECODE env var (VS Code extension mode)', () => {
    const env: NodeJS.ProcessEnv = { CLAUDECODE: '1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'claude-code');
    assert.equal(result.detection_source, 'CLAUDECODE env var');
  });

  it('Claude Code via CLAUDECODE wins over Copilot when both present', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDECODE: '1',
      GITHUB_COPILOT_TOKEN: 'token-abc',
      GITHUB_COPILOT_PRODUCT: 'copilot-chat',
    };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'claude-code', 'CLAUDECODE should take priority over Copilot');
  });

  it('detects Cursor via CURSOR_TRACE_ID', () => {
    const env: NodeJS.ProcessEnv = { CURSOR_TRACE_ID: 'trace-123' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'cursor');
  });

  it('detects Cursor via CURSOR_SESSION_ID', () => {
    const env: NodeJS.ProcessEnv = { CURSOR_SESSION_ID: 'sess-abc' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'cursor');
  });

  it('detects Windsurf via WINDSURF_SESSION_ID', () => {
    const env: NodeJS.ProcessEnv = { WINDSURF_SESSION_ID: 'ws-session' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'windsurf');
  });

  it('detects Cline via CLINE_AGENT', () => {
    const env: NodeJS.ProcessEnv = { CLINE_AGENT: '1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'cline');
  });

  it('detects Codex via CODEX_THREAD_ID env var', () => {
    const env: NodeJS.ProcessEnv = { CODEX_THREAD_ID: '019d2938-ba18-7112-a77c-cf15e784c748' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'codex');
    assert.equal(result.detection_source, 'CODEX_THREAD_ID env var');
  });

  it('detects Codex via CODEX_CI env var', () => {
    const env: NodeJS.ProcessEnv = { CODEX_CI: '1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'codex');
    assert.equal(result.detection_source, 'CODEX_CI env var');
  });

  it('detects Continue via CONTINUE_AGENT', () => {
    const env: NodeJS.ProcessEnv = { CONTINUE_AGENT: '1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'continue');
  });

  it('detects Roo via ROO_AGENT', () => {
    const env: NodeJS.ProcessEnv = { ROO_AGENT: '1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'roo');
  });

  it('detects OpenCode via OPENCODE_SESSION_ID', () => {
    const env: NodeJS.ProcessEnv = { OPENCODE_SESSION_ID: 'oc-1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'opencode');
  });

  it('detects Antigravity via ANTIGRAVITY_AGENT', () => {
    const env: NodeJS.ProcessEnv = { ANTIGRAVITY_AGENT: '1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'antigravity');
  });

  it('detects OpenClaw via OPENCLAW_AGENT', () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_AGENT: '1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'openclaw');
  });

  it('detects Mistral Vibe via VIBE_HOME', () => {
    const env: NodeJS.ProcessEnv = { VIBE_HOME: '/opt/vibe' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'mistral-vibe');
  });

  it('detects Hermes via HERMES_SESSION_ID', () => {
    const env: NodeJS.ProcessEnv = { HERMES_SESSION_ID: 'h-1' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'hermes');
    assert.equal(result.kind, 'autonomous');
  });

  it('Claude Code wins over Copilot when both env vars are present (VS Code with both extensions)', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_VERSION: '1.5.0',
      GITHUB_COPILOT_TOKEN: 'token-abc',
      GITHUB_COPILOT_PRODUCT: 'copilot-chat',
      VSCODE_GIT_IPC_HANDLE: '/tmp/ipc',
    };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'claude-code', 'Claude Code should take priority over Copilot');
  });

  it('Cursor wins over Copilot when both env vars are present', () => {
    const env: NodeJS.ProcessEnv = {
      CURSOR_TRACE_ID: 'trace-123',
      GITHUB_COPILOT_TOKEN: 'token-abc',
    };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'cursor', 'Cursor should take priority over Copilot');
  });

  it('Copilot still detected when alone (no other agent env vars)', () => {
    const env: NodeJS.ProcessEnv = { GITHUB_COPILOT_TOKEN: 'token-abc' };
    const result = detectAiAgent(env);
    assert.ok(result);
    assert.equal(result.name, 'github-copilot');
  });
});

// pln#562 step 1 — detection/inventory split: detectAiAgent is env-only;
// directory presence proves installation (inventory), never identity.
describe('detectAiAgent — env-only (no directory fallbacks)', () => {
  it('never detects from config directories alone', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detect-split-'));
    try {
      fs.mkdirSync(path.join(tmpHome, '.codex'));
      fs.mkdirSync(path.join(tmpHome, '.openclaw'));
      fs.mkdirSync(path.join(tmpHome, '.vibe'));
      fs.mkdirSync(path.join(tmpHome, '.hermes'));
      fs.mkdirSync(path.join(tmpHome, '.config', 'opencode'), { recursive: true });
      fs.mkdirSync(path.join(tmpHome, '.gemini', 'antigravity'), { recursive: true });
      const savedHome = process.env.HOME;
      const savedProfile = process.env.USERPROFILE;
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      try {
        // Empty env + populated home: directory presence must not mint identity.
        const result = detectAiAgent({});
        assert.equal(result, undefined);
      } finally {
        if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
        if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('directory presence flows into the agent inventory as installed', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-inventory-split-'));
    try {
      fs.mkdirSync(path.join(tmpHome, '.openclaw'));
      fs.mkdirSync(path.join(tmpHome, '.vibe'));
      fs.mkdirSync(path.join(tmpHome, '.config', 'opencode'), { recursive: true });
      const inv = buildAgentInventory(tmpHome, {}, { spawnableResolver: () => false });
      const byName = new Map(inv.agents.map((a) => [a.name, a]));
      assert.equal(byName.get('openclaw')?.installed, true, 'openclaw installed via ~/.openclaw');
      assert.equal(byName.get('mistral-vibe')?.installed, true, 'mistral-vibe installed via ~/.vibe');
      assert.equal(byName.get('opencode')?.installed, true, 'opencode installed via ~/.config/opencode');
      assert.equal(isAgentInstalledPerInventory('openclaw', inv), true);
      assert.equal(isAgentInstalledPerInventory('mistral-vibe', inv), true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('isAgentInstalledPerInventory returns undefined for untracked agents', () => {
    const inv = buildAgentInventory('/no/such/home', {}, { spawnableResolver: () => false });
    assert.equal(isAgentInstalledPerInventory('totally-unknown-agent', inv), undefined);
    assert.equal(isAgentInstalledPerInventory('cline', inv), false);
  });
});
