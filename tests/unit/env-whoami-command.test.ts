import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runEnv } from '../../src/commands/env.js';
import { runWhoami } from '../../src/commands/whoami.js';
import { upsertAgentIntegrationDeclaration } from '../../src/core/agent-integrations.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function captureConsole(fn: () => void): { logs: string[]; errors: string[] } {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  try {
    fn();
    return { logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('commands/env + whoami', () => {
  let workspace: TestWorkspace;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-env-whoami-',
      projectId: 'prj_env_whoami',
      currentAgent: 'copilot',
    });
    fs.writeFileSync(path.join(workspace.dir, 'AGENTS.md'), '# Agent Guide\n\n- Read memory first\n', 'utf-8');
    const codexHome = path.join(workspace.dir, '.codex-home');
    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'openai-docs'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'skills', '.system', 'openai-docs', 'SKILL.md'),
      '# OpenAI Docs\n\nUse when official OpenAI docs are needed.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.atlassian]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]\n',
      'utf-8',
    );
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    workspace.updateConfig((config) => {
      upsertAgentIntegrationDeclaration(config, 'github-copilot', 'manual');
      config.recommended_brainclaw_version = '99.0.0';
      config.brainclaw_upgrade_message = 'Includes improved doctor/env/whoami upgrade guidance.';
      config.brainclaw_update_source = {
        type: 'local-pack',
        manifest_path: '.releases/brainclaw-local.json',
      };
    });
    fs.mkdirSync(path.join(workspace.dir, '.releases'), { recursive: true });
    fs.writeFileSync(path.join(workspace.dir, '.releases', 'brainclaw-local.json'), JSON.stringify({
      version: 1,
      channel: 'local-pack',
      package_name: 'brainclaw',
      latest_installable_version: '99.0.0',
      artifact_path: './brainclaw-99.0.0.tgz',
      install_command: 'npm install -g "./.releases/brainclaw-99.0.0.tgz"',
      release_notes: 'Local release ready for upgrade.',
    }, null, 2), 'utf-8');
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    workspace.cleanup();
  });

  it('emits the execution context and agent tooling as JSON', () => {
    const output = captureConsole(() => {
      runEnv({ json: true, agentTooling: true, cwd: workspace.dir });
    });

    assert.equal(output.errors.length, 0);
    const parsed = JSON.parse(output.logs.at(-1) as string);
    assert.equal(parsed.agent_tooling.agents_md_present, true);
    assert.deepEqual(parsed.agent_tooling.agents_rules, ['Read memory first']);
    assert.equal(parsed.brainclaw_version.status, 'update_available');
    assert.equal(parsed.brainclaw_version.recommended_brainclaw_version, '99.0.0');
    assert.equal(parsed.installable_update.status, 'update_available');
    assert.equal(parsed.installable_update.latest_installable_version, '99.0.0');
    assert.equal(parsed.declared_agent_integrations.declarations[0].agent_name, 'github-copilot');
    assert.equal(parsed.integration_readiness[0].ready, false);
    assert.ok(Array.isArray(parsed.execution_context.toolchains));
    assert.equal(parsed.agent_tooling.skills[0].name, 'openai-docs');
    assert.equal(parsed.agent_tooling.skills[0].references_present, false);
    assert.equal(parsed.agent_tooling.mcp_servers[0].name, 'atlassian');
    assert.equal(parsed.agent_tooling.mcp_servers[0].availability, 'remote');
  });

  it('enriches whoami json with execution context and agent tooling', () => {
    const output = captureConsole(() => {
      runWhoami({ json: true, cwd: workspace.dir });
    });

    assert.equal(output.errors.length, 0);
    const parsed = JSON.parse(output.logs.at(-1) as string);
    // pln#562 step 2 — registry-level alias merge: 'copilot' IS 'github-copilot'.
    assert.equal(parsed.resolved_agent, 'github-copilot');
    assert.ok(parsed.execution_context);
    assert.equal(parsed.brainclaw_version.status, 'update_available');
    assert.equal(parsed.brainclaw_version.upgrade_message, 'Includes improved doctor/env/whoami upgrade guidance.');
    assert.equal(parsed.installable_update.status, 'update_available');
    assert.equal(parsed.installable_update.install_command, 'npm install -g "./.releases/brainclaw-99.0.0.tgz"');
    assert.equal(parsed.declared_agent_integrations.declarations[0].agent_name, 'github-copilot');
    assert.equal(parsed.integration_readiness[0].ready, false);
    assert.equal(parsed.agent_tooling.agents_md_present, true);
    assert.deepEqual(parsed.agent_tooling.agents_rules, ['Read memory first']);
    assert.equal(parsed.agent_tooling.skills[0].name, 'openai-docs');
    assert.equal(parsed.agent_tooling.mcp_servers[0].name, 'atlassian');
    assert.equal(parsed.agent_tooling.mcp_servers[0].availability, 'remote');
  });
});
