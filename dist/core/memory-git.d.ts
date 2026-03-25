/**
 * Check if the memory directory has an internal git repo.
 */
export declare function hasMemoryRepo(cwd?: string): boolean;
/**
 * Initialize a git repo inside .brainclaw/ for memory versioning.
 * Idempotent — skips if already initialized.
 * Returns true if a new repo was created.
 */
export declare function initMemoryRepo(cwd?: string): boolean;
/**
 * Commit all pending changes in the memory repo.
 * Called after write operations (saveState, saveRuntimeNote, etc.).
 *
 * No-op if:
 * - No memory repo exists
 * - No changes to commit
 *
 * Returns true if a commit was created.
 */
export declare function commitMemoryChange(message: string, cwd?: string): boolean;
/**
 * Get the short log of recent memory commits.
 */
export declare function getMemoryLog(limit?: number, cwd?: string): string[];
/**
 * Rollback the memory to a previous commit.
 * Returns true if successful.
 */
export declare function rollbackMemory(ref: string, cwd?: string): boolean;
/**
 * Get the current HEAD short hash.
 */
export declare function getMemoryHead(cwd?: string): string | undefined;
//# sourceMappingURL=memory-git.d.ts.map