import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { registerAgentIdentity, listAgentIdentities } from '../../src/core/agent-registry.js';
import { runInit } from '../../src/commands/init.js';

describe('init first-agent curator', () => {
  describe('registerAgentIdentity — no trust downgrade', () => {
    let workspace: TestWorkspace;

    before(() => {
      workspace = createTestWorkspace({ prefix: 'bclaw-curator-' });
    });
    after(() => workspace.cleanup());

    it('does not downgrade curator to trusted', () => {
      const agent = registerAgentIdentity({ agentName: 'owner', kind: 'human', trustLevel: 'curator', cwd: workspace.dir });
      assert.equal(agent.trust_level, 'curator');

      const reregistered = registerAgentIdentity({ agentName: 'owner', kind: 'human', trustLevel: 'trusted', cwd: workspace.dir });
      assert.equal(reregistered.trust_level, 'curator', 'trust should not be downgraded');
    });

    it('does not downgrade trusted to contributor', () => {
      registerAgentIdentity({ agentName: 'dev', kind: 'agent', trustLevel: 'trusted', cwd: workspace.dir });
      const reregistered = registerAgentIdentity({ agentName: 'dev', kind: 'agent', trustLevel: 'contributor', cwd: workspace.dir });
      assert.equal(reregistered.trust_level, 'trusted', 'trust should not be downgraded');
    });

    it('allows upgrading contributor to curator', () => {
      registerAgentIdentity({ agentName: 'newbie', kind: 'agent', trustLevel: 'contributor', cwd: workspace.dir });
      const promoted = registerAgentIdentity({ agentName: 'newbie', kind: 'agent', trustLevel: 'curator', cwd: workspace.dir });
      assert.equal(promoted.trust_level, 'curator');
    });
  });

  describe('init creates curator', () => {
    it('the agent running init gets curator trust level', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-fresh-'));
      const prev = process.cwd();
      try {
        process.chdir(tmpDir);
        await runInit({ yes: true });
        const agents = listAgentIdentities(tmpDir);
        const curator = agents.find((a) => a.trust_level === 'curator');
        assert.ok(curator, 'at least one agent should be curator after init');
      } finally {
        process.chdir(prev);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
