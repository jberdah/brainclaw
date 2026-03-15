import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentAgentName } from '../../src/core/agent-registry.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('resolveCurrentAgentName', () => {
  let workspace: TestWorkspace;
  let savedUser: string | undefined;
  let savedUsername: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-resolve-agent-name-',
      projectId: 'prj_resolve_agent_name',
      currentAgent: 'copilot',
    });
    savedUser = process.env.USER;
    savedUsername = process.env.USERNAME;
  });

  afterEach(() => {
    if (savedUser === undefined) delete process.env.USER; else process.env.USER = savedUser;
    if (savedUsername === undefined) delete process.env.USERNAME; else process.env.USERNAME = savedUsername;
    workspace.cleanup();
  });

  it('returns current_agent from config when set', () => {
    const name = resolveCurrentAgentName(workspace.dir);
    assert.equal(name, 'copilot');
  });

  it('falls back to USER env var when config has no current_agent', () => {
    workspace.updateConfig((c) => { c.current_agent = undefined as unknown as string; });
    process.env.USER = 'fallback-user';
    delete process.env.USERNAME;
    const name = resolveCurrentAgentName(workspace.dir);
    assert.equal(name, 'fallback-user');
  });

  it('falls back to USERNAME env var when USER is absent', () => {
    workspace.updateConfig((c) => { c.current_agent = undefined as unknown as string; });
    delete process.env.USER;
    process.env.USERNAME = 'windows-user';
    const name = resolveCurrentAgentName(workspace.dir);
    assert.equal(name, 'windows-user');
  });

  it('returns unknown when no config, USER, or USERNAME', () => {
    workspace.updateConfig((c) => { c.current_agent = undefined as unknown as string; });
    delete process.env.USER;
    delete process.env.USERNAME;
    const name = resolveCurrentAgentName(workspace.dir);
    assert.equal(name, 'unknown');
  });

  it('ignores whitespace-only current_agent and falls back to env', () => {
    workspace.updateConfig((c) => { c.current_agent = '   '; });
    process.env.USER = 'env-user';
    const name = resolveCurrentAgentName(workspace.dir);
    assert.equal(name, 'env-user');
  });
});
