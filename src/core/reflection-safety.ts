import { loadState } from './state.js';
import { detectNewItemContradictions, summarizeContradictions, type ContradictionReport } from './contradictions.js';
import type { CandidateType } from './schema.js';

export interface ReflectionSafetyResult {
  contradictions_detected?: ContradictionReport[];
  contradiction_summary?: string;
  promotion_blocked_reason?: string;
}

export function evaluateReflectionSafety(input: {
  text: string;
  type: CandidateType;
  tags: string[];
  relatedPaths?: string[];
  projectId?: string;
  cwd?: string;
  automation?: boolean;
}): ReflectionSafetyResult {
  if (input.type === 'handoff') {
    return {};
  }

  const contradictions = detectNewItemContradictions(
    input.text,
    input.tags,
    input.relatedPaths,
    loadState(input.cwd),
    input.projectId,
  );
  if (contradictions.length === 0) {
    return {};
  }

  // Advisory only (pln#542, cnd_abe61d68 incident: 18 keyword false positives
  // on a review summary blocked promotion). Contradictions ride along as
  // metadata on the candidate for the human/curator to weigh — they never
  // set promotion_blocked_reason anymore.
  return {
    contradictions_detected: contradictions,
    contradiction_summary: summarizeContradictions(contradictions),
  };
}
