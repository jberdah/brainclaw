export interface SwitchOptions {
    list?: boolean;
    clear?: boolean;
    /** Scope switch to session only (default: true when a session is active). */
    session?: boolean;
    json?: boolean;
    cwd?: string;
}
export interface SwitchProjectOptions {
    cwd?: string;
    /** Force session-scoped switch (never write to global active-project.json). */
    sessionOnly?: boolean;
}
export interface SwitchProjectResult {
    switched: boolean;
    path: string;
    name?: string;
    scope: 'session' | 'global';
    workspace_root: string;
}
/**
 * Switch to a project programmatically.
 * When sessionOnly=true (default for MCP), ONLY writes to the session state.
 * This prevents agents from cross-contaminating each other's active project.
 */
export declare function switchProject(projectRef: string, options?: SwitchProjectOptions): SwitchProjectResult;
export interface ListProjectsResult {
    workspace_root: string;
    projects: Array<{
        name?: string;
        path: string;
        relative_path: string;
        active: boolean;
    }>;
}
/**
 * List available projects in the workspace.
 */
export declare function listAvailableProjects(cwd?: string): ListProjectsResult;
export declare function runSwitch(projectRef: string | undefined, options?: SwitchOptions): void;
//# sourceMappingURL=switch.d.ts.map