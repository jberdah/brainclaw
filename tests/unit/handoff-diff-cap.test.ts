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
import { executeMcpToolCall, handleMcpReadToolCall } from '../../src/commands/mcp.js';
import { capHandoffDiff, HANDOFF_DIFF_PREVIEW_CHARS } from '../../src/core/handoff-snapshot.js';
import { saveState } from '../../src/core/state.js';
import { HandoffSchema } from '../../src/core/schema.js';
import { createTestWorkspace } from '../helpers/workspace.js';

describe('capHandoffDiff (pln#569)', () => {
  it('returns undefined for an absent/empty diff', () => {
    assert.equal(capHandoffDiff(undefined), undefined);
    assert.equal(capHandoffDiff(''), undefined);
  });

  it('keeps a small diff inline with no digest (not truncated)', () => {
    const diff = 'diff --git a/x b/x\n+small change\n';
    const snap = capHandoffDiff(diff);
    assert.deepEqual(snap, { diff });
    assert.equal('diff_digest' in (snap ?? {}), false, 'a complete inline diff carries no digest');
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

  it('does not split surrogate pairs when flattening the preview', () => {
    const full = `${'a'.repeat(HANDOFF_DIFF_PREVIEW_CHARS - 1)}😀tail`;
    const snap = capHandoffDiff(full);
    assert.equal(snap!.diff, full.slice(0, HANDOFF_DIFF_PREVIEW_CHARS - 1));
    assert.equal(snap!.diff?.includes('\uFFFD'), false);
    assert.equal(snap!.diff_digest?.sha256, crypto.createHash('sha256').update(full, 'utf8').digest('hex'));
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

  it('marks capped snapshots as previews on both handoff read surfaces', async () => {
    const workspace = createTestWorkspace({ prefix: 'bclaw-handoff-diff-cap-' });
    try {
      const snap = capHandoffDiff('q'.repeat(HANDOFF_DIFF_PREVIEW_CHARS + 100));
      saveState({
        version: 1,
        write_version: 1,
        active_constraints: [],
        recent_decisions: [],
        known_traps: [],
        plan_items: [],
        open_handoffs: [{
          id: 'hnd_preview',
          from: 'worker',
          to: 'reviewer',
          text: 'review capped diff',
          created_at: '2026-06-14T00:00:00.000Z',
          author: 'worker',
          status: 'open',
          tags: ['auto-handoff'],
          snapshot: snap,
        }],
      }, workspace.dir);

      const read = handleMcpReadToolCall('bclaw_read_handoff', { id: 'hnd_preview' }, { cwd: workspace.dir });
      assert.match(read.content[0].text, /preview — full diff is \d+ bytes on the worktree branch/);

      const get = await executeMcpToolCall({
        name: 'bclaw_get',
        args: { entity: 'handoff', id: 'hnd_preview' },
        cwd: workspace.dir,
      });
      const result = get.response.structuredContent as { item?: { snapshot?: { diff?: string; diff_digest?: { truncated?: boolean } } } };
      assert.equal(result.item?.snapshot?.diff_digest?.truncated, true);
      assert.match(result.item?.snapshot?.diff ?? '', /preview — full diff is \d+ bytes on the worktree branch/);
    } finally {
      workspace.cleanup();
    }
  });
});
