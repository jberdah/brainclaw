import { loadState } from './state.js';
import { detectNewItemContradictions, hasBlockingContradictions, summarizeContradictions } from './contradictions.js';
export function evaluateReflectionSafety(input) {
    if (input.type === 'handoff') {
        return {};
    }
    const contradictions = detectNewItemContradictions(input.text, input.tags, input.relatedPaths, loadState(input.cwd), input.projectId);
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
//# sourceMappingURL=reflection-safety.js.map