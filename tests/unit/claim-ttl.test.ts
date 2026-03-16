import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isClaimExpired, expireStaleActiveClaims, listClaims, saveClaim } from '../../src/core/claims.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { Claim } from '../../src/core/schema.js';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: `clm_${Math.random().toString(36).slice(2, 10)}`,
    agent: 'test-agent',
    scope: 'src/test.ts',
    description: 'test claim',
    created_at: new Date().toISOString(),
    status: 'active',
    ...overrides,
  };
}

describe('claim TTL', () => {
  let workspace: TestWorkspace;
  let restoreCwd: () => void;

  before(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-claim-ttl-', currentAgent: 'test-agent' });
    restoreCwd = workspace.useCwd();
  });

  after(() => {
    restoreCwd();
    workspace.cleanup();
  });

  describe('isClaimExpired', () => {
    it('returns false when no expires_at', () => {
      assert.equal(isClaimExpired(makeClaim()), false);
    });

    it('returns false when expires_at is in the future', () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      assert.equal(isClaimExpired(makeClaim({ expires_at: future })), false);
    });

    it('returns true when expires_at is in the past', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      assert.equal(isClaimExpired(makeClaim({ expires_at: past })), true);
    });
  });

  describe('expireStaleActiveClaims', () => {
    it('releases expired active claims', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const expiredClaim = makeClaim({ id: 'clm_expired01', expires_at: past });
      saveClaim(expiredClaim, workspace.dir);

      const count = expireStaleActiveClaims(workspace.dir);
      assert.ok(count >= 1, 'should expire at least 1 claim');

      const updated = listClaims(workspace.dir).find((c) => c.id === 'clm_expired01');
      assert.ok(updated, 'claim should still exist');
      assert.equal(updated!.status, 'released');
      assert.ok(updated!.released_at, 'released_at should be set');
    });

    it('does not affect claims without expires_at', () => {
      const neverExpires = makeClaim({ id: 'clm_noexpiry1' });
      saveClaim(neverExpires, workspace.dir);

      expireStaleActiveClaims(workspace.dir);

      const updated = listClaims(workspace.dir).find((c) => c.id === 'clm_noexpiry1');
      assert.equal(updated!.status, 'active');
    });

    it('does not affect claims with future expires_at', () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const futureClaim = makeClaim({ id: 'clm_future001', expires_at: future });
      saveClaim(futureClaim, workspace.dir);

      expireStaleActiveClaims(workspace.dir);

      const updated = listClaims(workspace.dir).find((c) => c.id === 'clm_future001');
      assert.equal(updated!.status, 'active');
    });

    it('returns 0 when no expired claims exist', () => {
      const fresh = createTestWorkspace({ prefix: 'bclaw-claim-empty-', currentAgent: 'test-agent' });
      try {
        const count = expireStaleActiveClaims(fresh.dir);
        assert.equal(count, 0);
      } finally {
        fresh.cleanup();
      }
    });
  });

  describe('claim stores expires_at', () => {
    it('stores expires_at when created with ttl', () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const claim = makeClaim({ id: 'clm_withttl01', expires_at: future });
      saveClaim(claim, workspace.dir);

      const loaded = listClaims(workspace.dir).find((c) => c.id === 'clm_withttl01');
      assert.ok(loaded, 'claim should exist');
      assert.equal(loaded!.expires_at, future);
    });
  });
});
