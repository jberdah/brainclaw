import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateId, nowISO } from '../../src/core/ids.js';

describe('core/ids', () => {
  it('generates prefixed IDs for known sections', () => {
    assert.match(generateId('active_constraints'), /^cst_[a-f0-9]{8}$/);
    assert.match(generateId('recent_decisions'), /^dec_[a-f0-9]{8}$/);
    assert.match(generateId('known_traps'), /^trp_[a-f0-9]{8}$/);
  });

  it('falls back to the first 3 chars for unknown sections', () => {
    assert.match(generateId('custom_section'), /^cus_[a-f0-9]{8}$/);
  });

  it('returns an ISO timestamp', () => {
    const value = nowISO();
    assert.ok(!Number.isNaN(Date.parse(value)));
    assert.ok(value.endsWith('Z'));
  });
});
