import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import {
  findAgentIdentityByName,
  listAgentIdentities,
  listDebrisAgentIdentities,
  normalizeAgentName,
  registerAgentIdentity,
  removeAgentIdentity,
  requireRegisteredAgentIdentity,
  resolveOrAutoRegisterAgentIdentity,
} from '../../src/core/agent-registry.js';

// pln#562 step 2 — conservative identity acquisition:
// auto-registration caps at contributor, alias merge at the registry level,
// guarded debris cleanup.
describe('conservative identity acquisition (pln#562 step 2)', () => {
  let workspace: TestWorkspace;
  let restoreCwd: () => void;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-identity-acq-' });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd();
    workspace.cleanup();
  });

  describe('trust cap', () => {
    it('requireRegisteredAgentIdentity auto-registers known explicit names at contributor only', () => {
      const identity = requireRegisteredAgentIdentity({ agentName: 'codex', cwd: workspace.dir });
      assert.equal(identity.agent_name, 'codex');
      assert.equal(identity.trust_level, 'contributor');
    });

    it('resolveOrAutoRegisterAgentIdentity auto-registers at contributor only', () => {
      const { identity, auto_registered } = resolveOrAutoRegisterAgentIdentity({
        agentName: 'fresh-worker-agent',
        cwd: workspace.dir,
      });
      assert.equal(auto_registered, true);
      assert.equal(identity.trust_level, 'contributor');
    });

    it('explicit registration can still elevate (not an auto path)', () => {
      const identity = registerAgentIdentity({
        agentName: 'claude-code',
        kind: 'agent',
        trustLevel: 'trusted',
        cwd: workspace.dir,
      });
      assert.equal(identity.trust_level, 'trusted');
    });
  });

  describe('registry-level alias merge', () => {
    it('normalizeAgentName resolves copilot to github-copilot', () => {
      assert.equal(normalizeAgentName('copilot'), 'github-copilot');
      assert.equal(normalizeAgentName('  Copilot '), 'github-copilot');
      assert.equal(normalizeAgentName('gemini'), 'antigravity');
    });

    it('registering an alias creates/finds the canonical identity', () => {
      const viaAlias = registerAgentIdentity({ agentName: 'copilot', kind: 'agent', cwd: workspace.dir });
      assert.equal(viaAlias.agent_name, 'github-copilot');

      const canonical = findAgentIdentityByName('github-copilot', workspace.dir);
      const aliased = findAgentIdentityByName('copilot', workspace.dir);
      assert.ok(canonical);
      assert.equal(canonical.agent_id, viaAlias.agent_id);
      assert.equal(aliased?.agent_id, viaAlias.agent_id, 'alias lookup resolves to the same identity');

      const githubCopilots = listAgentIdentities(workspace.dir)
        .filter((a) => a.agent_name.includes('copilot'));
      assert.equal(githubCopilots.length, 1, 'one identity, not two');
    });
  });

  describe('guarded debris cleanup', () => {
    it('flags known debris names and removes them without force', () => {
      registerAgentIdentity({ agentName: 'testuser', kind: 'unknown', cwd: workspace.dir });
      registerAgentIdentity({ agentName: 'contributor-bot', kind: 'agent', cwd: workspace.dir });

      const debris = listDebrisAgentIdentities(workspace.dir);
      const names = debris.map((d) => d.identity.agent_name).sort();
      assert.deepEqual(names, ['contributor-bot', 'testuser']);

      const removed = removeAgentIdentity('testuser', { cwd: workspace.dir });
      assert.equal(removed.agent_name, 'testuser');
      assert.equal(findAgentIdentityByName('testuser', workspace.dir), undefined);
    });

    it('refuses to remove a non-debris identity without force', () => {
      registerAgentIdentity({ agentName: 'claude-code', kind: 'agent', cwd: workspace.dir });
      assert.throws(
        () => removeAgentIdentity('claude-code', { cwd: workspace.dir }),
        /not a known debris identity/,
      );
      assert.ok(findAgentIdentityByName('claude-code', workspace.dir), 'identity untouched');

      const removed = removeAgentIdentity('claude-code', { cwd: workspace.dir, force: true });
      assert.equal(removed.agent_name, 'claude-code');
    });

    it('never removes a curator without force', () => {
      registerAgentIdentity({
        agentName: 'claude-sonnet',
        kind: 'agent',
        trustLevel: 'curator',
        cwd: workspace.dir,
      });
      // claude-sonnet is on the debris list, but curator trust still guards it
      assert.throws(
        () => removeAgentIdentity('claude-sonnet', { cwd: workspace.dir }),
        /curator/,
      );
    });

    it('throws for unknown identities', () => {
      assert.throws(
        () => removeAgentIdentity('no-such-agent', { cwd: workspace.dir }),
        /not found/,
      );
    });
  });
});
