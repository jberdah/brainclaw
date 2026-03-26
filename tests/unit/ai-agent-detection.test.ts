import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { detectAiAgent } from '../../src/core/ai-agent-detection.js';

describe('detectAiAgent', () => {
  it('returns undefined when no relevant env vars or files are present', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = detectAiAgent(env, '/nonexistent-home-xyz');
    assert.equal(result, undefined);
  });

  it('BRAINCLAW_AGENT override takes highest priority', () => {
    const env: NodeJS.ProcessEnv = {
      BRAINCLAW_AGENT: 'my-custom-agent',
      CLAUDE_CODE_VERSION: '1.0.0',
      CURSOR_TRACE_ID: 'abc',
    };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'my-custom-agent');
    assert.equal(result.detection_source, 'BRAINCLAW_AGENT env var');
  });

  it('BRAINCLAW_AGENT trims whitespace', () => {
    const env: NodeJS.ProcessEnv = { BRAINCLAW_AGENT: '  trimmed-agent  ' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'trimmed-agent');
  });

  it('ignores empty BRAINCLAW_AGENT and falls through', () => {
    const env: NodeJS.ProcessEnv = { BRAINCLAW_AGENT: '   ', CLAUDE_CODE_VERSION: '1.2.3' };
    const result = detectAiAgent(env, '/nonexistent-home-xyz');
    assert.ok(result);
    assert.equal(result.name, 'claude-code');
  });

  it('detects GitHub Copilot via GITHUB_COPILOT_TOKEN', () => {
    const env: NodeJS.ProcessEnv = { GITHUB_COPILOT_TOKEN: 'token-abc' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'github-copilot');
    assert.equal(result.kind, 'agent');
    assert.equal(result.trust_level, 'trusted');
  });

  it('detects GitHub Copilot via GITHUB_COPILOT_PRODUCT', () => {
    const env: NodeJS.ProcessEnv = { GITHUB_COPILOT_PRODUCT: 'copilot-chat' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'github-copilot');
  });

  it('detects Claude Code via CLAUDE_CODE_VERSION', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_VERSION: '1.0.0' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'claude-code');
    assert.equal(result.detection_source, 'CLAUDE_CODE_VERSION env var');
  });

  it('detects Claude Code via ANTHROPIC_AI_PRODUCT', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_AI_PRODUCT: 'claude-code' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'claude-code');
  });

  it('detects Claude Code via CLAUDECODE env var (VS Code extension mode)', () => {
    const env: NodeJS.ProcessEnv = { CLAUDECODE: '1' };
    const result = detectAiAgent(env, '/nonexistent-home-xyz');
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
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'claude-code', 'CLAUDECODE should take priority over Copilot');
  });

  it('detects Cursor via CURSOR_TRACE_ID', () => {
    const env: NodeJS.ProcessEnv = { CURSOR_TRACE_ID: 'trace-123' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'cursor');
  });

  it('detects Cursor via CURSOR_SESSION_ID', () => {
    const env: NodeJS.ProcessEnv = { CURSOR_SESSION_ID: 'sess-abc' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'cursor');
  });

  it('detects Windsurf via WINDSURF_SESSION_ID', () => {
    const env: NodeJS.ProcessEnv = { WINDSURF_SESSION_ID: 'ws-session' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'windsurf');
  });

  it('detects Cline via CLINE_AGENT', () => {
    const env: NodeJS.ProcessEnv = { CLINE_AGENT: '1' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'cline');
  });

  it('detects Codex via CODEX_AGENT env var', () => {
    const env: NodeJS.ProcessEnv = { CODEX_AGENT: '1' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'codex');
    assert.equal(result.detection_source, 'CODEX_AGENT env var');
  });

  it('detects Codex via CODEX_SESSION_ID env var', () => {
    const env: NodeJS.ProcessEnv = { CODEX_SESSION_ID: 'sess_abc' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'codex');
    assert.equal(result.detection_source, 'CODEX_SESSION_ID env var');
  });

  it('does not detect Codex from ~/.codex directory alone (false positive prevention)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detect-test-'));
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir);
    try {
      const result = detectAiAgent({}, tmpHome);
      // ~/.codex directory alone should NOT trigger detection — it persists after install
      assert.equal(result, undefined);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('detects Continue via CONTINUE_AGENT', () => {
    const env: NodeJS.ProcessEnv = { CONTINUE_AGENT: '1' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'continue');
  });

  it('detects Roo via ROO_AGENT', () => {
    const env: NodeJS.ProcessEnv = { ROO_AGENT: '1' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'roo');
  });

  it('Claude Code wins over Copilot when both env vars are present (VS Code with both extensions)', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_VERSION: '1.5.0',
      GITHUB_COPILOT_TOKEN: 'token-abc',
      GITHUB_COPILOT_PRODUCT: 'copilot-chat',
      VSCODE_GIT_IPC_HANDLE: '/tmp/ipc',
    };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'claude-code', 'Claude Code should take priority over Copilot');
  });

  it('Cursor wins over Copilot when both env vars are present', () => {
    const env: NodeJS.ProcessEnv = {
      CURSOR_TRACE_ID: 'trace-123',
      GITHUB_COPILOT_TOKEN: 'token-abc',
    };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'cursor', 'Cursor should take priority over Copilot');
  });

  it('Copilot still detected when alone (no other agent env vars)', () => {
    const env: NodeJS.ProcessEnv = { GITHUB_COPILOT_TOKEN: 'token-abc' };
    const result = detectAiAgent(env, '/home/user');
    assert.ok(result);
    assert.equal(result.name, 'github-copilot');
  });

  it('all detections return kind=agent and trust_level=trusted', () => {
    const cases: NodeJS.ProcessEnv[] = [
      { GITHUB_COPILOT_TOKEN: 'x' },
      { CLAUDE_CODE_VERSION: 'x' },
      { CLAUDECODE: '1' },
      { CURSOR_TRACE_ID: 'x' },
      { WINDSURF_SESSION_ID: 'x' },
      { CLINE_AGENT: 'x' },
      { CONTINUE_AGENT: 'x' },
      { ROO_AGENT: 'x' },
    ];
    for (const env of cases) {
      const result = detectAiAgent(env, '/nonexistent-home-xyz');
      assert.ok(result, `Expected a result for ${JSON.stringify(env)}`);
      assert.equal(result.kind, 'agent', `Expected kind=agent for ${JSON.stringify(env)}`);
      assert.equal(result.trust_level, 'trusted', `Expected trust_level=trusted for ${JSON.stringify(env)}`);
    }
  });
});
