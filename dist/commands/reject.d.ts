export interface RejectResult {
    candidate_id: string;
    actor: string;
}
export declare function runReject(id: string, reason?: string, by?: string, cwd?: string): void;
export declare function rejectCandidate(id: string, reason?: string, by?: string, cwd?: string, byId?: string): RejectResult;
//# sourceMappingURL=reject.d.ts.map