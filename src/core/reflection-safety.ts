import { loadState } from './state.js';
import { detectNewItemContradictions, hasBlockingContradictions, summarizeContradictions, type ContradictionReport } from './contradictions.js';
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

  const contradictionSummary = summarizeContradictions(contradictions);
  const promotionBlockedReason = input.automation && hasBlockingContradictions(contradictions)
    ? 'contradiction_detected'
    : undefined;

  return {
    contradictions_detected: contradictions,
    contradiction_summary: contradictionSummary,
    promotion_blocked_reason: promotionBlockedReason,
  };
}
