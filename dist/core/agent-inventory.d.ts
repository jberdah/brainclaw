export interface AgentModelInfo {
    name: string;
    /** Approximate context window in tokens (if known) */
    context_window?: number;
}
export interface AgentInventoryEntry {
    /** Canonical agent name (e.g. 'claude-code', 'cursor') */
    name: string;
    /** Whether the agent is installed / detectable on this machine */
    installed: boolean;
    /** How we detected it */
    detection_method: string;
    /** Version string if discoverable */
    version?: string;
    /** Models this agent can use (known or configured) */
    models: AgentModelInfo[];
    /** Native tools the agent provides (read, write, bash, etc.) */
    native_tools: string[];
    /** Whether agent supports MCP servers */
    mcp_support: boolean;
    /** MCP config format and path pattern */
    mcp_config_format?: string;
    /** Whether agent supports skills/commands */
    skills_support: boolean;
    /** Skills path pattern (e.g. '.claude/commands/') */
    skills_path_pattern?: string;
    /** Whether agent supports custom rules */
    rules_support: boolean;
    /** Whether agent supports hooks */
    hooks_support: boolean;
    /** Instruction file pattern (e.g. 'CLAUDE.md') */
    instruction_file?: string;
}
export interface AgentInventory {
    schema_version: number;
    generated_at: string;
    agents: AgentInventoryEntry[];
}
/**
 * Detect ALL installed agents on this machine (not just the running one).
 */
export declare function buildAgentInventory(homeDir?: string, env?: NodeJS.ProcessEnv): AgentInventory;
/**
 * Path to the agent inventory file.
 */
export declare function agentInventoryPath(): string;
/**
 * Save agent inventory to ~/.brainclaw/agents-inventory.yaml.
 */
export declare function saveAgentInventory(inventory: AgentInventory): string;
/**
 * Load agent inventory from ~/.brainclaw/agents-inventory.yaml.
 */
export declare function loadAgentInventory(): AgentInventory | undefined;
/**
 * Render a human-readable summary of the agent inventory.
 */
export declare function renderAgentInventorySummary(inventory: AgentInventory): string;
export interface InventoryDiff {
    appeared: string[];
    disappeared: string[];
    version_changed: Array<{
        name: string;
        from?: string;
        to?: string;
    }>;
}
/**
 * Compare two agent inventories and return what changed.
 * Only considers agents that are `installed` in either snapshot.
 */
export declare function diffInventory(previous: AgentInventory | undefined, current: AgentInventory): InventoryDiff;
//# sourceMappingURL=agent-inventory.d.ts.map