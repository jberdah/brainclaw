/**
 * Hermes Agent integration tests.
 *
 * Covers:
 *   - Capability profile lookup and alias
 *   - Export and integration registries
 *   - Machine-level MCP config writer
 *   - Auto-detection via Hermes env/config
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import {
  AGENT_EXPORT_REGISTRY,
  ensureHermesMcpConfig,
  resolveExportTarget,
} from '../../src/core/agent-files.js';
import {
  getAgentCapabilityProfile,
  resolveAgentAlias,
} from '../../src/core/agent-capability.js';
import { detectAiAgent } from '../../src/core/ai-agent-detection.js';
import { buildAgentIntegrationDeclaration } from '../../src/core/agent-integrations.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Hermes — capability profile', () => {
  it('resolves aliases to hermes', () => {
    assert.equal(resolveAgentAlias('hermes-agent'), 'hermes');
    assert.equal(resolveAgentAlias('hermes'), 'hermes');
  });

  it('returns a Tier B autonomous profile with MCP and skills', () => {
    const profile = getAgentCapabilityProfile('hermes');
    assert.ok(profile, 'profile exists');
    assert.equal(profile!.name, 'hermes');
    assert.equal(profile!.category, 'autonomous-agent');
    assert.equal(profile!.templateTier, 'B');
    assert.equal(profile!.hasMcp, true);
    assert.equal(profile!.hasHooks, false);
    assert.equal(profile!.hasSkills, true);
    assert.equal(profile!.hasRules, false);
    assert.equal(profile!.mcpConfigScope, 'machine');
    assert.equal(profile!.runtime.canBeSpawnedCli, true);
    assert.equal(profile!.invoke_binary, 'hermes');
    assert.equal(profile!.invoke_template, 'hermes chat -q "{prompt}"');
    assert.equal(profile!.invoke_review_template, 'hermes chat -q "{prompt}"');
    assert.equal(profile!.invoke_consult_template, 'hermes chat -q "{prompt}"');
  });
});

describe('Hermes — registries', () => {
  it('AGENT_EXPORT_REGISTRY targets AGENTS.md', () => {
    const target = AGENT_EXPORT_REGISTRY.find((t) => t.agentName === 'hermes');
    assert.ok(target);
    assert.equal(target!.format, 'agents-md');
    assert.equal(target!.relativePath, 'AGENTS.md');
  });

  it('resolveExportTarget("hermes") matches the registry entry', () => {
    const target = resolveExportTarget('hermes');
    assert.equal(target.agentName, 'hermes');
    assert.equal(target.relativePath, 'AGENTS.md');
  });

  it('declares Hermes MCP and universal skill surfaces', () => {
    const declaration = buildAgentIntegrationDeclaration('hermes');
    assert.ok(declaration.surfaces.some((s) => s.kind === 'mcp' && s.location === 'machine' && s.path === '.hermes/config.yaml'));
    assert.ok(declaration.surfaces.some((s) => s.kind === 'skill' && s.path === '.agents/skills/brainclaw/SKILL.md'));
  });
});

describe('Hermes — MCP config writer', () => {
  it('creates ~/.hermes/config.yaml with a filtered brainclaw server', () => {
    const home = tempDir('bclaw-hermes-home-');
    try {
      const workspace = tempDir('bclaw-hermes-workspace-');
      const result = ensureHermesMcpConfig(home, workspace);
      assert.ok(result);
      assert.equal(result!.created, true);
      assert.equal(result!.updated, false);
      assert.equal(result!.relativePath, '.hermes/config.yaml');

      const written = fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf-8');
      const parsed = yaml.parse(written);
      assert.deepEqual(parsed.skills.external_dirs, [path.join(workspace, '.agents', 'skills')]);
      assert.equal(parsed.mcp_servers.brainclaw.env.BRAINCLAW_AGENT, 'hermes');
      assert.ok(parsed.mcp_servers.brainclaw.tools.include.includes('bclaw_work'));
      assert.equal(parsed.mcp_servers.brainclaw.tools.prompts, false);
      assert.equal(parsed.mcp_servers.brainclaw.tools.resources, false);
      fs.rmSync(workspace, { recursive: true, force: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves existing Hermes settings and custom brainclaw command', () => {
    const home = tempDir('bclaw-hermes-preserve-');
    try {
      const filePath = path.join(home, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, yaml.stringify({
        default_model: 'openrouter/auto',
        skills: {
          external_dirs: ['C:/existing/skills'],
          auto_update: false,
        },
        mcp_servers: {
          brainclaw: {
            command: '/custom/brainclaw',
            args: ['mcp', '--debug'],
            tools: { include: ['bclaw_work'] },
          },
        },
      }), 'utf-8');

      const workspace = tempDir('bclaw-hermes-preserve-workspace-');
      const result = ensureHermesMcpConfig(home, workspace);
      assert.ok(result);
      assert.equal(result!.created, false);
      assert.equal(result!.updated, true);

      const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.equal(parsed.default_model, 'openrouter/auto');
      assert.equal(parsed.skills.auto_update, false);
      assert.deepEqual(parsed.skills.external_dirs, ['C:/existing/skills', path.join(workspace, '.agents', 'skills')]);
      assert.equal(parsed.mcp_servers.brainclaw.command, '/custom/brainclaw');
      assert.deepEqual(parsed.mcp_servers.brainclaw.args, ['mcp', '--debug']);
      assert.deepEqual(parsed.mcp_servers.brainclaw.tools.include, ['bclaw_work']);
      assert.equal(parsed.mcp_servers.brainclaw.env.BRAINCLAW_AGENT, 'hermes');
      fs.rmSync(workspace, { recursive: true, force: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Hermes — auto-detection', () => {
  it('detects via HERMES_HOME env var', () => {
    const home = tempDir('bclaw-hermes-detect-env-');
    try {
      const detected = detectAiAgent({ HERMES_HOME: '/custom/hermes' }, home);
      assert.ok(detected);
      assert.equal(detected!.name, 'hermes');
      assert.equal(detected!.kind, 'autonomous');
      assert.match(detected!.detection_source, /HERMES_HOME/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('detects via ~/.hermes directory presence', () => {
    const home = tempDir('bclaw-hermes-detect-dir-');
    try {
      fs.mkdirSync(path.join(home, '.hermes'));
      const detected = detectAiAgent({}, home);
      assert.ok(detected);
      assert.equal(detected!.name, 'hermes');
      assert.match(detected!.detection_source, /~\/\.hermes directory/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
