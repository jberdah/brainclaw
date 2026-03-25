import type { CandidateType, MemoryVisibility } from '../core/schema.js';
export interface RuntimeNoteOptions {
    agent?: string;
    agentId?: string;
    tag?: string[];
    project?: string;
    plan?: string;
    visibility?: MemoryVisibility;
    host?: string;
    ttl?: string;
    autoReflect?: boolean;
    cwd?: string;
    sessionId?: string;
    model?: string;
}
export interface RuntimeNoteCommandResult {
    noteId: string;
    agent: string;
    sessionId?: string;
    scopeInfo: string;
    expiresAt?: string;
    autoReflectAttempted: boolean;
    detectedType?: CandidateType;
    candidateId?: string;
    promotedItemId?: string;
    skipReason?: string;
    contradictionsDetected?: Array<{
        severity: 'low' | 'medium' | 'high';
        reason: string;
        conflicts_with: string;
    }>;
    contradictionSummary?: string;
    promotionBlockedReason?: string;
}
export declare function runRuntimeNote(text: string, options: RuntimeNoteOptions): RuntimeNoteCommandResult;
export declare function createRuntimeNote(text: string, options: RuntimeNoteOptions, printSuccess?: boolean): RuntimeNoteCommandResult;
//# sourceMappingURL=runtime-note.d.ts.map