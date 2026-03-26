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
export interface GitWorktreeInfo {
    /** Absolute path to the .git directory (or gitdir file for linked worktrees). */
    git_dir: string;
    /** Absolute path to the current worktree root. */
    worktree_path: string;
    /** Absolute path to the main worktree root (same as worktree_path for non-linked worktrees). */
    main_worktree_path: string;
    /** True if this is a linked worktree (not the main one). */
    is_linked_worktree: boolean;
}
export interface ExecutionContextSnapshot {
    platform: NodeJS.Platform;
    shell: string;
    cwd: string;
    workspace_root: string;
    branch?: string;
    git_status: 'clean' | 'dirty' | 'unavailable';
    has_remote: boolean;
    /** Git worktree details — undefined when not in a git repo. */
    git_worktree?: GitWorktreeInfo;
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