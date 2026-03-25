export interface ExecutionToolVersion {
    name: string;
    available: boolean;
    version?: string;
}
export interface ExecutionEnvSignal {
    name: string;
    value: string;
    redacted: boolean;
}
export interface ExecutionContextSnapshot {
    platform: NodeJS.Platform;
    shell: string;
    cwd: string;
    workspace_root: string;
    branch?: string;
    git_status: 'clean' | 'dirty' | 'unavailable';
    has_remote: boolean;
    toolchains: ExecutionToolVersion[];
    env_signals: ExecutionEnvSignal[];
}
export interface CompactExecutionContextSnapshot {
    platform: NodeJS.Platform;
    shell?: string;
    workspace_root: string;
    branch?: string;
    git_status: 'clean' | 'dirty' | 'unavailable';
    has_remote: boolean;
    toolchains: ExecutionToolVersion[];
}
export interface ExecutionContextOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    runner?: CommandRunner;
}
export interface CommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult;
export declare function buildExecutionContext(options?: ExecutionContextOptions): ExecutionContextSnapshot;
export declare function compactExecutionContext(snapshot: ExecutionContextSnapshot): CompactExecutionContextSnapshot;
export declare function renderExecutionContextSummary(snapshot: ExecutionContextSnapshot | CompactExecutionContextSnapshot, includeEnvSignals?: boolean): string;
//# sourceMappingURL=execution-context.d.ts.map