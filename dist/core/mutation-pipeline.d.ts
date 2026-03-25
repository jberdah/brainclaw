/** Default timeout for store-wide lock acquisition (ms). */
export declare const STORE_LOCK_TIMEOUT_MS = 5000;
export interface MutationOptions {
    /** Project root directory. Defaults to process.cwd(). */
    cwd?: string;
    /** Preferred .brainclaw directory name override. */
    preferredDirName?: string;
    /** Lock acquisition timeout in ms. Defaults to STORE_LOCK_TIMEOUT_MS. */
    timeoutMs?: number;
}
export interface MutationResult<T> {
    /** Value returned by the mutation callback. */
    value: T;
    /** Wall-clock duration of the mutation in milliseconds. */
    durationMs: number;
}
/**
 * Execute a mutation against the store under the store-wide lock.
 *
 * All callers that write to `.brainclaw/` should use this function
 * instead of calling `withStoreLock` or `withLock` directly.
 *
 * The callback receives the resolved `cwd` so it doesn't have to
 * re-derive it.
 *
 * @returns The value produced by `fn`.
 * @throws If the lock cannot be acquired within `timeoutMs`.
 */
export declare function mutate<T>(options: MutationOptions, fn: (cwd: string) => T): T;
export declare function mutate<T>(fn: (cwd: string) => T): T;
//# sourceMappingURL=mutation-pipeline.d.ts.map