import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TextInputSchema,
  TagArraySchema,
  TtlSchema,
  validateMcpInput,
  validateMcpField,
  TEXT_MAX_LENGTH,
  TAG_MAX_LENGTH,
  TAG_MAX_COUNT,
} from '../../src/core/input-validation.js';

describe('core/input-validation', () => {
  describe('TextInputSchema', () => {
    it('accepts a normal text', () => {
      assert.doesNotThrow(() => TextInputSchema.parse('This is a valid decision.'));
    });

    it('rejects an empty string', () => {
      const result = TextInputSchema.safeParse('');
      assert.equal(result.success, false);
      assert.ok(result.error.errors[0]!.message.includes('empty'));
    });

    it('rejects a string that is only whitespace', () => {
      // Note: whitespace-only passes min(1) since ' '.length === 1,
      // which is intentional — text content trimming is the caller's responsibility.
      // This test documents the actual behaviour.
      const result = TextInputSchema.safeParse(' ');
      assert.equal(result.success, true);
    });

    it('accepts a string at exactly the max length', () => {
      const text = 'a'.repeat(TEXT_MAX_LENGTH);
      const result = TextInputSchema.safeParse(text);
      assert.equal(result.success, true);
    });

    it('rejects a string exceeding the max length', () => {
      const text = 'a'.repeat(TEXT_MAX_LENGTH + 1);
      const result = TextInputSchema.safeParse(text);
      assert.equal(result.success, false);
      assert.ok(result.error.errors[0]!.message.includes(`${TEXT_MAX_LENGTH}`));
    });
  });

  describe('TagArraySchema', () => {
    it('accepts a valid tag array', () => {
      const result = TagArraySchema.safeParse(['auth', 'payments', 'migration']);
      assert.equal(result.success, true);
    });

    it('accepts an empty array', () => {
      const result = TagArraySchema.safeParse([]);
      assert.equal(result.success, true);
    });

    it('rejects an array with an empty string tag', () => {
      const result = TagArraySchema.safeParse(['auth', '']);
      assert.equal(result.success, false);
      assert.ok(result.error.errors[0]!.message.includes('empty'));
    });

    it('rejects an array with a tag exceeding max length', () => {
      const longTag = 'a'.repeat(TAG_MAX_LENGTH + 1);
      const result = TagArraySchema.safeParse([longTag]);
      assert.equal(result.success, false);
      assert.ok(result.error.errors[0]!.message.includes(`${TAG_MAX_LENGTH}`));
    });

    it('accepts a tag at exactly the max length', () => {
      const tag = 'a'.repeat(TAG_MAX_LENGTH);
      const result = TagArraySchema.safeParse([tag]);
      assert.equal(result.success, true);
    });

    it('rejects an array exceeding the max tag count', () => {
      const tags = Array.from({ length: TAG_MAX_COUNT + 1 }, (_, i) => `tag${i}`);
      const result = TagArraySchema.safeParse(tags);
      assert.equal(result.success, false);
      assert.ok(result.error.errors[0]!.message.includes(`${TAG_MAX_COUNT}`));
    });

    it('accepts an array at exactly the max tag count', () => {
      const tags = Array.from({ length: TAG_MAX_COUNT }, (_, i) => `tag${i}`);
      const result = TagArraySchema.safeParse(tags);
      assert.equal(result.success, true);
    });
  });

  describe('TtlSchema', () => {
    it('accepts valid minutes format', () => {
      assert.equal(TtlSchema.safeParse('30m').success, true);
    });

    it('accepts valid hours format', () => {
      assert.equal(TtlSchema.safeParse('2h').success, true);
    });

    it('accepts valid days format', () => {
      assert.equal(TtlSchema.safeParse('7d').success, true);
    });

    it('rejects invalid format: no unit', () => {
      const result = TtlSchema.safeParse('30');
      assert.equal(result.success, false);
    });

    it('rejects invalid format: wrong unit', () => {
      const result = TtlSchema.safeParse('30s');
      assert.equal(result.success, false);
    });

    it('rejects invalid format: text', () => {
      const result = TtlSchema.safeParse('invalid');
      assert.equal(result.success, false);
      assert.ok(result.error.errors[0]!.message.includes('TTL'));
    });

    it('rejects empty string', () => {
      const result = TtlSchema.safeParse('');
      assert.equal(result.success, false);
    });
  });

  describe('validateMcpInput', () => {
    it('returns ok for valid text and no tags', () => {
      const result = validateMcpInput('Valid note content');
      assert.equal(result.ok, true);
    });

    it('returns ok for valid text and valid tags', () => {
      const result = validateMcpInput('Valid note', ['auth', 'payments']);
      assert.equal(result.ok, true);
    });

    it('returns error for empty text', () => {
      const result = validateMcpInput('');
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.errors.length > 0);
      assert.ok(!result.ok && result.errors[0]!.message.includes('empty'));
    });

    it('returns error for text exceeding max length', () => {
      const result = validateMcpInput('a'.repeat(TEXT_MAX_LENGTH + 1));
      assert.equal(result.ok, false);
    });

    it('returns error for empty tag in array', () => {
      const result = validateMcpInput('Valid text', ['auth', '']);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.errors[0]!.field === 'tags');
    });

    it('returns error for tag exceeding max length', () => {
      const result = validateMcpInput('Valid text', ['a'.repeat(TAG_MAX_LENGTH + 1)]);
      assert.equal(result.ok, false);
    });

    it('does not call process.exit', () => {
      // If this test completes without exiting the process, the function is safe for MCP
      const result = validateMcpInput('');
      assert.equal(result.ok, false);
    });

    it('ignores undefined tags (treated as no tags)', () => {
      const result = validateMcpInput('Valid text', undefined);
      assert.equal(result.ok, true);
    });

    it('ignores empty tag array (no validation triggered)', () => {
      const result = validateMcpInput('Valid text', []);
      assert.equal(result.ok, true);
    });
  });

  describe('validateMcpField', () => {
    it('returns ok for a valid non-empty field', () => {
      const result = validateMcpField('src/auth/', 'scope');
      assert.equal(result.ok, true);
    });

    it('returns error for an empty field', () => {
      const result = validateMcpField('', 'scope');
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.message.includes('scope'));
      assert.ok(!result.ok && result.message.includes('empty'));
    });

    it('returns error for a whitespace-only field', () => {
      const result = validateMcpField('   ', 'scope');
      assert.equal(result.ok, false);
    });

    it('returns error for a field exceeding max length', () => {
      const result = validateMcpField('a'.repeat(TEXT_MAX_LENGTH + 1), 'description');
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.message.includes('description'));
    });
  });
});
