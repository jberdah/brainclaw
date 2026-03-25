/**
 * Project discovery — unified workspace inventory that composes existing
 * scan functions into a single structured profile.
 *
 * Boundary: discovery describes what exists in the workspace RIGHT NOW.
 * It is NOT canonical memory (decisions, traps, plans). It is NOT
 * machine profile (shells, SSH keys, WSL distros). It is the project-level
 * answer to "what MCP servers, skills, hooks, instruction files, and
 * agent integrations are available in this workspace?"
 */
import { type AgentToolingSnapshot } from './agent-context.js';
import { type AgentIntegrationReadiness } from './agent-integrations.js';
export interface DiscoveredFile {
    path: string;
    exists: boolean;
    size?: number;
    managed_by_brainclaw?: boolean;
}
export interface ProjectDiscoveryProfile {
    /** When this discovery was run */
    discovered_at: string;
    /** Workspace root */
    workspace_root: string;
    /** Agent tooling snapshot (AGENTS.md, skills, MCP servers) */
    agent_tooling: AgentToolingSnapshot;
    /** Native instruction files found in workspace */
    instruction_files: DiscoveredFile[];
    /** MCP config files found in workspace */
    mcp_configs: DiscoveredFile[];
    /** Hook config files found in workspace */
    hook_configs: DiscoveredFile[];
    /** Agent integration readiness (declared vs present) */
    integrations: AgentIntegrationReadiness[];
    /** Summary counts */
    summary: {
        total_instruction_files: number;
        total_mcp_servers: number;
        total_skills: number;
        total_mcp_configs: number;
        total_hook_configs: number;
        integrations_ready: number;
        integrations_total: number;
    };
}
export interface BuildDiscoveryOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}
export declare function buildProjectDiscovery(options?: BuildDiscoveryOptions): ProjectDiscoveryProfile;
export declare function saveDiscoveryProfile(profile: ProjectDiscoveryProfile, cwd?: string): void;
export declare function loadDiscoveryProfile(cwd?: string): ProjectDiscoveryProfile | undefined;
export declare function renderDiscoverySummary(profile: ProjectDiscoveryProfile): string;
//# sourceMappingURL=project-discovery.d.ts.map