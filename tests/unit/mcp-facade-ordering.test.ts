/**
 * Regression: a fresh agent calling `tools/list` must see the Brainclaw
 * MCP facades first, in a deterministic order that matches the story
 * told in AGENTS.md / CLAUDE.md.
 *
 * Codex audit (2026-04-20) P2: the previous DEFAULT_PUBLISHED_TOOLS was
 * filtered from ALL_TOOLS in declaration order, which interleaved
 * standard tools with facades. It also tagged bclaw_dispatch and
 * bclaw_context as `standard` even though they are intent-dispatcher
 * facades by design. Fix: promote them to `facade` + explicit sort.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PUBLISHED_TOOLS, FACADE_ORDER } from '../../src/commands/mcp.js';

interface PublishedTool {
  name: string;
  annotations?: { tier?: string };
}

describe('mcp facade ordering — fresh-agent tools/list', () => {
  it('first tools are the facades in the canonical order', () => {
    const firstN = (DEFAULT_PUBLISHED_TOOLS as PublishedTool[])
      .slice(0, FACADE_ORDER.length)
      .map((t) => t.name);
    assert.deepEqual(
      firstN,
      [...FACADE_ORDER],
      'FACADE_ORDER drives the head of tools/list — promote/demote by editing that array',
    );
  });

  it('every tool tagged tier=facade is in FACADE_ORDER (no orphan facades)', () => {
    const declared = (DEFAULT_PUBLISHED_TOOLS as PublishedTool[])
      .filter((t) => t.annotations?.tier === 'facade')
      .map((t) => t.name)
      .sort();
    const expected = [...FACADE_ORDER].sort();
    assert.deepEqual(
      declared,
      expected,
      'every facade-tier tool must appear in FACADE_ORDER so its position is deterministic',
    );
  });

  it('bclaw_dispatch and bclaw_context are facade tier (intent-dispatchers by design)', () => {
    const dispatch = (DEFAULT_PUBLISHED_TOOLS as PublishedTool[]).find((t) => t.name === 'bclaw_dispatch');
    const context = (DEFAULT_PUBLISHED_TOOLS as PublishedTool[]).find((t) => t.name === 'bclaw_context');
    assert.equal(dispatch?.annotations?.tier, 'facade');
    assert.equal(context?.annotations?.tier, 'facade');
  });

  it('no tool without a tier slips into DEFAULT_PUBLISHED_TOOLS (guard against future additions)', () => {
    const untagged = (DEFAULT_PUBLISHED_TOOLS as PublishedTool[]).filter((t) => !t.annotations?.tier);
    assert.deepEqual(
      untagged.map((t) => t.name),
      [],
      'every published tool must have an annotations.tier (facade | standard | advanced)',
    );
  });

  it('standard tools come strictly after all facades', () => {
    const tools = DEFAULT_PUBLISHED_TOOLS as PublishedTool[];
    let lastFacadeIdx = -1;
    let firstStandardIdx = -1;
    for (let i = 0; i < tools.length; i++) {
      const tier = tools[i]!.annotations?.tier;
      if (tier === 'facade') lastFacadeIdx = i;
      if (tier === 'standard' && firstStandardIdx < 0) firstStandardIdx = i;
    }
    assert.ok(
      firstStandardIdx > lastFacadeIdx,
      `first standard tool at ${firstStandardIdx} must come after last facade at ${lastFacadeIdx}`,
    );
  });

  it('sequence coordination tools are visible in the default catalog', () => {
    const defaultNames = new Set((DEFAULT_PUBLISHED_TOOLS as PublishedTool[]).map((t) => t.name));
    const required = [
      'bclaw_list_sequences',
      'bclaw_create_sequence',
      'bclaw_update_sequence',
      'bclaw_delete_sequence',
    ];

    assert.deepEqual(
      required.filter((name) => !defaultNames.has(name)),
      [],
      'sequence tools are core agent-first coordination tools and must not be hidden behind catalog=all',
    );
  });
});
