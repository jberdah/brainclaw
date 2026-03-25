type DiffSection = 'constraint' | 'decision' | 'trap' | 'handoff' | 'candidate';
export interface ContextDiffItem {
    section: DiffSection;
    id: string;
    text: string;
    created_at: string;
}
export interface ContextDiffResult {
    since?: string;
    since_session?: string;
    summary: string;
    counts: {
        constraints: number;
        decisions: number;
        traps: number;
        handoffs: number;
        pending_candidates: number;
        total: number;
    };
    changed_items?: ContextDiffItem[];
}
export interface BuildContextDiffOptions {
    since?: string;
    session?: string;
    cwd?: string;
    includeItems?: boolean;
}
export declare function resolveContextDiffSince(options: Pick<BuildContextDiffOptions, 'since' | 'session' | 'cwd'>): {
    since?: string;
    since_session?: string;
};
export declare function buildContextDiff(options?: BuildContextDiffOptions): ContextDiffResult | undefined;
export declare function readLastContextTimestamp(cwd?: string): string | undefined;
export declare function buildContextDiffSummary(counts: ContextDiffResult['counts']): string;
export {};
//# sourceMappingURL=context-diff.d.ts.map