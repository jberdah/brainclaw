export interface SyncOptions {
    commit?: boolean;
    message?: string;
    summaryOnly?: boolean;
    scope?: string;
    includeMachineRuntime?: boolean;
    remote?: boolean;
    cwd?: string;
}
export declare function runSync(options?: SyncOptions): void;
export declare function resolveScopePaths(scope?: string, includeMachineRuntime?: boolean, cwd?: string): string[];
//# sourceMappingURL=sync.d.ts.map