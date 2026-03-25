export type StoreRole = 'service' | 'repo' | 'workspace' | 'user' | 'unknown';
export interface StoreRef {
    /** Absolute path to the .brainclaw/ directory */
    storePath: string;
    /** Absolute path to the directory containing .brainclaw/ */
    cwd: string;
    /** Distance from the origin cwd: 0 = closest (highest priority) */
    depth: number;
    /** Role declared in config.yaml store_type, or inferred */
    role: StoreRole;
}
export interface ResolveStoreChainOptions {
    /** Override the directory name (default: .brainclaw) */
    dirName?: string;
    /**
     * Absolute path at which to stop walking up.
     * Defaults to os.homedir(). Walk never goes above this directory.
     */
    boundary?: string;
    /**
     * If true, include stores even when their .brainclaw/ directory exists
     * but has no config.yaml (partially initialised stores).
     */
    includePartial?: boolean;
}
/**
 * Walk up the filesystem from `cwd`, collecting every `.brainclaw/` directory
 * found along the way, up to (and including) `boundary`.
 *
 * The returned array is ordered from closest to farthest (index 0 = highest
 * priority). Returns an empty array when no store is found.
 */
export declare function resolveStoreChain(cwd?: string, options?: ResolveStoreChainOptions): StoreRef[];
/**
 * Return the single "primary" store for a given cwd — the closest one.
 * Returns undefined when no store exists in the chain.
 */
export declare function resolvePrimaryStore(cwd?: string, options?: ResolveStoreChainOptions): StoreRef | undefined;
export type StoreTarget = 'local' | 'repo' | 'workspace' | 'user';
/**
 * Resolve the effective cwd for a write operation targeting a specific store level.
 *
 * - `local`     → the closest store (default, current behaviour)
 * - `repo`      → the first store with role='repo' in the chain; falls back to closest
 * - `workspace` → the first store with role='workspace', or the farthest store found
 * - `user`      → the first store with role='user' in the chain; falls back to os.homedir()
 *
 * Returns the original cwd unchanged when no chain exists or when target='local'.
 */
export declare function resolveTargetStore(cwd?: string, target?: StoreTarget, options?: ResolveStoreChainOptions): string;
export interface ResolveEffectiveCwdOptions {
    /** Explicit --cwd flag value (highest priority). */
    explicitCwd?: string;
    /** Store chain options passed through to resolveStoreChain. */
    storeChainOptions?: ResolveStoreChainOptions;
}
/**
 * Single source of truth for the effective working directory.
 *
 * Priority:
 * 1. explicitCwd (--cwd flag)
 * 2. BRAINCLAW_PROJECT env var → resolved by name/path from workspace
 * 3. active-project.json in workspace root
 * 4. process.cwd()
 */
export declare function resolveEffectiveCwd(options?: ResolveEffectiveCwdOptions): string;
/**
 * Find the workspace root (farthest store in the chain, or the one with
 * role=workspace). Returns undefined when no store exists.
 */
export declare function resolveWorkspaceRoot(cwd?: string, options?: ResolveStoreChainOptions): string | undefined;
/**
 * Resolve a project reference (name or relative path) to an absolute path.
 * Returns undefined when the reference cannot be resolved to a valid brainclaw project.
 */
export declare function resolveProjectRef(ref: string, cwd?: string, storeChainOptions?: ResolveStoreChainOptions): string | undefined;
/**
 * Resolve the most specific child store that should answer a context request.
 *
 * This keeps the current cwd by default, but when `target` clearly points inside
 * a nested Brainclaw project (for example from a workspace root in folder mode),
 * it returns that child store cwd instead.
 */
export declare function resolveContextStoreCwd(cwd?: string, target?: string): string;
//# sourceMappingURL=store-resolution.d.ts.map