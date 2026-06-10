/**
 * Mistral Vibe integration tests (pln#489).
 *
 * Covers:
 *   - Capability profile lookup (canonical name + aliases)
 *   - Export registry entries
 *   - Live companion registry entry
 *   - MCP config writer: creation, idempotency, preserves other entries
 *   - Auto-detection (~/.vibe directory, VIBE_HOME env)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureMistralVibeMcpConfig,
  AGENT_EXPORT_REGISTRY,
  LIVE_COMPANION_EXPORT_REGISTRY,
  resolveExportTarget,
  resolveLiveCompanionPath,
} from '../../src/core/agent-files.js';
import {
  resolveAgentAlias,
  getAgentCapabilityProfile,
} from '../../src/core/agent-capability.js';
import { detectAiAgent } from '../../src/core/ai-agent-detection.js';
import { buildAgentInventory } from '../../src/core/agent-inventory.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Mistral Vibe — capability profile', () => {
  it('resolves aliases to mistral-vibe', () => {
    assert.equal(resolveAgentAlias('mistral'), 'mistral-vibe');
    assert.equal(resolveAgentAlias('vibe'), 'mistral-vibe');
    assert.equal(resolveAgentAlias('mistral-vibe'), 'mistral-vibe');
  });

  it('returns a Tier B profile with the expected capabilities', () => {
    const profile = getAgentCapabilityProfile('mistral-vibe');
    assert.ok(profile, 'profile exists');
    assert.equal(profile!.name, 'mistral-vibe');
    assert.equal(profile!.templateTier, 'B');
    assert.equal(profile!.hasMcp, true);
    assert.equal(profile!.hasHooks, false);
    assert.equal(profile!.hasSkills, true);
    assert.equal(profile!.hasRules, false, 'no native rules file');
    assert.equal(profile!.runtime.canBeSpawnedCli, true);
    assert.equal(profile!.invoke_binary, 'vibe');
    assert.match(profile!.invoke_template ?? '', /^vibe --prompt /);
    assert.match(profile!.invoke_template ?? '', /--auto-approve/);
    assert.match(profile!.invoke_template ?? '', /--max-turns/);
    assert.equal(profile!.mcpConfigScope, 'both');
  });
});

describe('Mistral Vibe — registries', () => {
  it('AGENT_EXPORT_REGISTRY targets AGENTS.md (shared with codex/opencode)', () => {
    const target = AGENT_EXPORT_REGISTRY.find((t) => t.agentName === 'mistral-vibe');
    assert.ok(target);
    assert.equal(target!.format, 'agents-md');
    assert.equal(target!.relativePath, 'AGENTS.md');
  });

  it('resolveExportTarget(\'mistral-vibe\') matches the registry entry', () => {
    const target = resolveExportTarget('mistral-vibe');
    assert.equal(target.agentName, 'mistral-vibe');
    assert.equal(target.relativePath, 'AGENTS.md');
  });

  it('LIVE_COMPANION_EXPORT_REGISTRY exposes .vibe/live.md', () => {
    const target = LIVE_COMPANION_EXPORT_REGISTRY.find((t) => t.agentName === 'mistral-vibe');
    assert.ok(target);
    assert.equal(target!.relativePath, '.vibe/live.md');
  });

  it('resolveLiveCompanionPath returns the registry path for mistral-vibe', () => {
    const p = resolveLiveCompanionPath('mistral-vibe', 'AGENTS.md');
    assert.equal(p, '.vibe/live.md');
  });
});

describe('Mistral Vibe — MCP config writer', () => {
  it('creates .vibe/config.toml with a [[mcp_servers]] brainclaw block when absent', () => {
    const cwd = tempDir('bclaw-vibe-create-');
    try {
      const result = ensureMistralVibeMcpConfig(cwd);
      assert.equal(result.created, true);
      assert.equal(result.updated, false);
      assert.equal(result.relativePath, '.vibe/config.toml');

      const written = fs.readFileSync(path.join(cwd, '.vibe', 'config.toml'), 'utf-8');
      assert.match(written, /\[\[mcp_servers\]\]/);
      assert.match(written, /name = "brainclaw"/);
      assert.match(written, /transport = "stdio"/);
      assert.match(written, /args = \[/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('is idempotent: a 2nd run does not duplicate the brainclaw entry', () => {
    const cwd = tempDir('bclaw-vibe-idemp-');
    try {
      ensureMistralVibeMcpConfig(cwd);
      const after1 = fs.readFileSync(path.join(cwd, '.vibe', 'config.toml'), 'utf-8');

      const result2 = ensureMistralVibeMcpConfig(cwd);
      const after2 = fs.readFileSync(path.join(cwd, '.vibe', 'config.toml'), 'utf-8');

      assert.equal(result2.created, false);
      assert.equal(result2.updated, false);
      assert.equal(after1, after2, 'file content unchanged on 2nd run');
      // Single brainclaw entry, not duplicated
      const matches = after2.match(/name = "brainclaw"/g) ?? [];
      assert.equal(matches.length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves existing mcp_servers entries when adding the brainclaw block', () => {
    const cwd = tempDir('bclaw-vibe-preserve-');
    try {
      const filePath = path.join(cwd, '.vibe', 'config.toml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        '[[mcp_servers]]',
        'name = "serena"',
        'transport = "http"',
        'command = "python"',
        'args = ["-m", "serena"]',
        '',
      ].join('\n'), 'utf-8');

      const result = ensureMistralVibeMcpConfig(cwd);
      assert.equal(result.created, false);
      assert.equal(result.updated, true);

      const written = fs.readFileSync(filePath, 'utf-8');
      assert.match(written, /name = "serena"/, 'serena entry preserved');
      assert.match(written, /name = "brainclaw"/, 'brainclaw entry appended');
      // Ordering: serena should appear before brainclaw (we appended)
      const serenaIdx = written.indexOf('name = "serena"');
      const brainclawIdx = written.indexOf('name = "brainclaw"');
      assert.ok(serenaIdx < brainclawIdx, 'serena comes before brainclaw');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not duplicate brainclaw when the existing file already contains it', () => {
    const cwd = tempDir('bclaw-vibe-existing-');
    try {
      const filePath = path.join(cwd, '.vibe', 'config.toml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existing = [
        '[[mcp_servers]]',
        'name = "brainclaw"',
        'transport = "stdio"',
        'command = "/custom/path/to/brainclaw"',
        'args = ["mcp", "--debug"]',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, existing, 'utf-8');

      const result = ensureMistralVibeMcpConfig(cwd);
      assert.equal(result.created, false);
      assert.equal(result.updated, false);

      const written = fs.readFileSync(filePath, 'utf-8');
      assert.equal(written, existing, 'user-customized entry preserved as-is');
      assert.match(written, /\/custom\/path\/to\/brainclaw/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('Mistral Vibe — auto-detection', () => {
  it('detects via VIBE_HOME env var', () => {
    const detected = detectAiAgent({ VIBE_HOME: '/custom/vibe' });
    assert.ok(detected);
    assert.equal(detected!.name, 'mistral-vibe');
    assert.match(detected!.detection_source, /VIBE_HOME/);
  });

  // pln#562 step 1 — directory presence proves installation (inventory),
  // never identity: detectAiAgent is env-only.
  it('~/.vibe directory presence marks mistral-vibe installed in the inventory, not detected', () => {
    const homeDir = tempDir('bclaw-vibe-dir-');
    try {
      fs.mkdirSync(path.join(homeDir, '.vibe'));
      assert.equal(detectAiAgent({}), undefined, 'no env markers → no detected identity');
      const inv = buildAgentInventory(homeDir, {}, { spawnableResolver: () => false });
      const vibe = inv.agents.find((a) => a.name === 'mistral-vibe');
      assert.equal(vibe?.installed, true);
      assert.match(vibe!.detection_method, /~\/\.vibe directory/);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does NOT detect when VIBE_HOME is unset', () => {
    const detected = detectAiAgent({});
    assert.equal(detected, undefined);
  });
});
