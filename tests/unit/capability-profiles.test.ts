import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCapabilityProfile,
  getDefaultInvokeTemplate,
  getSpawnableAgents,
  resolveAgentAlias,
  isKnownAgent,
} from '../../src/core/agent-capability.js';

describe('getCapabilityProfile', () => {
  it('claude-code has mcp_direct=true and hooks=true', () => {
    const profile = getCapabilityProfile('claude-code');
    assert.ok(profile, 'claude-code profile must exist');
    assert.equal(profile.runtime.mcp_direct, true);
    assert.equal(profile.runtime.hooks, true);
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.runtime.canSpawnOtherCli, true);
    assert.equal(profile.runtime.inbox, true);
  });

  it('codex has canBeSpawnedCli=true and task-based workflow', () => {
    const profile = getCapabilityProfile('codex');
    assert.ok(profile, 'codex profile must exist');
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.runtime.canSpawnOtherCli, false);
    assert.equal(profile.workflowModel, 'task-based');
  });

  it('cursor has mcp_direct=true but canBeSpawnedCli=false (IDE-only)', () => {
    const profile = getCapabilityProfile('cursor');
    assert.ok(profile, 'cursor profile must exist');
    assert.equal(profile.runtime.mcp_direct, true);
    assert.equal(profile.runtime.canBeSpawnedCli, false);
  });

  it('nanoclaw has mcp_direct=false and canBeSpawnedCli=true (CLI-only)', () => {
    const profile = getCapabilityProfile('nanoclaw');
    assert.ok(profile, 'nanoclaw profile must exist');
    assert.equal(profile.runtime.mcp_direct, false);
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.runtime.canSpawnOtherCli, false);

  });

  it('openclaw is a Tier B spawner with canSpawnOtherCli=true and invoke_template', () => {
    const profile = getCapabilityProfile('openclaw');
    assert.ok(profile, 'openclaw profile must exist');
    assert.equal(profile.runtime.canBeSpawnedCli, true);
    assert.equal(profile.runtime.canSpawnOtherCli, true);
    assert.ok(profile.invoke_template, 'openclaw must have an invoke_template');
    assert.ok(profile.invoke_binary, 'openclaw must have an invoke_binary');
    assert.equal(profile.templateTier, 'B');
  });

  it('returns undefined for unknown agent', () => {
    assert.equal(getCapabilityProfile('unknown-agent'), undefined);
    assert.equal(getCapabilityProfile(''), undefined);
  });

  it('profile name matches the requested key', () => {
    for (const name of ['claude-code', 'codex', 'roo', 'opencode', 'windsurf']) {
      const profile = getCapabilityProfile(name);
      assert.ok(profile, `profile missing for ${name}`);
      assert.equal(profile.name, name);
    }
  });

  it('resolves canonical names case-insensitively (regression: targetAgents=["Codex"] dropped)', () => {
    for (const name of ['Codex', 'CODEX', ' codex ', 'CoDeX']) {
      const profile = getCapabilityProfile(name);
      assert.ok(profile, `expected a profile for ${JSON.stringify(name)}`);
      assert.equal(profile.name, 'codex');
      assert.equal(profile.runtime.canBeSpawnedCli, true);
    }
  });

  it('resolves aliases case-insensitively', () => {
    assert.equal(getCapabilityProfile('Gemini')?.name, 'antigravity');
    assert.equal(getCapabilityProfile('Copilot')?.name, 'github-copilot');
    assert.equal(getCapabilityProfile('GH-Copilot')?.name, 'github-copilot');
  });
});

describe('resolveAgentAlias / isKnownAgent — case-insensitive', () => {
  it('normalizes case + whitespace and applies aliases', () => {
    assert.equal(resolveAgentAlias('Codex'), 'codex');
    assert.equal(resolveAgentAlias('  CLAUDE-CODE '), 'claude-code');
    assert.equal(resolveAgentAlias('Gemini'), 'antigravity');
  });

  it('recognizes known agents regardless of case', () => {
    assert.equal(isKnownAgent('Codex'), true);
    assert.equal(isKnownAgent('GITHUB-COPILOT'), true);
    assert.equal(isKnownAgent('definitely-not-an-agent'), false);
  });
});

describe('getDefaultInvokeTemplate (backward compat)', () => {
  it('claude-code returns a valid invoke template', () => {
    const template = getDefaultInvokeTemplate('claude-code');
    assert.ok(template, 'claude-code must have an invoke template');
    assert.ok(template.command.includes('{prompt}'), 'command must contain {prompt} placeholder');
    assert.equal(template.channel, 'spawn');
    assert.equal(typeof template.timeout, 'number');
    assert.ok(template.timeout > 0);
    assert.equal(template.binary, 'claude');
  });

  it('codex returns a valid invoke template', () => {
    const template = getDefaultInvokeTemplate('codex');
    assert.ok(template, 'codex must have an invoke template');
    assert.ok(template.command.includes('{prompt}'));
    assert.equal(template.binary, 'codex');
  });

  it('cursor (IDE-only) returns undefined', () => {
    const template = getDefaultInvokeTemplate('cursor');
    assert.equal(template, undefined);
  });

  it('unknown agent returns undefined', () => {
    assert.equal(getDefaultInvokeTemplate('not-an-agent'), undefined);
  });
});

describe('getSpawnableAgents', () => {
  it('returns a non-empty array', () => {
    const spawnable = getSpawnableAgents();
    assert.ok(Array.isArray(spawnable));
    assert.ok(spawnable.length > 0, 'at least one spawnable agent must exist');
  });

  it('includes claude-code and codex', () => {
    const spawnable = getSpawnableAgents();
    const names = spawnable.map((a) => a.name);
    assert.ok(names.includes('claude-code'), 'claude-code must be spawnable');
    assert.ok(names.includes('codex'), 'codex must be spawnable');
  });

  it('every entry has a valid template with {prompt} placeholder', () => {
    const spawnable = getSpawnableAgents();
    for (const entry of spawnable) {
      assert.ok(typeof entry.name === 'string', `${entry.name}: name must be string`);
      assert.ok(typeof entry.template.command === 'string', `${entry.name}: command must be string`);
      assert.ok(entry.template.command.includes('{prompt}'), `${entry.name}: command must contain {prompt}`);
      assert.ok(typeof entry.template.binary === 'string', `${entry.name}: binary must be string`);
      assert.equal(entry.template.channel, 'spawn');
    }
  });

  it('does not include IDE-only agents (cursor, windsurf)', () => {
    const spawnable = getSpawnableAgents();
    const names = spawnable.map((a) => a.name);
    assert.ok(!names.includes('cursor'), 'cursor is IDE-only and must not be spawnable');
    assert.ok(!names.includes('windsurf'), 'windsurf is IDE-only and must not be spawnable');
  });
});
