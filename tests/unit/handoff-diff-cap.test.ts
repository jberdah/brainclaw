/**
 * pln#569 (décision E) — auto-handoff diff cap + digest.
 *
 * The full uncommitted diff bloated auto-handoffs to 53 MB of the journal;
 * capHandoffDiff keeps a bounded preview + a digest of the full diff so nothing
 * is silently lost and no consumer (review brief 5K, find/get ≤40K) regresses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { capHandoffDiff, HANDOFF_DIFF_PREVIEW_CHARS } from '../../src/core/handoff-snapshot.js';
import { HandoffSchema } from '../../src/core/schema.js';

describe('capHandoffDiff (pln#569)', () => {
  it('returns undefined for an absent/empty diff', () => {
    assert.equal(capHandoffDiff(undefined), undefined);
    assert.equal(capHandoffDiff(''), undefined);
  });

  it('keeps a small diff inline with no digest (not truncated)', () => {
    const diff = 'diff --git a/x b/x\n+small change\n';
    const snap = capHandoffDiff(diff);
    assert.deepEqual(snap, { diff });
    assert.equal(snap?.diff_digest, undefined, 'a complete inline diff carries no digest');
  });

  it('caps a large diff to the preview and records a verifiable digest', () => {
    const full = 'x'.repeat(HANDOFF_DIFF_PREVIEW_CHARS * 4); // ~64K, well over the cap
    const snap = capHandoffDiff(full);
    assert.ok(snap, 'snapshot produced');
    assert.equal(snap!.diff!.length, HANDOFF_DIFF_PREVIEW_CHARS, 'inline diff is capped to the preview size');
    assert.equal(snap!.diff, full.slice(0, HANDOFF_DIFF_PREVIEW_CHARS), 'preview is the diff prefix');
    assert.ok(snap!.diff_digest, 'digest present when truncated');
    assert.equal(snap!.diff_digest!.truncated, true);
    assert.equal(snap!.diff_digest!.full_bytes, Buffer.byteLength(full, 'utf8'));
    assert.equal(snap!.diff_digest!.sha256, crypto.createHash('sha256').update(full, 'utf8').digest('hex'), 'digest hashes the FULL diff');
  });

  it('a diff exactly at the cap is kept whole (boundary)', () => {
    const full = 'y'.repeat(HANDOFF_DIFF_PREVIEW_CHARS);
    const snap = capHandoffDiff(full);
    assert.equal(snap!.diff, full);
    assert.equal(snap!.diff_digest, undefined);
  });

  it('produces a snapshot the HandoffSchema accepts (digest round-trips)', () => {
    const snap = capHandoffDiff('z'.repeat(HANDOFF_DIFF_PREVIEW_CHARS + 100));
    const handoff = HandoffSchema.parse({
      id: 'hnd_1', from: 'a', to: 'reviewer', text: 't', created_at: '2026-06-14T00:00:00.000Z',
      author: 'a', status: 'open', tags: ['auto-handoff'], snapshot: snap,
    });
    assert.equal(handoff.snapshot?.diff_digest?.truncated, true);
    assert.equal(handoff.snapshot?.diff?.length, HANDOFF_DIFF_PREVIEW_CHARS);
  });
});
