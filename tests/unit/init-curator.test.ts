import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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

    it('fresh init succeeds when detected agent export needs config state', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-gemini-'));
      const initModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'src', 'commands', 'init.js')).href;
      try {
        const script = [
          `import { runInit } from ${JSON.stringify(initModuleUrl)};`,
          'await runInit({ yes: true, skipSetupRequirement: true });',
        ].join('\n');
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: tmpDir,
          encoding: 'utf-8',
          env: {
            ...process.env,
            BRAINCLAW_AGENT: 'antigravity',
            BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
          },
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.ok(fs.existsSync(path.join(tmpDir, '.brainclaw', 'config.yaml')));
        assert.ok(fs.existsSync(path.join(tmpDir, 'GEMINI.md')));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
