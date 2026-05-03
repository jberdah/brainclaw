import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { LoopPhaseSchema } from '../../src/core/loops/types.js';
import { LoopSlotInputSchema } from '../../src/core/loops/facade-schema.js';
import { generatedSchemas } from '../../src/commands/mcp-schemas.generated.js';

/**
 * Parity test for zod-derived MCP schemas (pln#494 phase 2c).
 *
 * Verifies that the committed `mcp-schemas.generated.ts` matches what
 * `z.toJSONSchema()` produces from the source zod schemas RIGHT NOW.
 * Drift means someone changed a zod schema without re-running
 * `npm run build:mcp-schemas`.
 *
 * If this test fails: run `npm run build:mcp-schemas`, commit the
 * regenerated file, then push. Same workflow as protobuf code generation.
 */

function freshGenerate(zodSchema: z.ZodTypeAny): unknown {
  const generated = z.toJSONSchema(zodSchema) as Record<string, unknown>;
  if ('$schema' in generated) {
    delete generated.$schema;
  }
  return generated;
}

describe('MCP zod-derived schemas — parity with committed mcp-schemas.generated.ts', () => {
  it('LoopPhase: committed === fresh regen of LoopPhaseSchema', () => {
    const fresh = freshGenerate(LoopPhaseSchema);
    assert.deepEqual(
      generatedSchemas.LoopPhase,
      fresh,
      'mcp-schemas.generated.ts is stale for LoopPhase. Run: npm run build:mcp-schemas',
    );
  });

  it('LoopSlotInput: committed === fresh regen of LoopSlotInputSchema', () => {
    const fresh = freshGenerate(LoopSlotInputSchema);
    assert.deepEqual(
      generatedSchemas.LoopSlotInput,
      fresh,
      'mcp-schemas.generated.ts is stale for LoopSlotInput. Run: npm run build:mcp-schemas',
    );
  });
});
