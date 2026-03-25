export interface AcceptResult {
    candidate_id: string;
    candidate_type: 'constraint' | 'decision' | 'trap' | 'handoff';
    promoted_item_id: string;
    actor: string;
}
export declare function runAccept(id: string, by?: string, cwd?: string): void;
export declare function acceptCandidate(id: string, by?: string, cwd?: string, byId?: string): AcceptResult;
//# sourceMappingURL=accept.d.ts.map