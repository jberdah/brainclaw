import fs from 'node:fs';
export { mutate } from './mutation-pipeline.js';
export declare const MEMORY_DIR = ".brainclaw";
interface AtomicWriteOptions {
    fsImpl?: Pick<typeof fs, 'writeFileSync' | 'renameSync'>;
    maxRenameAttempts?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => void;
}
/**
 * Resolve a subdirectory path with entity-model awareness.
 *
 * For READS: tries the new entity path first, falls back to legacy flat path.
 * For WRITES: always uses the new entity path (creates parent dirs as needed).
 *
 * @param subdir Legacy subdirectory name (e.g. 'constraints', 'claims')
 * @param cwd Project root
 * @param mode 'read' checks both paths, 'write' uses new path only
 */
export declare function resolveEntityDir(subdir: string, cwd?: string, mode?: 'read' | 'write', preferredDirName?: string): string;
export declare function memoryDir(cwd?: string, preferredDirName?: string): string;
export declare function memoryPath(filename: string, cwd?: string, preferredDirName?: string): string;
export declare function storeLockPath(cwd?: string, preferredDirName?: string): string;
export declare function memoryExists(cwd?: string, preferredDirName?: string): boolean;
export declare function ensureMemoryDir(cwd?: string, preferredDirName?: string): void;
export declare function withStoreLock<T>(cwd: string | undefined, fn: () => T, preferredDirName?: string): T;
export declare function readFileSync(filepath: string): string;
/** Atomic write with advisory file locking: acquire lock, write to a temp file, then rename. */
export declare function writeFileAtomic(filepath: string, content: string, options?: AtomicWriteOptions): void;
/**
 * Remove orphan .tmp and .lock files left by crashed processes.
 * Call once at CLI startup. Returns count of removed files.
 */
export declare function cleanOrphanFiles(dirPath: string): number;
//# sourceMappingURL=io.d.ts.map