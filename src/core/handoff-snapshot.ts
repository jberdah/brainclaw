/**
 * Auto-handoff diff snapshot capping (pln#569, décision E).
 *
 * Session-end auto-handoffs carried the FULL uncommitted git diff in
 * `snapshot.diff` (~450 KB each), which made handoffs 53 MB of a 55 MB journal
 * (524 handoffs, trp_2ca4b87b) — yet:
 *   - no consumer ever reads more than a bounded prefix (the dispatch review
 *     brief slices 5 000 chars; `bclaw_find`/`bclaw_get` bound to
 *     DEFAULT_FIND_CHAR_BUDGET = 40 000), and
 *   - the canonical full diff lives on the worktree branch — the read path
 *     already tells the reader to "read the worktree branch for the full diff".
 *
 * So the inline diff is a CONVENIENCE PREVIEW, not the source of truth. This
 * caps it to a generous preview and records a digest of the full diff when
 * truncated, so nothing is silently lost (a reader knows the inline diff is a
 * prefix and by how much) without paying the ~450 KB per handoff.
 *
 * @module
 */
import crypto from 'node:crypto';
import type { Handoff } from './schema.js';

/**
 * Max chars of the inline diff preview kept on a handoff. Chosen ABOVE every
 * consumer's read budget except the rare large-budget `find`/`get` (40 000) —
 * the review brief (5 000) is served in full, and the worktree branch carries
 * the canonical diff for anything larger. ~30× smaller than a typical 450 KB
 * uncommitted diff.
 */
export const HANDOFF_DIFF_PREVIEW_CHARS = 16_384;

export type HandoffSnapshot = NonNullable<Handoff['snapshot']>;

/**
 * Build a handoff `snapshot` from a full diff: keep an inline preview, and when
 * the diff exceeds the preview cap, record a digest of the FULL diff
 * (`full_bytes` + `sha256` + `truncated`) so the truncation is explicit and a
 * re-fetched full diff is verifiable. Returns `undefined` for an absent/empty
 * diff (no snapshot at all).
 */
export function capHandoffDiff(fullDiff: string | undefined): HandoffSnapshot | undefined {
  if (!fullDiff) return undefined;
  if (fullDiff.length <= HANDOFF_DIFF_PREVIEW_CHARS) {
    return { diff: fullDiff };
  }
  // Buffer round-trip forces a FLAT independent copy: a bare `slice()` returns a
  // V8 SlicedString that pins the whole ~450 KB parent in memory, defeating the
  // cap (the parent never gets freed) — the same trap trimForProjection hit
  // (trp_2ca4b87b).
  const preview = Buffer.from(fullDiff.slice(0, HANDOFF_DIFF_PREVIEW_CHARS), 'utf8').toString('utf8');
  return {
    diff: preview,
    diff_digest: {
      full_bytes: Buffer.byteLength(fullDiff, 'utf8'),
      sha256: crypto.createHash('sha256').update(fullDiff, 'utf8').digest('hex'),
      truncated: true,
    },
  };
}
