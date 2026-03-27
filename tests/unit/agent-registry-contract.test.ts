import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import {
  AgentIdentityResolutionError,
  registerAgentIdentity,
  requireRegisteredAgentIdentity,
  resolveCurrentAgentIdentity,
} from '../../src/core/agent-registry.js';
import { createTestWorkspace, isolateAgentEnv, type TestWorkspace } from '../helpers/workspace.js';

describe('core/agent-registry identity contract', () => {
  let workspace: TestWorkspace;
  let envIsolation: ReturnType<typeof isolateAgentEnv>;

  beforeEach(() => {
    envIsolation = isolateAgentEnv();
    workspace = createTestWorkspace({
      prefix: 'bclaw-agent-registry-',
      projectId: 'prj_agent_registry',
      currentAgent: 'copilot',
    });
    // Set CODEX_HOME to an isolated path inside the workspace
    process.env.CODEX_HOME = path.join(workspace.dir, '.codex-home');
  });

  afterEach(() => {
    workspace.cleanup();
    envIsolation.restore();
  });

  it('resolves registered identities by coherent id/name and rejects mismatches', () => {
    const claude = workspace.registerAgent('claude');

    const resolved = requireRegisteredAgentIdentity({
      agentName: 'claude',
      agentId: claude.agent_id,
      cwd: workspace.dir,
    });
    assert.equal(resolved.agent_id, claude.agent_id);

    assert.throws(() => requireRegisteredAgentIdentity({
      agentName: 'wrong-name',
      agentId: claude.agent_id,
      cwd: workspace.dir,
    }), AgentIdentityResolutionError);
  });

  it('requires environment agents to be registered when no current agent is configured', () => {
    const config = loadConfig(workspace.dir);
    delete config.current_agent;
    delete config.current_agent_id;
    saveConfig(config, workspace.dir);

    // Neutralize the workspace defaults so BRAINCLAW_AGENT is the only signal.
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    process.env.BRAINCLAW_AGENT = 'ghost';
    assert.throws(() => requireRegisteredAgentIdentity({
      cwd: workspace.dir,
      homeDir: envIsolation.fakeHome,
      allowCurrent: true,
      allowEnv: true,
    }), /not registered/i);

    // When BRAINCLAW_AGENT matches a registered agent, it should resolve.
    process.env.BRAINCLAW_AGENT = workspace.currentAgent.agent_name;
    const resolved = requireRegisteredAgentIdentity({
      cwd: workspace.dir,
      homeDir: envIsolation.fakeHome,
      allowCurrent: true,
      allowEnv: true,
    });
    assert.equal(resolved.agent_name, workspace.currentAgent.agent_name);
  });

  it('upserts capabilities and manages identity fingerprints explicitly', () => {
    const created = registerAgentIdentity({
      agentName: 'builder',
      kind: 'agent',
      capabilities: ['Code-Generation', 'review'],
      generateFingerprint: true,
      cwd: workspace.dir,
      env: process.env,
    });

    assert.deepEqual(created.capabilities, ['code-generation', 'review']);
    assert.ok(created.identity_key?.fingerprint);
    const firstFingerprint = created.identity_key?.fingerprint;
    const keyPath = path.join(process.env.CODEX_HOME as string, 'brainclaw', 'keys', `${created.agent_id}.ed25519.pem`);
    assert.equal(fs.existsSync(keyPath), true);

    const merged = registerAgentIdentity({
      agentName: 'builder',
      capabilities: ['planning', 'review'],
      cwd: workspace.dir,
    });
    assert.deepEqual(merged.capabilities, ['code-generation', 'review', 'planning']);

    const replaced = registerAgentIdentity({
      agentName: 'builder',
      capabilities: ['test-writing'],
      replaceCapabilities: true,
      cwd: workspace.dir,
    });
    assert.deepEqual(replaced.capabilities, ['test-writing']);

    const regenerated = registerAgentIdentity({
      agentName: 'builder',
      generateFingerprint: true,
      cwd: workspace.dir,
      env: process.env,
    });
    assert.ok(regenerated.identity_key?.fingerprint);
    assert.notEqual(regenerated.identity_key?.fingerprint, firstFingerprint);
  });

  it('resolveCurrentAgentIdentity auto-detects via CLAUDECODE when no explicit env override', () => {
    registerAgentIdentity({ agentName: 'claude-code', kind: 'agent', cwd: workspace.dir });

    const config = loadConfig(workspace.dir);
    delete config.current_agent;
    delete config.current_agent_id;
    saveConfig(config, workspace.dir);

    // Remove the workspace's explicit identity so only CLAUDECODE is left.
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT;
    delete process.env.BRAINCLAW_AGENT_ID;

    // Simulate VS Code extension env — only CLAUDECODE is set.
    process.env.CLAUDECODE = '1';

    const resolved = resolveCurrentAgentIdentity(workspace.dir);
    assert.ok(resolved, 'should resolve via auto-detection');
    assert.equal(resolved.agent_name, 'claude-code');
  });
});
