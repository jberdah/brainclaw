/**
 * Static tool-policy ↔ catalog coherence (pln#622 PR1).
 *
 * src/core/protocol-tool-policy.ts materialises STATIC tool-name lists so
 * core/ consumers (agent-files.ts) no longer import the commands/ MCP layer.
 * The catalog (src/commands/mcp-catalog.ts) keeps DERIVING its own copies
 * from ALL_TOOLS annotations. This test enforces BIDIRECTIONAL set equality
 * (policy ⊆ catalog AND catalog ⊆ policy) for each list, with failure
 * messages listing what is missing on each side.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_HEADLESS_AUTO_TOOL_NAMES as POLICY_HEADLESS_AUTO,
  MCP_CANONICAL_GRAMMAR_TOOL_NAMES as POLICY_CANONICAL_GRAMMAR,
  MCP_HERMES_WORKFLOW_TOOL_NAMES as POLICY_HERMES_WORKFLOW,
  REMOVED_IN_V1_TOOLS as POLICY_REMOVED_IN_V1,
} from '../../src/core/protocol-tool-policy.js';
import {
  ALL_TOOLS,
  MCP_HEADLESS_AUTO_TOOL_NAMES as CATALOG_HEADLESS_AUTO,
  MCP_CANONICAL_GRAMMAR_TOOL_NAMES as CATALOG_CANONICAL_GRAMMAR,
  REMOVED_IN_V1_TOOLS as CATALOG_REMOVED_IN_V1,
} from '../../src/commands/mcp-catalog.js';

function assertSetEquality(policy: Iterable<string>, catalog: Iterable<string>, label: string): void {
  const policySet = new Set(policy);
  const catalogSet = new Set(catalog);
  const missingFromPolicy = [...catalogSet].filter((name) => !policySet.has(name));
  const missingFromCatalog = [...policySet].filter((name) => !catalogSet.has(name));
  assert.ok(
    missingFromPolicy.length === 0 && missingFromCatalog.length === 0,
    `${label}: static policy list and catalog derivation diverged.\n` +
      `  In catalog but MISSING from core/protocol-tool-policy.ts: [${missingFromPolicy.join(', ') || '—'}]\n` +
      `  In core/protocol-tool-policy.ts but MISSING from catalog: [${missingFromCatalog.join(', ') || '—'}]\n` +
      'Update src/core/protocol-tool-policy.ts to mirror the catalog (or fix the annotation).',
  );
}

describe('protocol-tool-policy ↔ catalog set equality (pln#622 PR1)', () => {
  it('MCP_HEADLESS_AUTO_TOOL_NAMES matches the set derived from ALL_TOOLS annotations', () => {
    const derived = ALL_TOOLS
      .filter((tool) => (tool as { annotations?: { headlessApproval?: string } }).annotations?.headlessApproval === 'auto')
      .map((tool) => tool.name);
    assertSetEquality(POLICY_HEADLESS_AUTO, derived, 'MCP_HEADLESS_AUTO_TOOL_NAMES');
  });

  it('MCP_HEADLESS_AUTO_TOOL_NAMES matches the catalog export (order included)', () => {
    // Order matters downstream: agent-files writers emit approval entries in
    // list order, so generated configs must stay byte-identical.
    assert.deepEqual(POLICY_HEADLESS_AUTO, CATALOG_HEADLESS_AUTO);
  });

  it('MCP_CANONICAL_GRAMMAR_TOOL_NAMES matches the catalog derivation', () => {
    assertSetEquality(POLICY_CANONICAL_GRAMMAR, CATALOG_CANONICAL_GRAMMAR, 'MCP_CANONICAL_GRAMMAR_TOOL_NAMES');
    // Order matters here too (checkpoint-2 review): the canonical list flows
    // into generated tools.include configuration exactly like the headless
    // list — a catalog reorder must fail this test, not silently reorder
    // generated agent configs.
    assert.deepEqual(POLICY_CANONICAL_GRAMMAR, CATALOG_CANONICAL_GRAMMAR);
  });

  it('MCP_HERMES_WORKFLOW_TOOL_NAMES contains only published, non-removed tools', () => {
    const catalogNames = new Set<string>(ALL_TOOLS.map((tool) => tool.name));
    const removedTools = new Set<string>(POLICY_REMOVED_IN_V1);
    for (const name of POLICY_HERMES_WORKFLOW) {
      assert.ok(catalogNames.has(name), `${name} is not present in the MCP catalog`);
      assert.ok(!removedTools.has(name), `${name} is removed from the v1 MCP surface`);
    }
  });

  it('REMOVED_IN_V1_TOOLS matches the catalog set', () => {
    assertSetEquality(POLICY_REMOVED_IN_V1, CATALOG_REMOVED_IN_V1, 'REMOVED_IN_V1_TOOLS');
  });
});
