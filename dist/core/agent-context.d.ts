export interface SkillInventoryItem {
    name: string;
    description?: string;
    source_path: string;
    scripts_present: boolean;
    references_present: boolean;
    assets_present: boolean;
}
export type McpServerAvailability = 'available' | 'missing_command' | 'unknown' | 'remote';
export type McpServerSource = 'workspace' | 'codex_home' | 'home';
export interface McpServerInventoryItem {
    name: string;
    transport: 'stdio' | 'remote' | 'unknown';
    command?: string;
    config_path: string;
    availability: McpServerAvailability;
    source: McpServerSource;
}
export interface AgentToolingSnapshot {
    agents_md_present: boolean;
    agents_md_title?: string;
    agents_rules: string[];
    skills: SkillInventoryItem[];
    mcp_servers: McpServerInventoryItem[];
}
export interface AgentContextOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}
export declare function buildAgentToolingContext(options?: AgentContextOptions): AgentToolingSnapshot;
export declare function renderAgentToolingSummary(snapshot: AgentToolingSnapshot): string;
//# sourceMappingURL=agent-context.d.ts.map