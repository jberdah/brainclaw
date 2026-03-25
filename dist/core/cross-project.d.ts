import type { CrossProjectLink } from './schema.js';
import type { State, RuntimeNote } from './schema.js';
export interface ResolvedCrossProjectLink extends CrossProjectLink {
    absolutePath: string;
    projectName: string;
    available: boolean;
}
/**
 * Resolves cross_project_links from config, converting relative paths to absolute.
 */
export declare function resolveCrossProjectLinks(cwd?: string): ResolvedCrossProjectLink[];
/**
 * Detects cycles in cross_project_links (A → B → A).
 * Returns the paths involved in any cycle found.
 */
export declare function detectCrossProjectCycles(cwd?: string): string[][];
/**
 * Loads state from a linked project (read-only).
 */
export declare function loadCrossProjectState(absolutePath: string): State;
/**
 * Writes a runtime note into a target (publisher-linked) project's runtime dir.
 * Used by bclaw_write_note --cross-project.
 */
export declare function writeCrossProjectNote(targetAbsolutePath: string, note: RuntimeNote, sourceCwd?: string): void;
/**
 * Returns the absolute path of a cross-project link by name or path fragment.
 */
export declare function resolveCrossProjectTarget(nameOrPath: string, cwd?: string): ResolvedCrossProjectLink;
//# sourceMappingURL=cross-project.d.ts.map