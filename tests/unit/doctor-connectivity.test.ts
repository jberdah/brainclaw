import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessAgentIntegrationReadiness,
  buildAgentIntegrationDeclaration,
  extractMcpCommandVal,
  setCommandVersionProbeForTests,
} from '../../src/core/agent-integrations.js';
import { getInstalledBrainclawVersion } from '../../src/core/brainclaw-version.js';
import { defaultConfig } from '../../src/core/config.js';

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\');
}

function writeCodexToml(homeDir: string, command: string, args: string[]): string {
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const renderedArgs = args.map((arg) => `"${escapeTomlString(arg)}"`).join(', ');
  fs.writeFileSync(
    configPath,
    [
      '[mcp_servers.brainclaw]',
      `command = "${escapeTomlString(command)}"`,
      `args = [${renderedArgs}]`,
      '',
    ].join('\n'),
    'utf-8',
  );
  return configPath;
}

function writeJson(filepath: string, value: unknown): string {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(value, null, 2), 'utf-8');
  return filepath;
}

describe('doctor connectivity', () => {
  let workspaceDir: string;
  let homeDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-doctor-workspace-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-doctor-home-'));
    env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  });

  afterEach(() => {
    setCommandVersionProbeForTests(undefined);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('extracts the brainclaw command from a GitHub Copilot JSON MCP config', () => {
    const fixturePath = writeJson(path.join(workspaceDir, 'copilot-mcp.json'), {
      'github.copilot.chat.mcpServers': {
        brainclaw: {
          command: 'npx',
          args: ['brainclaw', 'mcp'],
        },
      },
    });

    const parsed = extractMcpCommandVal('github-copilot', fixturePath);

    assert.equal(parsed.is_valid, true);
    assert.equal(parsed.command, 'npx');
    assert.deepEqual(parsed.args, ['brainclaw', 'mcp']);
  });

  it('extracts the brainclaw command from a Codex TOML MCP config', () => {
    const fixturePath = writeCodexToml(
      homeDir,
      'C:\\Program Files\\nodejs\\node.exe',
      ['C:\\brainclaw\\dist\\cli.js', 'mcp'],
    );

    const parsed = extractMcpCommandVal('codex', fixturePath);

    assert.equal(parsed.is_valid, true);
    assert.equal(parsed.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(parsed.args, ['C:\\brainclaw\\dist\\cli.js', 'mcp']);
  });

  it('reports tier-a for codex when AGENTS.md and a valid MCP config are present', () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# test\n', 'utf-8');
    writeCodexToml(homeDir, 'npx', ['brainclaw', 'mcp']);

    const config = defaultConfig('brainclaw-tests');
    config.agent_integrations.declarations.push(buildAgentIntegrationDeclaration('codex', 'manual'));

    const readiness = assessAgentIntegrationReadiness(config, workspaceDir, env);

    assert.equal(readiness[0]!.effective_tier, 'tier-a');
    assert.equal(readiness[0]!.ready, true);
    assert.equal(readiness[0]!.drifting_surfaces.length, 0);
  });

  it('degrades codex to tier-b when the MCP command points to a missing binary', () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# test\n', 'utf-8');
    const missingWrapper = path.join(homeDir, 'missing', 'brainclaw-wrapper.exe');
    writeCodexToml(homeDir, missingWrapper, ['mcp']);

    const config = defaultConfig('brainclaw-tests');
    config.agent_integrations.declarations.push(buildAgentIntegrationDeclaration('codex', 'manual'));

    const readiness = assessAgentIntegrationReadiness(config, workspaceDir, env);

    assert.equal(readiness[0]!.effective_tier, 'tier-b');
    assert.equal(readiness[0]!.ready, false);
    assert.match(readiness[0]!.drifting_surfaces[0]!.drift_message ?? '', /non-existent file/);
  });

  it('degrades codex to tier-b when the MCP command version drifts from the installed CLI', () => {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# test\n', 'utf-8');
    const versionScript = path.join(homeDir, 'brainclaw-version-probe.js');
    writeCodexToml(homeDir, process.execPath, [versionScript]);
    setCommandVersionProbeForTests((cmdPath, args) => {
      if (cmdPath === process.execPath && args?.[0] === versionScript) {
        return '0.0.1';
      }
      return null;
    });

    const config = defaultConfig('brainclaw-tests');
    config.agent_integrations.declarations.push(buildAgentIntegrationDeclaration('codex', 'manual'));

    const readiness = assessAgentIntegrationReadiness(config, workspaceDir, env);

    assert.equal(readiness[0]!.effective_tier, 'tier-b');
    assert.equal(readiness[0]!.ready, false);
    assert.match(readiness[0]!.drifting_surfaces[0]!.drift_message ?? '', /version drift/);
    assert.match(
      readiness[0]!.drifting_surfaces[0]!.drift_message ?? '',
      new RegExp(getInstalledBrainclawVersion().replace(/\./g, '\\.')),
    );
  });

  it('falls back to tier-c when every declared surface is missing', () => {
    const config = defaultConfig('brainclaw-tests');
    config.agent_integrations.declarations.push(buildAgentIntegrationDeclaration('roo', 'manual'));

    const readiness = assessAgentIntegrationReadiness(config, workspaceDir, env);

    assert.equal(readiness[0]!.effective_tier, 'tier-c');
    assert.equal(readiness[0]!.ready, false);
    assert.equal(readiness[0]!.missing_surfaces.length, readiness[0]!.surfaces.length);
  });
});
