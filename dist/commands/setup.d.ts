export { readSetupState } from '../core/setup-state.js';
export interface SetupOptions {
    roots?: string;
    agents?: string;
    repos?: string;
    yes?: boolean;
}
export interface RepoInfo {
    path: string;
    name: string;
    alreadyInitialised: boolean;
}
export declare const ALL_KNOWN_AGENTS: string[];
export declare function checkGitPresence(): boolean;
export declare function parseRoots(input: string, env?: NodeJS.ProcessEnv): string[];
export declare function scanGitRepos(roots: string[]): RepoInfo[];
export declare function parseRepoSelection(choice: string, repos: RepoInfo[], cwd?: string): RepoInfo[];
export declare function parseAgentSelection(choice: string, detected: string | undefined): string[];
export declare function initUserStore(home: string | undefined, env?: NodeJS.ProcessEnv): string[];
export declare function runGlobalInstall(selectedAgents: string[], env?: NodeJS.ProcessEnv): string[];
export declare function initReposAndConfigureAgents(selectedRepos: RepoInfo[], selectedAgents: string[], env?: NodeJS.ProcessEnv): Promise<{
    initialisedRepos: string[];
    configActions: string[];
}>;
export declare function printReloadReminder(detectedAgent: string | undefined): void;
export declare function runSetup(options?: SetupOptions): Promise<void>;
//# sourceMappingURL=setup.d.ts.map