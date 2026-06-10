import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { buildGitAttributionEnv } from '../../src/core/execution-adapters.js';
import {
  generateClaimId,
  loadClaim,
  releaseClaim,
  releaseClaimWithCascade,
  saveClaim,
} from '../../src/core/claims.js';
import { registerAgentIdentity } from '../../src/core/agent-registry.js';

// pln#562 step 5 — truthful attribution.
describe('truthful attribution (pln#562 step 5)', () => {
  describe('buildGitAttributionEnv', () => {
    it('authors commits as the agent, via brainclaw', () => {
      const env = buildGitAttributionEnv('codex');
      assert.equal(env.GIT_AUTHOR_NAME, 'codex (via brainclaw)');
      assert.equal(env.GIT_AUTHOR_EMAIL, 'codex@agents.brainclaw.dev');
      assert.equal(env.GIT_COMMITTER_NAME, 'codex (via brainclaw)');
      assert.equal(env.GIT_COMMITTER_EMAIL, 'codex@agents.brainclaw.dev');
    });

    it('slugs odd characters into the email local part', () => {
      const env = buildGitAttributionEnv('GitHub Copilot!');
      assert.equal(env.GIT_AUTHOR_EMAIL, 'github-copilot-@agents.brainclaw.dev');
    });

    it('returns empty for missing agent', () => {
      assert.deepEqual(buildGitAttributionEnv(undefined), {});
      assert.deepEqual(buildGitAttributionEnv('  '), {});
    });
  });

  describe('claim release ownership', () => {
    let workspace: TestWorkspace;

    function makeClaim(agent: string, agentId?: string, sessionId?: string): string {
      const id = generateClaimId();
      saveClaim({
        id,
        agent,
        agent_id: agentId,
        session_id: sessionId,
        scope: `src/${id}`,
        description: 'release ownership test',
        created_at: new Date().toISOString(),
        status: 'active',
      }, workspace.dir);
      return id;
    }

    beforeEach(() => {
      workspace = createTestWorkspace({ prefix: 'bclaw-release-own-' });
    });

    afterEach(() => {
      workspace.cleanup();
    });

    it('refuses release from a non-owner without override', () => {
      const id = makeClaim('codex', 'agt_codex');
      assert.throws(
        () => releaseClaim(id, workspace.dir, { agent: 'claude-code', agent_id: 'agt_claude' }),
        /does not own it/,
      );
      assert.equal(loadClaim(id, workspace.dir).status, 'active', 'claim untouched');
    });

    it('owner releases by agent, agent_id, or session', () => {
      const byName = makeClaim('codex');
      assert.equal(releaseClaim(byName, workspace.dir, { agent: 'codex' }).status, 'released');

      const byId = makeClaim('codex', 'agt_codex');
      assert.equal(releaseClaim(byId, workspace.dir, { agent: 'other', agent_id: 'agt_codex' }).status, 'released');

      const bySession = makeClaim('codex', 'agt_codex', 'sess_owner');
      assert.equal(
        releaseClaim(bySession, workspace.dir, { agent: 'other', session_id: 'sess_owner' }).status,
        'released',
      );
    });

    it('coordinator override releases a foreign claim and leaves an audit trail', () => {
      const id = makeClaim('codex', 'agt_codex');
      const released = releaseClaim(id, workspace.dir, {
        agent: 'claude-code',
        agent_id: 'agt_claude',
        override: true,
      });
      assert.equal(released.status, 'released');
      const auditPath = path.join(workspace.dir, '.brainclaw', 'audit.log');
      assert.ok(fs.existsSync(auditPath), 'audit log written');
      const entries = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const override = entries.find((e) => e.after?.ownership_override === true && e.item_id === id);
      assert.ok(override, 'override audit entry recorded');
      assert.equal(override.actor, 'claude-code');
    });

    it('releaseClaimWithCascade applies the same ownership check', () => {
      const id = makeClaim('codex', 'agt_codex');
      assert.throws(
        () => releaseClaimWithCascade(id, { cwd: workspace.dir, auth: { agent: 'intruder' } }),
        /does not own it/,
      );
      const ok = releaseClaimWithCascade(id, { cwd: workspace.dir, auth: { agent: 'codex' } });
      assert.equal(ok.claim.status, 'released');
    });

    it('legacy callers without auth keep working (sweeps, reconciler)', () => {
      const id = makeClaim('codex');
      assert.equal(releaseClaim(id, workspace.dir).status, 'released');
    });
  });

  describe('ed25519 key location', () => {
    let workspace: TestWorkspace;

    beforeEach(() => {
      workspace = createTestWorkspace({ prefix: 'bclaw-keys-' });
      delete process.env.CODEX_HOME;
    });

    afterEach(() => {
      workspace.cleanup();
    });

    it('writes private keys under the neutral ~/.brainclaw/keys, not ~/.codex', () => {
      const agent = registerAgentIdentity({
        agentName: 'codex',
        kind: 'agent',
        generateFingerprint: true,
        cwd: workspace.dir,
      });
      const neutral = path.join(workspace.fakeHome, '.brainclaw', 'keys', `${agent.agent_id}.ed25519.pem`);
      assert.ok(fs.existsSync(neutral), 'key at neutral path');
      assert.ok(
        !fs.existsSync(path.join(workspace.fakeHome, '.codex', 'brainclaw', 'keys', `${agent.agent_id}.ed25519.pem`)),
        'no key under ~/.codex',
      );
      assert.ok(agent.identity_key?.fingerprint, 'fingerprint recorded');
    });

    it('migrates a legacy ~/.codex key file to the neutral path', () => {
      const agent = registerAgentIdentity({ agentName: 'cline', kind: 'agent', cwd: workspace.dir });
      const legacy = path.join(workspace.fakeHome, '.codex', 'brainclaw', 'keys', `${agent.agent_id}.ed25519.pem`);
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, 'legacy-key-material', 'utf-8');

      // Fingerprint generation triggers the one-time migration.
      registerAgentIdentity({ agentName: 'cline', kind: 'agent', generateFingerprint: true, cwd: workspace.dir });

      const neutral = path.join(workspace.fakeHome, '.brainclaw', 'keys', `${agent.agent_id}.ed25519.pem`);
      assert.ok(fs.existsSync(neutral), 'key exists at the neutral path');
      assert.ok(!fs.existsSync(legacy), 'legacy file moved out of ~/.codex');
    });
  });
});
