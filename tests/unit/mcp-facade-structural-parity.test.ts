import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { WorkRequestSchema, CoordinateRequestSchema } from '../../src/core/facade-schema.js';
import { PUBLISHED_TOOLS } from '../../src/commands/mcp.js';

/**
 * Structural parity guard for the HAND-WRITTEN facade inputSchemas
 * (pln#622 PR0b). Sister test of mcp-zod-parity.test.ts: that one guards
 * the zod-DERIVED generated schemas (LoopPhase / LoopSlotInput) against
 * regen drift; THIS one guards the hand-maintained facade tool schemas
 * (bclaw_work, bclaw_coordinate) against structural drift from their zod
 * request schemas in src/core/facade-schema.ts.
 *
 * Motivating bug (fixed in this PR): the zod schema accepted `preset` and
 * `client_request_id`, the handler validated and used both, and bclaw_work
 * next_actions literally recommended
 * `bclaw_coordinate(intent='ideate', preset='bootstrap')` — but the
 * published inputSchema of bclaw_coordinate declared NEITHER. The product
 * advertised a parameter its own catalog did not declare, so strict MCP
 * clients could not follow the product's own recommendation.
 *
 * What IS asserted, bidirectionally:
 *   (a) every key of the zod object shape exists in the published
 *       `properties` (zod → published);
 *   (b) every published property exists in the zod shape OR in an explicit,
 *       justified adapter-envelope allowlist (published → zod);
 *   (c) enum values, whenever BOTH sides declare an enum for the same key
 *       (e.g. intent, review_mode).
 *
 * What is deliberately NOT asserted:
 *   - descriptions: prose diverges freely between the JSDoc and the client-
 *     facing catalog (the governance fingerprint strips them too);
 *   - `required` arrays: requiredness legitimately diverges. The zod side
 *     encodes it via .optional()/.default() wrappers plus handler-level
 *     conditional rules (e.g. bclaw_work scope is only needed for
 *     intent='execute', threadId only for summarize), while the published
 *     `required` is the hand-maintained unconditional floor shown to MCP
 *     clients. Comparing them would force one side to lie.
 */

/**
 * Adapter-envelope fields: published to MCP clients but intentionally
 * absent from the facade zod request schemas. They are consumed by the
 * MCP identity/audit layer (resolveAgentIdentity et al.) BEFORE the
 * request body reaches the facade handler, so the zod schema never sees
 * them. Every published-but-not-in-zod property must be listed here with
 * a justification, or the test fails.
 */
const ENVELOPE_ALLOWLIST: Record<string, Record<string, string>> = {
  bclaw_work: {
    agent: 'caller identity envelope — resolved by the MCP identity layer, not the facade zod schema',
    agentId: 'caller identity envelope — resolved by the MCP identity layer, not the facade zod schema',
  },
  bclaw_coordinate: {
    agent: 'caller identity envelope — resolved by the MCP identity layer, not the facade zod schema',
    agentId: 'caller identity envelope — resolved by the MCP identity layer, not the facade zod schema',
  },
};

interface PublishedProperty {
  type?: string;
  enum?: readonly string[];
  [key: string]: unknown;
}

interface PublishedInputSchema {
  type: string;
  properties: Record<string, PublishedProperty>;
  required?: readonly string[];
}

/**
 * Peel zod wrapper types down to the underlying schema so enum detection
 * works regardless of .optional() / .default() / z.preprocess() layering
 * (e.g. coordinate.allow_dirty is a preprocess pipe around an optional
 * boolean; work.compact is optional-with-default).
 */
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodPipe) {
      // z.preprocess produces a pipe; the OUT side carries the declared shape.
      current = current.def.out as z.ZodTypeAny;
    } else {
      return current;
    }
  }
}

const PARITY_PAIRS = [
  { tool: 'bclaw_work', zodSchema: WorkRequestSchema },
  { tool: 'bclaw_coordinate', zodSchema: CoordinateRequestSchema },
] as const;

describe('MCP facade schemas — structural parity with facade-schema.ts zod sources', () => {
  for (const { tool, zodSchema } of PARITY_PAIRS) {
    describe(`${tool}`, () => {
      const published = PUBLISHED_TOOLS.find((entry) => entry.name === tool);
      assert.ok(published, `${tool} must be present in PUBLISHED_TOOLS`);
      const inputSchema = published.inputSchema as unknown as PublishedInputSchema;
      const properties = inputSchema.properties;
      const zodShape = zodSchema.shape as Record<string, z.ZodTypeAny>;
      const allowlist = ENVELOPE_ALLOWLIST[tool] ?? {};

      it('every zod shape key is declared in the published properties', () => {
        const missing = Object.keys(zodShape).filter((key) => !(key in properties));
        assert.deepEqual(
          missing,
          [],
          `${tool}: zod accepts [${missing.join(', ')}] but the published inputSchema does not declare them. ` +
          'Strict MCP clients cannot pass undeclared parameters — publish them (and update the governance ' +
          'fingerprint in docs/mcp-schema-changelog.md).',
        );
      });

      it('every published property is in the zod shape or the envelope allowlist', () => {
        const unknown = Object.keys(properties).filter(
          (key) => !(key in zodShape) && !(key in allowlist),
        );
        assert.deepEqual(
          unknown,
          [],
          `${tool}: published inputSchema declares [${unknown.join(', ')}] but the zod schema does not accept ` +
          'them and they are not allowlisted envelope fields. Either add them to the zod schema, or — if the ' +
          'MCP adapter layer consumes them before the handler — add them to ENVELOPE_ALLOWLIST with a justification.',
        );
      });

      it('allowlist entries are actually published (no stale allowlist)', () => {
        const stale = Object.keys(allowlist).filter((key) => !(key in properties));
        assert.deepEqual(
          stale,
          [],
          `${tool}: ENVELOPE_ALLOWLIST lists [${stale.join(', ')}] but they are no longer published — prune the allowlist.`,
        );
      });

      it('enum values match wherever both sides declare an enum', () => {
        for (const [key, property] of Object.entries(properties)) {
          const zodField = zodShape[key];
          if (!zodField) continue; // envelope field — no zod counterpart
          const unwrapped = unwrapZod(zodField);
          const publishedEnum = property.enum;
          if (unwrapped instanceof z.ZodEnum && Array.isArray(publishedEnum)) {
            assert.deepEqual(
              [...publishedEnum].sort(),
              [...unwrapped.options].sort(),
              `${tool}.${key}: published enum values diverge from the zod enum.`,
            );
          }
        }
      });
    });
  }
});
