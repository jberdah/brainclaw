import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import {
  claimContentHash,
  maybeEnqueueClaimTransition,
  listOutboxRecords,
  reconcileOutbox,
  archiveToSent,
  clearFederationEnablementCache,
} from '../../src/core/federation-outbox.js';
import type { Claim } from '../../src/core/schema.js';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'clm_test1',
    agent: 'claude-poste',
    agent_id: 'agt_x',
    scope: 'src/a.ts',
    description: 'work',
    created_at: '2026-07-09T10:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function enableCloud(ws: TestWorkspace): void {
  ws.updateConfig((c) => {
    c.cloud_sync = { enabled: true, endpoint: 'https://example.invalid', api_key: 'k' };
  });
  clearFederationEnablementCache();
}

describe('federation-outbox / claimContentHash', () => {
  it('is deterministic and sensitive to semantic fields', () => {
    const h = claimContentHash(makeClaim());
    assert.equal(claimContentHash(makeClaim()), h);
    assert.notEqual(claimContentHash(makeClaim({ description: 'other' })), h);
    assert.notEqual(claimContentHash(makeClaim({ status: 'released' })), h);
    assert.notEqual(claimContentHash(makeClaim({ scope: 'src/b.ts' })), h);
  });

  it('ignores volatile / local-only fields (user, model)', () => {
    const h = claimContentHash(makeClaim());
    assert.equal(claimContentHash(makeClaim({ user: 'bob', model: 'opus' })), h);
  });
});

describe('federation-outbox / enqueue + rev', () => {
  let ws: TestWorkspace;
  beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-outbox-' }); enableCloud(ws); });
  afterEach(() => { ws.cleanup(); clearFederationEnablementCache(); });

  it('assigns a monotonic rev across create → terminal → distinct-terminal', () => {
    assert.equal(maybeEnqueueClaimTransition(makeClaim({ status: 'active' }), undefined, true, ws.dir), 1);
    assert.equal(maybeEnqueueClaimTransition(makeClaim({ status: 'released' }), 'active', false, ws.dir), 2);
    assert.equal(maybeEnqueueClaimTransition(makeClaim({ status: 'stale' }), 'released', false, ws.dir), 3);
    const recs = listOutboxRecords(ws.dir);
    assert.deepEqual(recs.map((r) => r.record.rev), [1, 2, 3]);
    assert.deepEqual(recs.map((r) => r.record.to_status), ['active', 'released', 'stale']);
    // The signed payload carries id + rev + content_hash.
    assert.equal(recs[0].record.payload.rev, 1);
    assert.ok(recs[0].record.payload.content_hash.length === 64);
  });

  it('does NOT enqueue a no-op save (status unchanged)', () => {
    assert.equal(maybeEnqueueClaimTransition(makeClaim({ status: 'active' }), 'active', false, ws.dir), null);
    assert.equal(listOutboxRecords(ws.dir).length, 0);
  });

  it('does NOT enqueue when suppressed (cloud-origin materialization) — echo-safe', () => {
    assert.equal(maybeEnqueueClaimTransition(makeClaim(), undefined, true, ws.dir, true), null);
    assert.equal(listOutboxRecords(ws.dir).length, 0);
  });
});

describe('federation-outbox / disabled', () => {
  it('does NOT enqueue when cloud sync is not enabled', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-outbox-off-' });
    clearFederationEnablementCache();
    try {
      assert.equal(maybeEnqueueClaimTransition(makeClaim(), undefined, true, ws.dir), null);
      assert.equal(listOutboxRecords(ws.dir).length, 0);
    } finally {
      ws.cleanup();
      clearFederationEnablementCache();
    }
  });
});

describe('federation-outbox / reconcile', () => {
  let ws: TestWorkspace;
  beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-recon-' }); enableCloud(ws); });
  afterEach(() => { ws.cleanup(); clearFederationEnablementCache(); });

  it('drops an outbox record already superseded by a higher sent rev', () => {
    maybeEnqueueClaimTransition(makeClaim({ status: 'active' }), undefined, true, ws.dir); // rev1
    maybeEnqueueClaimTransition(makeClaim({ status: 'released' }), 'active', false, ws.dir); // rev2
    const recs = listOutboxRecords(ws.dir);
    const rev2 = recs.find((r) => r.record.rev === 2)!;
    archiveToSent(rev2, { http_status: 200 }, ws.dir); // sent marker = rev2, outbox still has rev1

    const result = reconcileOutbox(ws.dir);
    assert.equal(result.dropped, 1); // rev1 < sent marker 2 → dropped
    assert.equal(listOutboxRecords(ws.dir).length, 0);
  });
});
