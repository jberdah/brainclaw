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
export function mutate<T>(options: MutationOptions, fn: (cwd: string) => T): T;
export function mutate<T>(fn: (cwd: string) => T): T;
export function mutate<T>(
  optionsOrFn: MutationOptions | ((cwd: string) => T),
  maybeFn?: (cwd: string) => T,
): T {
  const options: MutationOptions = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;

  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? STORE_LOCK_TIMEOUT_MS;

  const lockTarget = storeLockPath(cwd, options.preferredDirName);
  const start = performance.now();

  try {
    const value = withLock(lockTarget, () => {
      ensureMemoryDir(cwd, options.preferredDirName);
      return fn(cwd);
    }, timeoutMs);
    const durationMs = performance.now() - start;

    if (durationMs > 1_000) {
      logger.debug(`Slow mutation: ${durationMs.toFixed(0)}ms (cwd=${cwd})`);
    }

    return value;
  } catch (err: unknown) {
    const durationMs = performance.now() - start;
    logger.debug(`Mutation failed after ${durationMs.toFixed(0)}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
