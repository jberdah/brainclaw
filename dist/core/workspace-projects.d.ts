import { type RegisteredProject } from './global-registry.js';
import type { Config } from './schema.js';
export interface DiscoveredWorkspaceProject {
    path: string;
    relative_path: string;
    project_id?: string;
    project_name?: string;
    source: 'config' | 'registry' | 'filesystem';
}
export interface WorkspaceProjectSummary {
    strategy: Config['projects']['strategy'];
    configured_projects: string[];
    discovered_projects: DiscoveredWorkspaceProject[];
    effective_project_count: number;
    uses_folder_resolution: boolean;
}
export declare function summarizeWorkspaceProjects(cwd: string, config: Pick<Config, 'project_mode' | 'projects'>): WorkspaceProjectSummary;
export declare function scanNestedBrainclawProjects(rootDir: string, maxDepth?: number): RegisteredProject[];
//# sourceMappingURL=workspace-projects.d.ts.map