/**
 * pln#601 — brief() reading-list SOURCE reserve (Fable-audit brief-noise fix).
 *
 * On a symbol with many test importers, the reverse-dependent test files (blast
 * radius, +5 each) used to fill the whole §9 12-file cap and crowd out the source
 * files an agent needs to understand the symbol. `reserveSourceSlots` admits at
 * most ~1/4 of the cap as test files UNLESS non-test files can't fill it (then the
 * deferred tests backfill). Focused unit assertions on the exported helper — the
 * membership rule brief() applies just before the §9 cap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reserveSourceSlots, isTestPath, BRIEF_FILE_CAP } from '../../../src/core/code-map/query.js';

// Minimal RankedFile-shaped rows (only path/score matter to the reserve).
function rf(path: string, score: number) {
  return { path, file_id: 'f'.repeat(64), reason: 'r', score, bestDelta: score, graphDerived: false };
}

// Use the real classifier so the reserve test tracks isTestPath exactly.
const isTest = (p: string) => isTestPath(p);

describe('pln#601 reserveSourceSlots — brief source reserve', () => {
  it('caps test files at ~1/4 of the list when source would otherwise be crowded out', () => {
    // 15 source + 10 test importers compete for 12 slots — the crowding scenario:
    // test importers score higher (+5 blast radius) so they lead the ranking and,
    // uncapped, would fill the whole list. The reserve holds them to 3 so source keeps
    // the other 9 slots instead of being pushed out entirely.
    const ranked = [
      ...Array.from({ length: 10 }, (_, i) => rf(`tests/unit/use-${i}.test.ts`, 5)),
      ...Array.from({ length: 15 }, (_, i) => rf(`src/mod-${i}.ts`, 4)),
    ];
    const out = reserveSourceSlots(ranked, BRIEF_FILE_CAP, new Set());
    const tests = out.filter((r) => isTest(r.path));
    const source = out.filter((r) => !isTest(r.path));
    assert.equal(out.length, BRIEF_FILE_CAP, 'list is full');
    assert.equal(tests.length, 3, 'test files held to ~1/4 of the 12-cap');
    assert.equal(source.length, 9, 'source keeps the remaining slots instead of being crowded out');
  });

  it('backfills with tests when there are not enough source files to fill the cap', () => {
    // Only 1 source + 20 test importers → the list should still be full (12), using
    // tests to backfill the empty slots rather than returning a short list.
    const ranked = [
      rf('src/only.ts', 12),
      ...Array.from({ length: 20 }, (_, i) => rf(`tests/unit/use-${i}.test.ts`, 5)),
    ];
    const out = reserveSourceSlots(ranked, BRIEF_FILE_CAP, new Set());
    assert.equal(out.length, BRIEF_FILE_CAP, 'list backfilled to the full cap');
    assert.ok(out.some((r) => r.path === 'src/only.ts'), 'the source file is kept');
    assert.equal(out.filter((r) => isTest(r.path)).length, 11, 'tests backfill the remaining slots');
  });

  it('a symbol legitimately DEFINED in a test file is not treated as noise', () => {
    // The defining file leads the list even though it is a test path.
    const defining = 'tests/helpers/fixture-factory.test.ts';
    const ranked = [
      rf(defining, 12),
      ...Array.from({ length: 10 }, (_, i) => rf(`tests/unit/use-${i}.test.ts`, 5)),
      ...Array.from({ length: 15 }, (_, i) => rf(`src/a-${i}.ts`, 4)),
    ];
    const out = reserveSourceSlots(ranked, BRIEF_FILE_CAP, new Set([defining]));
    assert.equal(out[0]!.path, defining, 'defining file leads regardless of being a test path');
    // The defining test file does NOT count against the test reserve; source competes
    // for the remaining slots, so the other test importers are still held to ~1/4.
    const otherTests = out.filter((r) => isTest(r.path) && r.path !== defining);
    assert.equal(otherTests.length, 3, 'other test importers still reserved to ~1/4');
  });

  it('all-source lists are unchanged (no spurious dropping)', () => {
    const ranked = Array.from({ length: 8 }, (_, i) => rf(`src/mod-${i}.ts`, 5));
    const out = reserveSourceSlots(ranked, BRIEF_FILE_CAP, new Set());
    assert.equal(out.length, 8);
    assert.deepEqual(out.map((r) => r.path), ranked.map((r) => r.path));
  });
});
