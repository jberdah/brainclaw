import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { mergeHandoffReview } from '../core/handoff-review.js';
import type { Handoff, HandoffReview, HandoffStatus, ReviewVerdict } from '../core/schema.js';

export interface UpdateHandoffOptions {
  status?: HandoffStatus;
  to?: string;
  narrative?: string;
  files_touched?: string[];
  pre_conditions?: string[];
  post_conditions?: string[];
  tests_to_verify?: string[];
  linked_plans?: string[];
  reviewer?: string;
  requester?: string;
  requested_at?: string;
  review_thread_id?: string;
  review_message_id?: string;
  review_verdict?: ReviewVerdict;
  reviewed_by?: string;
  review_summary?: string;
  blocking_issues?: string[];
  suggestions?: string[];
}

export function applyHandoffUpdates(handoff: Handoff, options: UpdateHandoffOptions = {}): Handoff {
  if (options.status) handoff.status = options.status;
  if (options.to !== undefined) handoff.to = options.to;
  if (options.narrative !== undefined) handoff.narrative = options.narrative;

  const contractUpdates: Record<string, string[]> = {};
  for (const key of ['files_touched', 'pre_conditions', 'post_conditions', 'tests_to_verify', 'linked_plans'] as const) {
    const value = options[key];
    if (Array.isArray(value)) {
      contractUpdates[key] = value;
    }
  }
  if (Object.keys(contractUpdates).length > 0) {
    handoff.contract = { ...handoff.contract, ...contractUpdates };
  }

  // Translate the flat options into a nested review patch and delegate the
  // merge + reviewed_at stamping to the shared core helper — the SINGLE source
  // of truth shared with updateEntity(handoff) so the two write paths cannot
  // drift (pln#625 Phase 3, Codex review of #84).
  const reviewPatch: Partial<HandoffReview> = {};
  if (options.reviewer !== undefined) reviewPatch.reviewer = options.reviewer;
  if (options.requester !== undefined) reviewPatch.requester = options.requester;
  if (options.requested_at !== undefined) reviewPatch.requested_at = options.requested_at;
  if (options.review_thread_id !== undefined) reviewPatch.thread_id = options.review_thread_id;
  if (options.review_message_id !== undefined) reviewPatch.message_id = options.review_message_id;
  if (options.review_verdict !== undefined) reviewPatch.verdict = options.review_verdict;
  if (options.reviewed_by !== undefined) reviewPatch.reviewed_by = options.reviewed_by;
  if (options.review_summary !== undefined) reviewPatch.summary = options.review_summary;
  if (options.blocking_issues !== undefined) reviewPatch.blocking_issues = options.blocking_issues;
  if (options.suggestions !== undefined) reviewPatch.suggestions = options.suggestions;
  if (Object.keys(reviewPatch).length > 0) {
    handoff.review = mergeHandoffReview(handoff.review, reviewPatch);
  }

  return handoff;
}

export function runUpdateHandoff(id: string, options: UpdateHandoffOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState();
  const handoff = state.open_handoffs.find((item) => item.id === id);
  if (!handoff) {
    console.error(`Error: Handoff '${id}' not found.`);
    process.exit(1);
  }

  applyHandoffUpdates(handoff, options);

  persistState(state);

  console.log(`✔ Handoff updated: [${handoff.id}] ${handoff.from} → ${handoff.to} (${handoff.status})`);
}
