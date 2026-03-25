import { type CandidateType } from '../core/schema.js';
import type { ContradictionReport } from '../core/contradictions.js';
export interface ReflectOptions {
    type?: CandidateType;
    tag?: string[];
    author?: string;
    authorId?: string;
    projectId?: string;
    hostId?: string;
    sessionId?: string;
    source?: string;
    severity?: string;
    from?: string;
    to?: string;
    path?: string;
    batch?: string;
    session?: string;
    cwd?: string;
}
export interface CandidateCreationResult {
    candidateId: string;
    type: CandidateType;
    writeThrough: boolean;
    promotedItemId?: string;
    contradictionsDetected?: ContradictionReport[];
    contradictionSummary?: string;
    promotionBlockedReason?: string;
}
export declare function runReflect(text: string | undefined, options: ReflectOptions): void;
export declare function createCandidateFromInput(text: string, type: CandidateType, options: ReflectOptions, printSuccess?: boolean, forceStrict?: boolean, automation?: boolean): CandidateCreationResult;
export declare function mapEventTypeToCandidateType(eventType: string): CandidateType;
//# sourceMappingURL=reflect.d.ts.map