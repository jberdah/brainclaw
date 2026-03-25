export interface ContextDiffOptions {
    since?: string;
    session?: string;
    json?: boolean;
    cwd?: string;
}
/**
 * Hybrid context-diff: always includes critical anchors (active claims,
 * top traps, instructions) so the agent stays grounded, plus the memory
 * delta since last context read.
 */
export declare function runContextDiff(options?: ContextDiffOptions): void;
//# sourceMappingURL=context-diff.d.ts.map