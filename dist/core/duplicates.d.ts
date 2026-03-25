import type { Candidate } from './schema.js';
import type { State } from './schema.js';
/**
 * Lightweight duplicate detection.
 * Compares a candidate's text against existing state entries and pending candidates.
 * Returns a list of similar items with a simple similarity reason.
 */
export interface DuplicateMatch {
    id: string;
    source: 'state' | 'candidate';
    text: string;
    reason: string;
}
export declare function detectDuplicates(candidateText: string, candidateType: string, state: State, pendingCandidates: Candidate[]): DuplicateMatch[];
//# sourceMappingURL=duplicates.d.ts.map