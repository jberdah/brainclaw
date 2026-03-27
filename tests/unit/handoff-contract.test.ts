import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HandoffSchema, HandoffContractSchema } from '../../src/core/schema.js';
import { extractFilesFromDiff } from '../../src/commands/handoff.js';

describe('HandoffContractSchema', () => {
  it('parses a complete contract', () => {
    const result = HandoffContractSchema.parse({
      files_touched: ['src/core/lock.ts', 'src/core/io.ts'],
      pre_conditions: ['Tests pass on main branch'],
      post_conditions: ['Coverage above 60%'],
      tests_to_verify: ['tests/unit/lock.test.ts'],
      linked_plans: ['pln_abc123'],
    });
    assert.deepEqual(result.files_touched, ['src/core/lock.ts', 'src/core/io.ts']);
    assert.deepEqual(result.pre_conditions, ['Tests pass on main branch']);
    assert.deepEqual(result.post_conditions, ['Coverage above 60%']);
    assert.deepEqual(result.tests_to_verify, ['tests/unit/lock.test.ts']);
    assert.deepEqual(result.linked_plans, ['pln_abc123']);
  });

  it('parses an empty contract (all optional)', () => {
    const result = HandoffContractSchema.parse({});
    assert.equal(result.files_touched, undefined);
    assert.equal(result.pre_conditions, undefined);
  });

  it('allows partial contracts', () => {
    const result = HandoffContractSchema.parse({
      files_touched: ['README.md'],
    });
    assert.deepEqual(result.files_touched, ['README.md']);
    assert.equal(result.post_conditions, undefined);
  });
});

describe('HandoffSchema with contract', () => {
  const baseHandoff = {
    id: 'hnd_test1',
    from: 'claude-code',
    to: 'copilot',
    text: 'Finish the auth refactor',
    created_at: '2026-03-27T10:00:00.000Z',
    author: 'claude-code',
    status: 'open' as const,
    tags: ['auth'],
  };

  it('parses handoff without contract (backward compatible)', () => {
    const result = HandoffSchema.parse(baseHandoff);
    assert.equal(result.contract, undefined);
  });

  it('parses handoff with contract', () => {
    const result = HandoffSchema.parse({
      ...baseHandoff,
      contract: {
        files_touched: ['src/auth.ts'],
        pre_conditions: ['branch feat/auth exists'],
        post_conditions: ['all tests pass'],
        tests_to_verify: ['tests/auth.test.ts'],
        linked_plans: ['pln_123'],
      },
    });
    assert.ok(result.contract);
    assert.deepEqual(result.contract.files_touched, ['src/auth.ts']);
    assert.deepEqual(result.contract.linked_plans, ['pln_123']);
  });

  it('parses handoff with empty contract', () => {
    const result = HandoffSchema.parse({
      ...baseHandoff,
      contract: {},
    });
    assert.ok(result.contract);
    assert.equal(result.contract.files_touched, undefined);
  });
});

describe('extractFilesFromDiff', () => {
  it('extracts files from git diff output', () => {
    const diff = [
      'diff --git a/src/core/lock.ts b/src/core/lock.ts',
      'index abc1234..def5678 100644',
      '--- a/src/core/lock.ts',
      '+++ b/src/core/lock.ts',
      '@@ -1,5 +1,6 @@',
      ' import fs from "node:fs";',
      '+import path from "node:path";',
      'diff --git a/src/core/io.ts b/src/core/io.ts',
      '--- a/src/core/io.ts',
      '+++ b/src/core/io.ts',
      '@@ -10,3 +10,4 @@',
      '+export const NEW_CONST = true;',
    ].join('\n');

    const files = extractFilesFromDiff(diff);
    assert.deepEqual(files, ['src/core/io.ts', 'src/core/lock.ts']);
  });

  it('handles new file additions', () => {
    const diff = [
      'diff --git a/src/new-file.ts b/src/new-file.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new-file.ts',
      '@@ -0,0 +1,3 @@',
      '+console.log("hello");',
    ].join('\n');

    const files = extractFilesFromDiff(diff);
    assert.deepEqual(files, ['src/new-file.ts']);
  });

  it('handles file deletions', () => {
    const diff = [
      'diff --git a/old-file.ts b/old-file.ts',
      'deleted file mode 100644',
      '--- a/old-file.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-console.log("gone");',
    ].join('\n');

    const files = extractFilesFromDiff(diff);
    assert.deepEqual(files, ['old-file.ts']);
  });

  it('deduplicates files', () => {
    const diff = [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
    ].join('\n');

    const files = extractFilesFromDiff(diff);
    assert.deepEqual(files, ['src/file.ts']);
  });

  it('returns empty array for empty diff', () => {
    assert.deepEqual(extractFilesFromDiff(''), []);
  });

  it('returns sorted files', () => {
    const diff = [
      'diff --git a/z-file.ts b/z-file.ts',
      '+++ b/z-file.ts',
      'diff --git a/a-file.ts b/a-file.ts',
      '+++ b/a-file.ts',
      'diff --git a/m-file.ts b/m-file.ts',
      '+++ b/m-file.ts',
    ].join('\n');

    const files = extractFilesFromDiff(diff);
    assert.deepEqual(files, ['a-file.ts', 'm-file.ts', 'z-file.ts']);
  });
});
