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
  resolveOrAutoRegisterAgentIdentity,
  listAgentIdentities,
  removeAgentIdentity,
} from '../../src/core/agent-registry.js';
import { upsertAgentIntegrationDeclaration } from '../../src/core/agent-integrations.js';
import { startSession } from '../../src/commands/session-start.js';
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

  it('falls back to the sole registered agent when there is no identity signal (pln#596)', () => {
    // Use an agent name detectAiAgent never returns ('solo-tester'), so even if
    // the host env makes detection fire, the detected name is unregistered and
    // resolution reaches the single-registered-agent fallback — the thing tested.
    const solo = createTestWorkspace({ prefix: 'bclaw-fallback-solo-', currentAgent: 'solo-tester', isolateEnv: false });
    // createTestWorkspace sets BRAINCLAW_AGENT_NAME/_ID — clear them so there is
    // genuinely no identity signal (a real hook has no such env), reaching the fallback.
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    delete process.env.BRAINCLAW_AGENT;
    try {
      const resolved = resolveCurrentAgentIdentity(solo.dir);
      assert.ok(resolved, 'expected the sole registered agent to resolve');
      assert.equal(resolved?.agent_id, solo.currentAgent.agent_id);
    } finally {
      solo.cleanup();
    }
  });

  it('does NOT fall back when two agents are registered (pln#562 multi-agent guard intact)', () => {
    const multi = createTestWorkspace({ prefix: 'bclaw-fallback-multi-', currentAgent: 'solo-tester', isolateEnv: false });
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    delete process.env.BRAINCLAW_AGENT;
    try {
      multi.registerAgent('second-tester');
      const resolved = resolveCurrentAgentIdentity(multi.dir);
      assert.equal(resolved, undefined, 'with >=2 agents and no signal, resolution must stay ambiguous');
    } finally {
      multi.cleanup();
    }
  });

  it('terminal error hint recommends env/--agent, not the no-op --set-current (pln#596)', () => {
    // Empty the registry so resolution reaches the terminal "no identity" throw.
    for (const agent of listAgentIdentities(workspace.dir)) {
      removeAgentIdentity(agent.agent_id, { cwd: workspace.dir, force: true });
    }
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    delete process.env.BRAINCLAW_AGENT;
    try {
      requireRegisteredAgentIdentity({ cwd: workspace.dir, allowCurrent: true, allowEnv: true });
      assert.fail('expected AgentIdentityResolutionError');
    } catch (err) {
      assert.ok(err instanceof AgentIdentityResolutionError);
      assert.match(err.message, /BRAINCLAW_AGENT_NAME/);
      assert.match(err.message, /--agent/);
      assert.match(err.message, /register-agent/);
    }
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
    // pln#562 step 5 — keys live under the neutral ~/.brainclaw/keys, no
    // longer inside CODEX_HOME.
    const keyPath = path.join(workspace.fakeHome, '.brainclaw', 'keys', `${created.agent_id}.ed25519.pem`);
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

  it('requireRegisteredAgentIdentity resolves case-insensitively (Codex → codex)', () => {
    registerAgentIdentity({ agentName: 'codex', kind: 'agent', cwd: workspace.dir });

    const resolved = requireRegisteredAgentIdentity({
      agentName: 'Codex',  // capital C
      cwd: workspace.dir,
    });
    assert.equal(resolved.agent_name, 'codex');
  });

  it('resolveCurrentAgentIdentity guard is case-insensitive (BRAINCLAW_AGENT=Codex, detected=codex)', () => {
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    // Set with capital C — should still match detected "codex"
    process.env.BRAINCLAW_AGENT = 'Codex';
    process.env.CODEX_THREAD_ID = 'test-thread-id';

    // When codex IS registered, it should be found even with mismatched case in env
    registerAgentIdentity({ agentName: 'codex', kind: 'agent', cwd: workspace.dir });
    const resolved = resolveCurrentAgentIdentity(workspace.dir, undefined, envIsolation.fakeHome);
    assert.ok(resolved, 'should resolve codex despite case mismatch');
    assert.equal(resolved.agent_name, 'codex');
  });

  it('requireRegisteredAgentIdentity auto-registers agents declared in agent_integrations', () => {
    // Add codex to agent_integrations without pre-registering it as an agent
    const config = loadConfig(workspace.dir);
    upsertAgentIntegrationDeclaration(config, 'codex', 'detected');
    saveConfig(config, workspace.dir);

    // Should auto-register because codex is in agent_integrations
    const resolved = requireRegisteredAgentIdentity({
      agentName: 'codex',
      cwd: workspace.dir,
    });
    assert.equal(resolved.agent_name, 'codex');
    assert.equal(resolved.kind, 'agent');
  });

  it('resolveOrAutoRegisterAgentIdentity auto-registers and returns auto_registered=true for unknown agents', () => {
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    process.env.BRAINCLAW_AGENT = 'new-custom-agent';

    const { identity, auto_registered } = resolveOrAutoRegisterAgentIdentity({
      agentName: 'new-custom-agent',
      cwd: workspace.dir,
      allowCurrent: true,
      allowEnv: true,
    });

    assert.equal(auto_registered, true);
    assert.equal(identity.agent_name, 'new-custom-agent');
    assert.equal(identity.trust_level, 'contributor');
  });

  it('resolveOrAutoRegisterAgentIdentity returns auto_registered=false for pre-existing agents', () => {
    registerAgentIdentity({ agentName: 'preexisting', kind: 'agent', cwd: workspace.dir });

    const { identity, auto_registered } = resolveOrAutoRegisterAgentIdentity({
      agentName: 'preexisting',
      cwd: workspace.dir,
    });

    assert.equal(auto_registered, false);
    assert.equal(identity.agent_name, 'preexisting');
  });

  it('startSession auto-registers unknown agent and returns auto_registered=true', async () => {
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    process.env.BRAINCLAW_AGENT = 'fresh-codex-agent';

    const result = await startSession({
      agent: 'fresh-codex-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.auto_registered, true);
    assert.equal(result.agent, 'fresh-codex-agent');
  });
});
