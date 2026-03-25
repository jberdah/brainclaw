export interface SetupState {
    completed_at: string;
    roots: string[];
    initialised_repos: string[];
    global_configs_written: string[];
}
export declare function resolveHomeDir(env?: NodeJS.ProcessEnv): string | undefined;
export declare function setupStatePath(env?: NodeJS.ProcessEnv): string | undefined;
export declare function userStoreConfigPath(env?: NodeJS.ProcessEnv): string | undefined;
export declare function readSetupState(env?: NodeJS.ProcessEnv): SetupState | undefined;
export declare function writeSetupState(state: SetupState, env?: NodeJS.ProcessEnv): void;
export declare function hasCompletedSetup(env?: NodeJS.ProcessEnv): boolean;
/**
 * Ensure the user-global store (~/.brainclaw/) exists, creating it implicitly
 * if absent. This replaces the old "setup required before init" guard —
 * init can now auto-create the minimal user store on first run.
 *
 * Idempotent: returns immediately if the user store already exists.
 * Non-fatal: logs a warning if creation fails but does not throw.
 */
export declare function ensureUserStore(env?: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=setup-state.d.ts.map