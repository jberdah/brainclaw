import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { ALL_TOOLS } from '../../src/commands/mcp.js';

/**
 * Cross-validator MCP inputSchema conformance check (trp#180 + pln#494).
 *
 * Two layers:
 *
 * 1. ajv strict mode — catches general JSON Schema malformations (unknown
 *    keywords, type/keyword conflicts, schema-level meta-violations).
 *
 * 2. MCP tool-spec conformance — Copilot, Cursor, Cline and other strict
 *    MCP clients require `items` on every `type: 'array'` subschema, even
 *    though baseline JSON Schema treats `items` as optional. This is a
 *    stricter contract than the JSON Schema spec; ajv strict alone does
 *    not catch it. The bug that produced trp#180 was exactly this: Claude
 *    Code accepted `phases: { type: 'array' }` with no items, Copilot
 *    rejected it with "tool parameters array type must have items".
 *
 * Without this test, a tool that works locally with Claude Code can fail
 * silently for adopters using stricter agents.
 */

interface McpToolDescriptor {
  name: string;
  inputSchema: Record<string, unknown>;
}

function createStrictAjv(): Ajv {
  return new Ajv({
    strict: true,
    strictSchema: true,
    strictTypes: true,
    strictTuples: true,
    validateSchema: true,
    allErrors: true,
  });
}

const NESTED_MAP_KEYS = ['properties', 'patternProperties', 'definitions', '$defs'] as const;
const NESTED_LIST_KEYS = ['allOf', 'anyOf', 'oneOf'] as const;
const NESTED_SINGLE_KEYS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'] as const;

/**
 * Walk an inputSchema recursively and report every `type: 'array'` subschema
 * that lacks `items` (or `prefixItems`). Returns JSON-pointer-like paths.
 */
function findArraysMissingItems(schema: unknown, pathParts: string[] = []): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const errors: string[] = [];

  if (node.type === 'array' && node.items === undefined && node.prefixItems === undefined) {
    errors.push('#/' + pathParts.join('/'));
  }

  for (const key of NESTED_MAP_KEYS) {
    const child = node[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const [subKey, subVal] of Object.entries(child)) {
        errors.push(...findArraysMissingItems(subVal, [...pathParts, key, subKey]));
      }
    }
  }

  for (const key of NESTED_LIST_KEYS) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) {
        errors.push(...findArraysMissingItems(child[i], [...pathParts, key, String(i)]));
      }
    }
  }

  for (const key of NESTED_SINGLE_KEYS) {
    const child = node[key];
    if (child && typeof child === 'object') {
      errors.push(...findArraysMissingItems(child, [...pathParts, key]));
    }
  }

  return errors;
}

describe('MCP tool inputSchemas — cross-validator conformance', () => {
  for (const tool of ALL_TOOLS as readonly McpToolDescriptor[]) {
    it(`${tool.name}: ajv strict accepts the schema`, () => {
      const ajv = createStrictAjv();
      try {
        ajv.compile(tool.inputSchema);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        assert.fail(
          `${tool.name} inputSchema rejected by ajv strict (likely malformed JSON Schema — see trp#180):\n${message}`,
        );
      }
    });

    it(`${tool.name}: every array subschema has items (MCP spec, stricter than JSON Schema)`, () => {
      const offending = findArraysMissingItems(tool.inputSchema);
      assert.deepEqual(
        offending,
        [],
        `${tool.name} has type:'array' subschemas missing 'items' at: ${offending.join(', ')}\n` +
        `This breaks Copilot, Cursor, Cline and other strict MCP clients (trp#180).\n` +
        `Fix: add items: { type: 'object' } (or a more specific schema) on each path above.`,
      );
    });
  }
});
