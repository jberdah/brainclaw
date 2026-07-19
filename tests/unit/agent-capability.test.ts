import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAgentCapabilityProfile,
  getAllAgentCapabilityProfiles,
  getAgentsByTier,
  isKnownAgent,
  describeAgentSurfaces,
} from '../../src/core/agent-capability.js';

describe('agent-capability', () => {
  it('returns a profile for every known agent', () => {
    const agents = [
      'claude-code', 'cursor', 'windsurf', 'cline', 'roo',
      'continue', 'opencode', 'codex', 'antigravity', 'github-copilot',
      'kilocode', 'mistral-vibe', 'hermes', 'openclaw', 'nanoclaw', 'nemoclaw', 'picoclaw', 'zeroclaw',
      'claude-sonnet',
    ];
    for (const name of agents) {
      const profile = getAgentCapabilityProfile(name);
      assert.ok(profile, `profile missing for ${name}`);
      assert.equal(profile.name, name);
    }
  });

  it('returns undefined for unknown agent names', () => {
    assert.equal(getAgentCapabilityProfile('unknown-agent'), undefined);
    assert.equal(getAgentCapabilityProfile(''), undefined);
  });

  it('getAllAgentCapabilityProfiles returns all known agents', () => {
    const all = getAllAgentCapabilityProfiles();
    assert.equal(all.length, 19);
  });

  it('isKnownAgent validates known names', () => {
    assert.ok(isKnownAgent('claude-code'));
    assert.ok(isKnownAgent('github-copilot'));
    assert.ok(!isKnownAgent('gpt-4'));
    assert.ok(!isKnownAgent(''));
  });

  describe('template tiers', () => {
    it('tier A = agents with managed MCP/native surfaces', () => {
      const tierA = getAgentsByTier('A');
      assert.ok(tierA.length >= 1);
      for (const p of tierA) {
        assert.ok(p.hasMcp, `${p.name} in tier A should have MCP`);
      }
    });

    it('tier B = agents with MCP but no hooks (standard)', () => {
      const tierB = getAgentsByTier('B');
      assert.ok(tierB.length >= 1);
      for (const p of tierB) {
        assert.ok(p.hasMcp, `${p.name} in tier B should have MCP`);
        assert.ok(!p.hasHooks, `${p.name} in tier B should not have hooks`);
      }
    });

    it('tier C = agents without MCP (limited)', () => {
      const tierC = getAgentsByTier('C');
      assert.ok(tierC.length >= 1);
      for (const p of tierC) {
        assert.ok(!p.hasMcp, `${p.name} in tier C should not have MCP`);
      }
    });

    it('claude-code is tier A', () => {
      const profile = getAgentCapabilityProfile('claude-code')!;
      assert.equal(profile.templateTier, 'A');
      assert.ok(profile.hasMcp);
      assert.ok(profile.hasHooks);
      assert.ok(profile.hasAutoApprove);
      assert.ok(profile.hasSkills);
    });

    it('github-copilot is tier A with hooks and skills', () => {
      const profile = getAgentCapabilityProfile('github-copilot')!;
      assert.equal(profile.templateTier, 'A');
      assert.ok(profile.hasMcp);
      assert.ok(profile.hasHooks);
      assert.ok(profile.hasSkills);
    });

    it('cursor is tier A with hooks and machine-level MCP', () => {
      const profile = getAgentCapabilityProfile('cursor')!;
      assert.equal(profile.templateTier, 'A');
      assert.ok(profile.hasMcp);
      assert.ok(profile.hasHooks);
      assert.ok(profile.hasSkills);
      assert.equal(profile.mcpConfigScope, 'machine');
    });

    it('tier A agent surfaces are factual per agent', () => {
      const expected = new Map<string, { hooks: boolean; skills: boolean }>([
        ['cursor', { hooks: true, skills: true }],
        ['windsurf', { hooks: false, skills: false }],
        ['cline', { hooks: false, skills: false }],
        ['codex', { hooks: true, skills: true }], // Codex gained a native hook surface (trp_fe75dafc)
        ['github-copilot', { hooks: true, skills: true }],
      ]);

      for (const [name, surfaces] of expected) {
        const profile = getAgentCapabilityProfile(name)!;
        assert.equal(profile.templateTier, 'A', `${name} should be tier A`);
        assert.equal(profile.hasHooks, surfaces.hooks, `${name} hook support should match its native surface`);
        assert.equal(profile.hasSkills, surfaces.skills, `${name} skill support should match its writer surface`);
      }
    });

    it('roo, continue, antigravity stay tier B without hooks', () => {
      for (const name of ['roo', 'continue', 'antigravity']) {
        const profile = getAgentCapabilityProfile(name)!;
        assert.equal(profile.templateTier, 'B', `${name} should be tier B`);
        assert.ok(!profile.hasHooks, `${name} should NOT have hooks`);
      }
    });
  });

  describe('describeAgentSurfaces', () => {
    it('lists all surfaces for claude-code', () => {
      const surfaces = describeAgentSurfaces('claude-code');
      assert.ok(surfaces.some((s) => s.includes('MCP')));
      assert.ok(surfaces.some((s) => s.includes('Instruction file')));
      assert.ok(surfaces.some((s) => s.includes('Auto-approve')));
      assert.ok(surfaces.some((s) => s.includes('hooks')));
      assert.ok(surfaces.some((s) => s.includes('skill')));
    });

    it('lists full surfaces for github-copilot (tier A)', () => {
      const surfaces = describeAgentSurfaces('github-copilot');
      assert.ok(surfaces.some((s) => s.includes('MCP')));
      assert.ok(surfaces.some((s) => s.includes('Instruction file')));
      assert.ok(surfaces.some((s) => s.includes('hooks')));
      assert.ok(surfaces.some((s) => s.includes('skill')));
    });

    it('returns empty array for unknown agent', () => {
      const surfaces = describeAgentSurfaces('unknown');
      assert.deepEqual(surfaces, []);
    });
  });

  describe('instruction file metadata', () => {
    it('shared instruction files use sentinels', () => {
      const shared = getAllAgentCapabilityProfiles().filter((p) => p.sharedInstructionFile);
      // CLAUDE.md, .windsurfrules, AGENTS.md (opencode+codex), GEMINI.md, copilot-instructions
      assert.ok(shared.length >= 5);
      for (const p of shared) {
        assert.ok(
          ['CLAUDE.md', '.windsurfrules', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md'].includes(p.instructionFile),
          `${p.name} has unexpected shared instruction file: ${p.instructionFile}`,
        );
      }
    });

    it('dedicated instruction files do not need sentinels', () => {
      const dedicated = getAllAgentCapabilityProfiles().filter((p) => !p.sharedInstructionFile);
      for (const p of dedicated) {
        assert.ok(
          p.instructionFile.includes('/'),
          `${p.name} dedicated file should be in a subdirectory: ${p.instructionFile}`,
        );
      }
    });
  });
});
