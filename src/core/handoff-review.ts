import { nowISO } from './ids.js';
import type { HandoffReview } from './schema.js';

/**
 * The review sub-fields whose presence in a patch marks the review as
 * "completed" and (re)stamps `reviewed_at`. Single source of truth for the
 * completion rule — shared by the canonical grammar (`updateEntity(handoff)`)
 * and the dispatcher/CLI path (`applyHandoffUpdates`) so the two write paths
 * can never drift (pln#625 Phase 3, Codex review of #84).
 */
export const REVIEW_COMPLETION_FIELDS = [
  'verdict',
  'reviewed_by',
  'summary',
  'blocking_issues',
  'suggestions',
] as const satisfies readonly (keyof HandoffReview)[];

/**
 * Merge a partial review patch onto an existing review (shallow — PATCH
 * semantics: provided fields overwrite, others survive) and stamp
 * `reviewed_at` when the patch introduces a completion field.
 *
 * A caller that explicitly provides `reviewed_at` (e.g. a federation import
 * replaying a prior review) keeps its value; otherwise a completing patch
 * stamps `nowISO()`. The flat-option callers (applyHandoffUpdates) never carry
 * `reviewed_at`, so for them this is an unconditional restamp-on-completion —
 * identical to the pre-extraction behaviour.
 */
export function mergeHandoffReview(
  existing: HandoffReview | undefined,
  patch: Partial<HandoffReview>,
): HandoffReview {
  const merged: HandoffReview = { ...(existing ?? {}), ...patch };
  const completed = REVIEW_COMPLETION_FIELDS.some((field) => patch[field] !== undefined);
  if (completed && patch.reviewed_at === undefined) {
    merged.reviewed_at = nowISO();
  }
  return merged;
}
