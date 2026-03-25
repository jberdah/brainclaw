/**
 * Agent capability profiles — describes what integration surfaces each
 * agent supports so brainclaw can adapt its instruction file content,
 * integration depth, and pressure level accordingly.
 *
 * Three profile tiers drive instruction file templates:
 *   A (full)    — MCP + hooks + auto-approve → lightweight instructions
 *   B (standard) — MCP, no hooks → directive instructions with top traps
 *   C (limited) — no MCP → rich static content (plans, traps, decisions)
 */
export interface AgentCapabilityProfile {
    /** Agent identifier (matches ALL_KNOWN_AGENTS in setup.ts) */
    name: string;
    /** Agent supports MCP tool calling */
    hasMcp: boolean;
    /** Agent supports lifecycle hooks (pre-prompt injection, stop cleanup) */
    hasHooks: boolean;
    /** Agent supports auto-approve / always-allow for MCP tools */
    hasAutoApprove: boolean;
    /** Agent supports skills or custom commands */
    hasSkills: boolean;
    /** Agent supports rules / instruction files */
    hasRules: boolean;
    /** Primary instruction file path (relative to project root) */
    instructionFile: string;
    /** Whether the instruction file is shared with other content (needs sentinels) */
    sharedInstructionFile: boolean;
    /** MCP config location: 'project' | 'machine' | 'both' | 'none' */
    mcpConfigScope: 'project' | 'machine' | 'both' | 'none';
    /** Template tier: A (full), B (standard), C (limited) */
    templateTier: 'A' | 'B' | 'C';
}
export type AgentName = 'claude-code' | 'cursor' | 'windsurf' | 'cline' | 'roo' | 'continue' | 'opencode' | 'codex' | 'antigravity' | 'github-copilot' | 'openclaw';
/**
 * Get the capability profile for a known agent.
 * Returns undefined for unknown agent names.
 */
export declare function getAgentCapabilityProfile(name: string): AgentCapabilityProfile | undefined;
/**
 * Get all known agent capability profiles.
 */
export declare function getAllAgentCapabilityProfiles(): AgentCapabilityProfile[];
/**
 * Get all agent names that match a given template tier.
 */
export declare function getAgentsByTier(tier: 'A' | 'B' | 'C'): AgentCapabilityProfile[];
/**
 * Check if an agent name is a known brainclaw-supported agent.
 */
export declare function isKnownAgent(name: string): name is AgentName;
/**
 * Summarize which integration surfaces are available for a given agent.
 * Useful for setup UI to explain what brainclaw will configure.
 */
export declare function describeAgentSurfaces(name: string): string[];
//# sourceMappingURL=agent-capability.d.ts.map