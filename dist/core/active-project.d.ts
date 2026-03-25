export interface ActiveProject {
    /** Absolute path to the project directory. */
    path: string;
    /** Project name from config.yaml (when available). */
    name?: string;
    /** ISO timestamp of the switch. */
    switched_at: string;
    /** Agent or user who performed the switch. */
    switched_by?: string;
}
/**
 * Load the active project for a workspace.
 * Returns undefined when no active project is set or the file is unreadable.
 */
export declare function loadActiveProject(workspaceRoot: string): ActiveProject | undefined;
/**
 * Persist the active project for a workspace.
 */
export declare function saveActiveProject(workspaceRoot: string, project: ActiveProject): void;
/**
 * Clear the active project (revert to process.cwd() default).
 */
export declare function clearActiveProject(workspaceRoot: string): void;
//# sourceMappingURL=active-project.d.ts.map