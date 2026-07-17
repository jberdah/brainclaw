import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLISHED_TOOLS, SCHEMA_VERSION } from '../../src/commands/mcp.js';
import { ENTITY_NAMES } from '../../src/core/entity-registry.js';
import { GRAMMAR_FILTER_CONTRACT } from '../../src/core/entity-operations.js';

/** Deterministic, order-insensitive form: sort string arrays + object keys. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);
    return mapped.every((v) => typeof v === 'string') ? [...mapped].sort() : mapped;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

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

// pln#625 — two parts of the public callable contract are invisible to the tool
// inputSchema and must be folded in explicitly (Codex review of PR #82):
//  - the SET of grammar-addressable entities: `entity` is a free `type:'string'`
//    (so the front door returns a curated UnknownEntityError, not an ajv reject)
//    and the description enumerating them is stripped below.
//  - the FILTER grammar: `filter` is an unconstrained object, so accepted keys,
//    entity-scoping, and constrained values (e.g. the Phase 2c `scope` filter)
//    would otherwise change the callable contract without moving the fingerprint.
// Parameterised so a mutation test can prove the fingerprint reacts to each.
function publicSurfaceFingerprint(
  entities: readonly string[] = ENTITY_NAMES,
  filterContract: unknown = GRAMMAR_FILTER_CONTRACT,
): string {
  const tools = PUBLISHED_TOOLS
    .map((tool) => ({
      name: tool.name,
      tier: tool.annotations?.tier,
      category: tool.annotations?.category,
      inputSchema: stripDescriptions(tool.inputSchema),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const publicSurface = {
    tools,
    grammar_entities: [...entities].sort(),
    filter_contract: canonicalize(filterContract),
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

  it('the fingerprint moves for an added entity, a new filter key, a re-scope, and a new allowed value', () => {
    const base = publicSurfaceFingerprint();

    // (a) a newly addressable grammar entity
    assert.notEqual(
      publicSurfaceFingerprint([...ENTITY_NAMES, 'widget'], GRAMMAR_FILTER_CONTRACT),
      base,
      'adding an addressable entity must move the fingerprint',
    );

    // (b) a new accepted filter key
    const addedKey = { ...GRAMMAR_FILTER_CONTRACT, common: [...GRAMMAR_FILTER_CONTRACT.common, 'banana'] };
    assert.notEqual(publicSurfaceFingerprint(ENTITY_NAMES, addedKey), base, 'adding a filter key must move the fingerprint');

    // (c) re-scoping a key (agent-only → agent_run-only)
    const reScoped = {
      ...GRAMMAR_FILTER_CONTRACT,
      entityScoped: { agent_run: [...GRAMMAR_FILTER_CONTRACT.entityScoped.agent_run, 'scope'], agent: [] as string[] },
    };
    assert.notEqual(publicSurfaceFingerprint(ENTITY_NAMES, reScoped), base, 're-scoping a filter key must move the fingerprint');

    // (d) a new constrained value
    const addedValue = { ...GRAMMAR_FILTER_CONTRACT, constrainedValues: { scope: ['project', 'global', 'workspace'] } };
    assert.notEqual(publicSurfaceFingerprint(ENTITY_NAMES, addedValue), base, 'adding an allowed value must move the fingerprint');
  });
});
