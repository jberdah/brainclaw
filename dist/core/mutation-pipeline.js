/**
 * Mutation pipeline — single entry point for all .brainclaw/ store mutations.
 *
 * Every write operation against the store MUST go through `mutate()`.
 * This ensures:
 *   1. Store-wide serialization via the advisory file lock
 *   2. Consistent error handling and timeout behavior
 *   3. Observable mutation metadata for debugging and auditing
 *
 * @module
 */
import { ensureMemoryDir, storeLockPath } from './io.js';
import { withLock } from './lock.js';
import { logger } from './logger.js';
/** Default timeout for store-wide lock acquisition (ms). */
export const STORE_LOCK_TIMEOUT_MS = 5_000;
export function mutate(optionsOrFn, maybeFn) {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? STORE_LOCK_TIMEOUT_MS;
    ensureMemoryDir(cwd, options.preferredDirName);
    const lockTarget = storeLockPath(cwd, options.preferredDirName);
    const start = performance.now();
    try {
        const value = withLock(lockTarget, () => fn(cwd), timeoutMs);
        const durationMs = performance.now() - start;
        if (durationMs > 1_000) {
            logger.debug(`Slow mutation: ${durationMs.toFixed(0)}ms (cwd=${cwd})`);
        }
        return value;
    }
    catch (err) {
        const durationMs = performance.now() - start;
        logger.debug(`Mutation failed after ${durationMs.toFixed(0)}ms: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}
//# sourceMappingURL=mutation-pipeline.js.map