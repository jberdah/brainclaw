import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCurrentAgentName } from '../../src/core/agent-registry.js';
import { AGENT_ENV_KEYS, createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * resolveCurrentAgentName contract (post identity-v2 refactoring):
 *   1. BRAINCLAW_AGENT_NAME or BRAINCLAW_AGENT env var (explicit)
 *   2. detectAiAgent() (auto-detection from runtime env + filesystem)
 *   3. USER or USERNAME env var
 *   4. 'unknown'
 *
 * config.current_agent is intentionally NOT checked — it causes
 * cross-agent confusion in multi-agent setups.
 */

describe('resolveCurrentAgentName', () => {
  let workspace: TestWorkspace;
  let fakeHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-resolve-agent-name-',
      projectId: 'prj_resolve_agent_name',
      currentAgent: 'testuser',
    });
    // Isolated home dir so filesystem-based detection (e.g. ~/.gemini/antigravity) doesn't trigger
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));
    // Save and clear all agent-related env vars to isolate tests
    for (const key of AGENT_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    savedEnv['USER'] = process.env.USER;
    savedEnv['USERNAME'] = process.env.USERNAME;
  });

  afterEach(() => {
    for (const key of [...AGENT_ENV_KEYS, 'USER', 'USERNAME'] as const) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    workspace.cleanup();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns BRAINCLAW_AGENT env var when set', () => {
    process.env.BRAINCLAW_AGENT = 'my-agent';
    const name = resolveCurrentAgentName(workspace.dir, fakeHome);
    assert.equal(name, 'my-agent');
  });

  it('returns BRAINCLAW_AGENT_NAME over BRAINCLAW_AGENT when both set', () => {
    process.env.BRAINCLAW_AGENT_NAME = 'explicit-name';
    process.env.BRAINCLAW_AGENT = 'fallback-name';
    const name = resolveCurrentAgentName(workspace.dir, fakeHome);
    assert.equal(name, 'explicit-name');
  });

  it('auto-detects claude-code when CLAUDE_CODE_VERSION is set', () => {
    process.env.CLAUDE_CODE_VERSION = '1.0.0';
    const name = resolveCurrentAgentName(workspace.dir, fakeHome);
    assert.equal(name, 'claude-code');
  });

  it('falls back to USER env var when no agent env or detection', () => {
    process.env.USER = 'fallback-user';
    delete process.env.USERNAME;
    const name = resolveCurrentAgentName(workspace.dir, fakeHome);
    assert.equal(name, 'fallback-user');
  });

  it('falls back to USERNAME env var when USER is absent', () => {
    delete process.env.USER;
    process.env.USERNAME = 'windows-user';
    const name = resolveCurrentAgentName(workspace.dir, fakeHome);
    assert.equal(name, 'windows-user');
  });

  it('returns unknown when no env vars or detection signals', () => {
    delete process.env.USER;
    delete process.env.USERNAME;
    const name = resolveCurrentAgentName(workspace.dir, fakeHome);
    assert.equal(name, 'unknown');
  });

  it('ignores whitespace-only BRAINCLAW_AGENT and falls through', () => {
    process.env.BRAINCLAW_AGENT = '   ';
    process.env.USER = 'env-user';
    const name = resolveCurrentAgentName(workspace.dir, fakeHome);
    assert.equal(name, 'env-user');
  });
});
