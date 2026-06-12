/**
 * Drift tests for catalog-derived mirrors (pln#546 step 2).
 *
 * Each consumer below USED to maintain its own hand-curated copy of a slice of
 * a canonical catalog (AGENT_EXPORT_REGISTRY, AGENT_WIRING_REGISTRY, ALL_TOOLS).
 * The mirrors silently drifted whenever a new agent or tool was added in only
 * one place. These tests fail loudly on any future drift so the build catches
 * the divergence before users do.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

import {
  AGENT_EXPORT_REGISTRY,
  AGENT_WIRING_REGISTRY,
  ensureHermesMcpConfig,
  resolveExportTarget,
} from '../../src/core/agent-files.js';
import {
  ALL_TOOLS,
  MCP_CANONICAL_GRAMMAR_TOOL_NAMES,
  REMOVED_IN_V1_TOOLS,
} from '../../src/commands/mcp.js';
import { getCapabilityProfile, DEFAULT_CAPABILITY_PROFILES } from '../../src/core/agent-capability.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mirrors-'));
}

describe('catalog-derived mirrors — drift detection', () => {
  it('every AGENT_EXPORT_REGISTRY entry has a matching capability profile', () => {
    // Only entries whose agentName maps to a registered agent need a profile;
    // 'brainclaw' is the special board-md surface (not a coding agent).
    const exempt = new Set(['brainclaw']);
    for (const target of AGENT_EXPORT_REGISTRY) {
      if (exempt.has(target.agentName)) continue;
      const profile = getCapabilityProfile(target.agentName);
      assert.ok(
        profile,
        `AGENT_EXPORT_REGISTRY entry for "${target.agentName}" has no capability profile in DEFAULT_CAPABILITY_PROFILES`,
      );
    }
  });

  it('every AGENT_WIRING_REGISTRY entry has a matching capability profile', () => {
    for (const agentName of Object.keys(AGENT_WIRING_REGISTRY)) {
      const profile = getCapabilityProfile(agentName);
      assert.ok(
        profile,
        `AGENT_WIRING_REGISTRY entry for "${agentName}" has no capability profile — orphan writer descriptor`,
      );
    }
  });

  it('every capability profile that supports MCP or rules has a wiring descriptor', () => {
    // An agent that brainclaw can integrate with — i.e. has MCP, rules, or is
    // listed in AGENT_EXPORT_REGISTRY as a target — must have a wiring entry
    // so the three orchestrators can find it. SKILL.md-only agents
    // (nano/nemo/pico/zeroclaw) need entries too (they're empty no-ops to
    // make their absence explicit instead of a silent skip).
    for (const [name, profile] of Object.entries(DEFAULT_CAPABILITY_PROFILES)) {
      const inExport = AGENT_EXPORT_REGISTRY.some((t) => t.agentName === name);
      const needsWiring = profile.hasMcp || profile.hasRules || inExport;
      if (!needsWiring) continue;
      assert.ok(
        AGENT_WIRING_REGISTRY[name],
        `capability profile "${name}" needs a wiring descriptor (hasMcp=${profile.hasMcp}, hasRules=${profile.hasRules}, exported=${inExport})`,
      );
    }
  });

  it('resolveExportTarget(agentName) matches the registry entry for known agents', () => {
    for (const target of AGENT_EXPORT_REGISTRY) {
      const resolved = resolveExportTarget(target.agentName);
      assert.equal(resolved.format, target.format);
      assert.equal(resolved.relativePath, target.relativePath);
    }
  });

  it('MCP_CANONICAL_GRAMMAR_TOOL_NAMES is derived from ALL_TOOLS (no hand-curated drift)', () => {
    // Re-derive using the same rule the source applies and compare. If anyone
    // in the future hand-edits the list to a literal array, this test fails
    // because the derivation rule no longer reproduces the array.
    const verbs = new Set(['bclaw_find', 'bclaw_get', 'bclaw_create', 'bclaw_update', 'bclaw_transition']);
    const expected = ALL_TOOLS
      .filter((t) => {
        const ann = (t as { annotations?: { tier?: string; category?: string; headlessApproval?: string } }).annotations ?? {};
        if (
          ann.tier === 'facade'
          && (ann.category === 'session' || ann.category === 'context')
          && ann.headlessApproval === 'auto'
        ) {
          return true;
        }
        return verbs.has(t.name);
      })
      .map((t) => t.name);
    assert.deepEqual(MCP_CANONICAL_GRAMMAR_TOOL_NAMES.slice().sort(), expected.slice().sort());
  });

  it('MCP_CANONICAL_GRAMMAR_TOOL_NAMES excludes coordination facades', () => {
    // Coordination tools (dispatch, coordinate, loop) ARE facade tier but
    // shouldn't appear in narrow-surface configs — Hermes etc. don't route work.
    for (const name of ['bclaw_dispatch', 'bclaw_coordinate', 'bclaw_loop', 'bclaw_dispatch_status', 'bclaw_setup']) {
      assert.ok(
        !MCP_CANONICAL_GRAMMAR_TOOL_NAMES.includes(name),
        `${name} should NOT be in the canonical-grammar tool set (narrow surfaces don't route work)`,
      );
    }
  });

  it('canonical-grammar tool set matches the historical Hermes hand-curated list', () => {
    // Lock the derivation against the original 7 names that Hermes shipped
    // with before pln#546 — finds drift in the rule (not just the inputs)
    // if a refactor accidentally narrows or widens the canonical set.
    const expected = [
      'bclaw_work',
      'bclaw_context',
      'bclaw_find',
      'bclaw_get',
      'bclaw_create',
      'bclaw_update',
      'bclaw_transition',
    ];
    assert.deepEqual(MCP_CANONICAL_GRAMMAR_TOOL_NAMES.slice().sort(), expected.slice().sort());
  });

  it('Hermes MCP config emits exactly the canonical-grammar surface', () => {
    const homeDir = tmpDir();
    try {
      const result = ensureHermesMcpConfig(homeDir);
      assert.ok(result, 'Hermes writer should return a result when homeDir is provided');
      const filePath = path.join(homeDir, '.hermes', 'config.yaml');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.parse(raw) as {
        mcp_servers?: { brainclaw?: { tools?: { include?: string[] } } };
      };
      const include = parsed.mcp_servers?.brainclaw?.tools?.include;
      assert.ok(Array.isArray(include), 'Hermes mcp_servers.brainclaw.tools.include should be an array');
      const expected = MCP_CANONICAL_GRAMMAR_TOOL_NAMES.filter((n) => !REMOVED_IN_V1_TOOLS.has(n));
      assert.deepEqual(include?.slice().sort(), expected.slice().sort());
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('every AGENT_WIRING_REGISTRY entry produces only AutoConfigWriteResult-shaped values', () => {
    // Smoke check: each writer in the registry, when invoked against an
    // ephemeral cwd and undefined homeDir, returns either undefined / null /
    // a result object / an array of result objects. Catches accidental
    // refactors that return raw strings or non-conforming shapes.
    const cwd = tmpDir();
    try {
      for (const [name, descriptor] of Object.entries(AGENT_WIRING_REGISTRY)) {
        for (const fn of descriptor.workspaceWriters) {
          const v = fn({ cwd, homeDir: undefined, env: {}, workspacePath: cwd });
          if (v == null) continue;
          const arr = Array.isArray(v) ? v : [v];
          for (const r of arr) {
            assert.ok(
              typeof r === 'object' && r !== null && 'kind' in r && 'filePath' in r,
              `${name} workspaceWriter returned non-conforming value: ${JSON.stringify(r)}`,
            );
          }
        }
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
