import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REMOVED_IN_V1_TOOLS } from '../../src/commands/mcp.js';

/**
 * Phase 3 slice 3g — verify every tool deprecated by the canonical
 * grammar has an entry in LEGACY_MCP_TOOL_WARNINGS pointing at its
 * replacement. Parses src/commands/mcp.ts as text to avoid importing
 * the full MCP runtime into the unit suite.
 */
describe('commands/mcp — LEGACY_MCP_TOOL_WARNINGS coverage', () => {
  const source = readFileSync(path.join('src', 'commands', 'mcp.ts'), 'utf-8');

  const EXPECTED_DEPRECATED = [
    // Facade-era
    'bclaw_session_start',
    'bclaw_claim',
    'bclaw_get_context',
    'bclaw_check_policy',
    // Slice 3e
    'bclaw_update_handoff',
    // Slice 3g — canonical CRUD replacements
    'bclaw_list_plans',
    'bclaw_list_candidates',
    'bclaw_list_claims',
    'bclaw_list_actions',
    'bclaw_list_assignments',
    'bclaw_list_runs',
    'bclaw_read_handoff',
    'bclaw_create_plan',
    'bclaw_update_plan',
    'bclaw_create_candidate',
    'bclaw_accept',
    'bclaw_reject',
    // Slice 3c — context consolidation
    'bclaw_get_execution_context',
    'bclaw_get_agent_board',
    'bclaw_get_agent_board_summary',
    // Slice 3d — dispatch consolidation
    'bclaw_dispatch_analysis',
    'bclaw_dispatch_review',
  ];

  it('every deprecated tool has a warning entry (Deprecated: or Removed in v1.0:)', () => {
    const missing: string[] = [];
    for (const name of EXPECTED_DEPRECATED) {
      const pattern = new RegExp(`\\b${name}:\\s*'(Deprecated|Removed in v1\\.0)`, 'm');
      if (!pattern.test(source)) missing.push(name);
    }
    assert.equal(
      missing.length,
      0,
      `Missing LEGACY_MCP_TOOL_WARNINGS/REMOVED_TOOL_REDIRECTS entries: ${missing.join(', ')}`,
    );
  });

  it('every warning points at a concrete replacement (bclaw_X(...) or "use Y")', () => {
    const entries = [...source.matchAll(/^\s*(bclaw_\w+):\s*'([^']+)'/gm)];
    for (const match of entries) {
      const [, name, msg] = match;
      if (!msg!.startsWith('Deprecated') && !msg!.startsWith('Removed in v1.0')) continue;
      const hasReplacement = /\buse\b/i.test(msg!) && /bclaw_\w+/.test(msg!);
      assert.ok(
        hasReplacement,
        `${name}: warning must name a replacement tool — got: ${msg}`,
      );
    }
  });

  it('the deprecation warning wrapper is applied at executeMcpToolCall exit', () => {
    // Verify the Phase 3 slice 3g wrapper: appendLegacyMcpToolWarning
    // called on outcome.response inside executeMcpToolCall.
    assert.match(
      source,
      /appendLegacyMcpToolWarning\(outcome\.response, payload\.name\)/,
      'Legacy warning wrapper missing from executeMcpToolCall outcome path.',
    );
  });
});

/**
 * v1.0 catalog integrity — regression guard.
 * Verifies that tools/list (default and catalog=all) excludes the 19
 * tools removed at v1.0, and that canonical verbs appear in the default
 * catalog. Guards against accidental re-introduction of removed tools.
 */
describe('commands/mcp — v1.0 catalog integrity', () => {
  const source = readFileSync(path.join('src', 'commands', 'mcp.ts'), 'utf-8');

  // Canonical grammar verbs — tier:standard in the default catalog.
  // NOTE: bclaw_context is also a canonical read verb but is tagged
  // tier:facade (shipped alongside bclaw_work as the entry-point pair).
  // Its presence in the default catalog is checked in a separate facade
  // ordering test, not here.
  const CANONICAL_VERBS = [
    'bclaw_find',
    'bclaw_get',
    'bclaw_create',
    'bclaw_update',
    'bclaw_remove',
    'bclaw_transition',
    'bclaw_correct_handoff',
  ];

  it('REMOVED_IN_V1_TOOLS contains exactly 19 entries (v1.0 catalog snapshot)', () => {
    assert.equal(
      REMOVED_IN_V1_TOOLS.size,
      19,
      `Expected 19 removed tools, got ${REMOVED_IN_V1_TOOLS.size}: ${[...REMOVED_IN_V1_TOOLS].join(', ')}`,
    );
  });

  it('PUBLISHED_TOOLS filter excludes every entry in REMOVED_IN_V1_TOOLS', () => {
    // Verify the filter is applied: PUBLISHED_TOOLS = ALL_TOOLS.filter(!REMOVED_IN_V1_TOOLS)
    assert.match(
      source,
      /PUBLISHED_TOOLS\s*=\s*ALL_TOOLS\.filter[\s\S]{1,120}REMOVED_IN_V1_TOOLS/m,
      'PUBLISHED_TOOLS must be built by filtering ALL_TOOLS against REMOVED_IN_V1_TOOLS.',
    );
  });

  it('catalog=all and default tools/list both return PUBLISHED_TOOLS (not ALL_TOOLS)', () => {
    // Verify that every tools/list branch (default, catalog=all, tier filter) uses
    // PUBLISHED_TOOLS — not ALL_TOOLS — so removed tools can never leak through.
    const allToolsLeaks = source.match(
      /tools\s*=\s*ALL_TOOLS(?!\s*\.filter)/g,
    );
    assert.equal(
      allToolsLeaks ?? null,
      null,
      `tools/list assigns ALL_TOOLS directly (removed tools would leak): ${JSON.stringify(allToolsLeaks)}`,
    );
  });

  it('canonical verbs are annotated tier:standard (appear in default catalog)', () => {
    const missing: string[] = [];
    for (const verb of CANONICAL_VERBS) {
      // Match: name: 'bclaw_find', ... annotations: { tier: 'standard', ...
      const toolBlock = new RegExp(
        `name:\\s*'${verb}'[\\s\\S]{1,800}?tier:\\s*'standard'`,
        'm',
      );
      if (!toolBlock.test(source)) missing.push(verb);
    }
    assert.equal(
      missing.length,
      0,
      `Canonical verbs missing tier:standard: ${missing.join(', ')}`,
    );
  });
});
