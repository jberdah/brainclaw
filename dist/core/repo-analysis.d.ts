import type { ProjectMode } from './schema.js';
export interface RepoAnalysisResult {
    recommendedMode: ProjectMode;
    reasons: string[];
}
export declare function analyzeRepository(cwd: string): RepoAnalysisResult;
export interface WorkspaceScanResult {
    /** Directories that look like service roots and don't have .brainclaw/ yet. */
    suggestions: Array<{
        dir: string;
        relativePath: string;
        markers: string[];
    }>;
    /** Directories already initialised (have .brainclaw/). */
    alreadyInitialised: Array<{
        dir: string;
        relativePath: string;
    }>;
}
/**
 * Walk up to `maxDepth` levels below `rootDir`, find subdirectories that
 * contain service markers but no `.brainclaw/` yet.
 *
 * `rootDir` itself is excluded (the caller is presumably about to `init` it).
 */
export declare function scanWorkspaceBoundaries(rootDir: string, maxDepth?: number): WorkspaceScanResult;
//# sourceMappingURL=repo-analysis.d.ts.map