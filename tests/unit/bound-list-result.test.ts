import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boundListResult, type ListResult } from '../../src/core/entity-operations.js';

// pln#491 — bclaw_find payload bounding: cap SIZE (count is already capped by
// applyPaging) so a verbose result set never overflows the MCP token cap and
// pushes the agent to the CLI (trp#449). Advertise has_more / next_offset / hint.

function result(total: number, count: number, textLen = 10): ListResult {
  return {
    entity: 'trap',
    total,
    items: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, text: 'x'.repeat(textLen) })),
  };
}

describe('boundListResult (pln#491)', () => {
  it('is a no-op when the full result fits and nothing remains', () => {
    const out = boundListResult(result(3, 3), 0);
    assert.equal(out.returned, 3);
    assert.equal(out.has_more, false);
    assert.equal(out.next_offset, undefined);
    assert.equal(out.omitted_for_size, undefined);
    assert.equal(out.hint, undefined);
    assert.equal(out.items.length, 3);
  });

  it('signals has_more + next_offset when total exceeds the returned page', () => {
    // 50 small items returned out of 70 total at offset 0.
    const out = boundListResult(result(70, 50), 0);
    assert.equal(out.returned, 50);
    assert.equal(out.has_more, true);
    assert.equal(out.next_offset, 50);
    assert.match(out.hint ?? '', /offset=50/);
  });

  it('computes next_offset from a non-zero offset', () => {
    const out = boundListResult(result(70, 20), 50);
    assert.equal(out.has_more, false); // 50 + 20 = 70 = total
    const out2 = boundListResult(result(100, 20), 50);
    assert.equal(out2.has_more, true);
    assert.equal(out2.next_offset, 70);
  });

  it('shrinks the page to fit the char budget and reports omitted_for_size', () => {
    // 50 items × ~2000 chars ≈ 100k chars, budget 20k → must shrink.
    const out = boundListResult(result(50, 50, 2000), 0, 20000);
    assert.ok(out.returned < 50, `expected shrink, returned=${out.returned}`);
    assert.ok((out.omitted_for_size ?? 0) > 0);
    assert.equal(out.has_more, true);
    assert.equal(out.next_offset, out.returned);
    assert.ok(JSON.stringify(out.items).length <= 20000);
    assert.match(out.hint ?? '', /size-bounded/);
  });

  it('projects one oversized item to identity fields instead of exceeding the budget', () => {
    const out = boundListResult(result(1, 1, 50000), 0, 20000);
    assert.equal(out.returned, 1);
    assert.equal(out.has_more, false);
    assert.equal(out.omitted_for_size, undefined);
    assert.equal(out.oversized_item_projected, true);
    assert.deepEqual(out.items, [{ id: 't0' }]);
    assert.match(out.hint ?? '', /bclaw_get/);
  });
});
