export interface RegisteredProject {
    project_id: string;
    project_name: string;
    path: string;
    git_remote?: string;
    git_users: Array<{
        name: string;
        email: string;
    }>;
    last_activity?: string;
    agents_seen: string[];
}
export interface GlobalProjectRegistry {
    schema_version: number;
    updated_at: string;
    projects: RegisteredProject[];
}
/**
 * Extract registry metadata from a single brainclaw-initialized project.
 */
export declare function scanProject(projectPath: string): RegisteredProject | undefined;
export declare function globalRegistryPath(): string;
export declare function loadGlobalRegistry(): GlobalProjectRegistry | undefined;
export declare function saveGlobalRegistry(registry: GlobalProjectRegistry): string;
/**
 * Register or update a single project in the global registry (upsert by project_id).
 */
export declare function upsertProject(entry: RegisteredProject): GlobalProjectRegistry;
/**
 * Scan directories for brainclaw projects and update the global registry.
 */
export declare function scanAndRegister(roots: string[]): GlobalProjectRegistry;
/**
 * Render human-readable summary of the global project registry.
 */
export declare function renderGlobalRegistrySummary(registry: GlobalProjectRegistry): string;
//# sourceMappingURL=global-registry.d.ts.map