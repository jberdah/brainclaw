import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
