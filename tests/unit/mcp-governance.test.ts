import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLISHED_TOOLS, SCHEMA_VERSION } from '../../src/commands/mcp.js';
import { ENTITY_NAMES } from '../../src/core/entity-registry.js';

function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDescriptions);
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      if (key === 'description') continue;
      normalized[key] = stripDescriptions(child);
    }
    return normalized;
  }

  return value;
}

function publicSurfaceFingerprint(): string {
  const tools = PUBLISHED_TOOLS
    .map((tool) => ({
      name: tool.name,
      tier: tool.annotations?.tier,
      category: tool.annotations?.category,
      inputSchema: stripDescriptions(tool.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // pln#625 — the SET of grammar-addressable entities is part of the public
  // surface, but it is invisible to the tool inputSchema: `entity` is a free
  // `type: 'string'` (so the front door can return a curated UnknownEntityError
  // instead of an opaque ajv rejection) and the description that lists the
  // entities is stripped above. Fold ENTITY_NAMES into the fingerprint so that
  // wiring a new addressable entity (e.g. bclaw_find(entity='agent')) moves the
  // fingerprint and forces a changelog entry — closing the blind spot surfaced
  // by the Phase 2c ideation loop (lop_f8e8d18cb8c27ada).
  const publicSurface = {
    tools,
    grammar_entities: [...ENTITY_NAMES].sort(),
  };

  return createHash('sha256')
    .update(JSON.stringify(publicSurface))
    .digest('hex')
    .slice(0, 16);
}

function currentChangelogSection(): string {
  const changelog = fs.readFileSync(path.join(process.cwd(), 'docs', 'mcp-schema-changelog.md'), 'utf-8');
  const currentHeading = changelog.match(/^##\s+([0-9]+\.[0-9]+\.[0-9]+)\s+\(current\)/m);
  assert.ok(currentHeading, 'docs/mcp-schema-changelog.md must have a current version heading');
  assert.equal(currentHeading[1], SCHEMA_VERSION, 'SCHEMA_VERSION must match the current MCP changelog heading');

  const start = currentHeading.index ?? 0;
  const next = changelog.slice(start + 1).search(/^##\s+/m);
  return next >= 0 ? changelog.slice(start, start + 1 + next) : changelog.slice(start);
}

describe('MCP governance guard', () => {
  it('requires the current changelog to record the public MCP surface fingerprint', () => {
    const expected = `MCP public surface fingerprint: \`sha256:${publicSurfaceFingerprint()}\``;

    assert.ok(
      currentChangelogSection().includes(expected),
      `public MCP surface changed without a matching changelog update. Add this line to the current docs/mcp-schema-changelog.md section: ${expected}`,
    );
  });
});
