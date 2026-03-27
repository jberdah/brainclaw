import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isClaimExpired } from '../../src/core/claims.js';
import type { Claim } from '../../src/core/schema.js';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'clm_test001',
    agent: 'test-agent',
    scope: 'test/scope',
    description: 'Test claim',
    created_at: new Date().toISOString(),
    status: 'active',
    ...overrides,
  };
}

describe('isClaimExpired', () => {
  it('returns false when no expires_at is set', () => {
    const claim = makeClaim();
    assert.equal(isClaimExpired(claim), false);
  });

  it('returns false when expires_at is in the future', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const claim = makeClaim({ expires_at: future });
    assert.equal(isClaimExpired(claim), false);
  });

  it('returns true when expires_at is in the past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const claim = makeClaim({ expires_at: past });
    assert.equal(isClaimExpired(claim), true);
  });

  it('returns true for a released claim if expires_at is past (callers filter by status)', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const claim = makeClaim({ expires_at: past, status: 'released' });
    assert.equal(isClaimExpired(claim), true);
  });
});

describe('parseTtl format (claim TTL regex)', () => {
  function parseTtl(ttl: string): string | null {
    const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
    if (!match) return null;
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const ms = unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3_600_000 : value * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
  }

  it('converts 30m to a date ~30 minutes from now', () => {
    const before = Date.now();
    const result = parseTtl('30m');
    assert.ok(result !== null);
    const parsed = Date.parse(result!);
    assert.ok(parsed >= before + 29 * 60_000, 'should be at least 29m from now');
    assert.ok(parsed <= Date.now() + 31 * 60_000, 'should be at most 31m from now');
  });

  it('converts 2h to a date ~2 hours from now', () => {
    const before = Date.now();
    const result = parseTtl('2h');
    assert.ok(result !== null);
    const parsed = Date.parse(result!);
    assert.ok(parsed >= before + 2 * 3_600_000 - 1000);
    assert.ok(parsed <= Date.now() + 2 * 3_600_000 + 1000);
  });

  it('converts 1d to a date ~1 day from now', () => {
    const before = Date.now();
    const result = parseTtl('1d');
    assert.ok(result !== null);
    const parsed = Date.parse(result!);
    assert.ok(parsed >= before + 86_400_000 - 1000);
    assert.ok(parsed <= Date.now() + 86_400_000 + 1000);
  });

  it('returns null for invalid TTL format', () => {
    assert.equal(parseTtl('invalid'), null);
    assert.equal(parseTtl('2x'), null);
    assert.equal(parseTtl(''), null);
    assert.equal(parseTtl('2hours'), null);
    assert.equal(parseTtl('1.5h'), null);
  });

  it('accepts all three unit variants', () => {
    assert.ok(parseTtl('1m') !== null);
    assert.ok(parseTtl('1h') !== null);
    assert.ok(parseTtl('1d') !== null);
  });
});
