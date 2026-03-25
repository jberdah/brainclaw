import { type Candidate } from './schema.js';
export declare function ensureInboxDirs(cwd?: string): void;
export declare function saveCandidate(candidate: Candidate, cwd?: string): void;
export declare function loadCandidate(id: string, cwd?: string): Candidate;
export declare function updateCandidate(candidate: Candidate, cwd?: string): void;
export declare function listCandidates(status?: 'pending' | 'accepted' | 'rejected', cwd?: string): Candidate[];
export declare function archiveCandidate(candidate: Candidate, dest: 'accepted' | 'rejected', cwd?: string): void;
export declare function listArchivedCandidates(dest: 'accepted' | 'rejected', cwd?: string): Candidate[];
export declare function deleteArchivedCandidate(id: string, dest: 'accepted' | 'rejected', cwd?: string): boolean;
export declare function addCandidateStar(id: string, by: string, cwd?: string): {
    candidate: Candidate;
    added: boolean;
};
export declare function addCandidateUse(id: string, by: string, context: string, cwd?: string): {
    candidate: Candidate;
    added: boolean;
};
export declare function generateCandidateId(): string;
/** Generate both a hash candidate ID and a short label (e.g. `cnd#47`). */
export declare function generateCandidateIdWithLabel(cwd?: string): {
    id: string;
    short_label: string;
};
/**
 * Resolve a candidate alias (`cnd#47`) or hash ID to the canonical hash ID.
 * Searches pending inbox only — use `resolveArchivedIdOrAlias` for historical items.
 */
export declare function resolveIdOrAlias(input: string, cwd?: string): string;
//# sourceMappingURL=candidates.d.ts.map