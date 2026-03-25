import { type ContradictionReport } from './contradictions.js';
import type { CandidateType } from './schema.js';
export interface ReflectionSafetyResult {
    contradictions_detected?: ContradictionReport[];
    contradiction_summary?: string;
    promotion_blocked_reason?: string;
}
export declare function evaluateReflectionSafety(input: {
    text: string;
    type: CandidateType;
    tags: string[];
    relatedPaths?: string[];
    projectId?: string;
    cwd?: string;
    automation?: boolean;
}): ReflectionSafetyResult;
//# sourceMappingURL=reflection-safety.d.ts.map