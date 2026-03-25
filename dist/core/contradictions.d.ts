import type { CandidateContradiction, State } from './schema.js';
export interface ContradictionReport extends CandidateContradiction {
}
export declare function detectContradictions(state: State): ContradictionReport[];
export declare function detectNewItemContradictions(newText: string, newTags: string[], newPaths: string[] | undefined, state: State, newProjectId?: string): ContradictionReport[];
export declare function summarizeContradictions(reports: ContradictionReport[], maxItems?: number): string | undefined;
export declare function hasBlockingContradictions(reports: ContradictionReport[]): boolean;
//# sourceMappingURL=contradictions.d.ts.map