export declare function acquireLock(targetPath: string, timeoutMs?: number): boolean;
export declare function releaseLock(targetPath: string): void;
export declare function withLock<T>(targetPath: string, fn: () => T, timeoutMs?: number): T;
export declare function cleanStaleLocks(dirPath: string): number;
//# sourceMappingURL=lock.d.ts.map