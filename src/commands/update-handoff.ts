import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { nowISO } from '../core/ids.js';
import type { Handoff, HandoffStatus, ReviewVerdict } from '../core/schema.js';

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

  const hasReviewUpdate =
    options.reviewer !== undefined ||
    options.requester !== undefined ||
    options.requested_at !== undefined ||
    options.review_thread_id !== undefined ||
    options.review_message_id !== undefined ||
    options.review_verdict !== undefined ||
    options.reviewed_by !== undefined ||
    options.review_summary !== undefined ||
    options.blocking_issues !== undefined ||
    options.suggestions !== undefined;

  if (hasReviewUpdate) {
    const review = { ...(handoff.review ?? {}) };
    if (options.reviewer !== undefined) review.reviewer = options.reviewer;
    if (options.requester !== undefined) review.requester = options.requester;
    if (options.requested_at !== undefined) review.requested_at = options.requested_at;
    if (options.review_thread_id !== undefined) review.thread_id = options.review_thread_id;
    if (options.review_message_id !== undefined) review.message_id = options.review_message_id;
    if (options.review_verdict !== undefined) review.verdict = options.review_verdict;
    if (options.reviewed_by !== undefined) review.reviewed_by = options.reviewed_by;
    if (options.review_summary !== undefined) review.summary = options.review_summary;
    if (options.blocking_issues !== undefined) review.blocking_issues = options.blocking_issues;
    if (options.suggestions !== undefined) review.suggestions = options.suggestions;

    const reviewCompleted =
      options.review_verdict !== undefined ||
      options.reviewed_by !== undefined ||
      options.review_summary !== undefined ||
      options.blocking_issues !== undefined ||
      options.suggestions !== undefined;
    if (reviewCompleted) {
      review.reviewed_at = nowISO();
    }

    handoff.review = review;
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
