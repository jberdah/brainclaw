import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import {
  AgentIdentityResolutionError,
  registerAgentIdentity,
  requireRegisteredAgentIdentity,
} from '../../src/core/agent-registry.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/agent-registry identity contract', () => {
  let workspace: TestWorkspace;
  let previousCodexHome: string | undefined;
  let previousAgent: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-agent-registry-',
      projectId: 'prj_agent_registry',
      currentAgent: 'copilot',
    });
    previousCodexHome = process.env.CODEX_HOME;
    previousAgent = process.env.BRAINCLAW_AGENT;
    process.env.CODEX_HOME = path.join(workspace.dir, '.codex-home');
    delete process.env.BRAINCLAW_AGENT;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousAgent === undefined) {
      delete process.env.BRAINCLAW_AGENT;
    } else {
      process.env.BRAINCLAW_AGENT = previousAgent;
    }
    workspace.cleanup();
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

    process.env.BRAINCLAW_AGENT = 'ghost';
    assert.throws(() => requireRegisteredAgentIdentity({
      cwd: workspace.dir,
      allowCurrent: true,
      allowEnv: true,
    }), /not registered/i);

    process.env.BRAINCLAW_AGENT = workspace.currentAgent.agent_name;
    const resolved = requireRegisteredAgentIdentity({
      cwd: workspace.dir,
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
});
