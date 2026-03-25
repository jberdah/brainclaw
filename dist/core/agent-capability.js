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
const PROFILES = {
    'claude-code': {
        name: 'claude-code',
        hasMcp: true,
        hasHooks: true,
        hasAutoApprove: true,
        hasSkills: true,
        hasRules: true,
        instructionFile: 'CLAUDE.md',
        sharedInstructionFile: true,
        mcpConfigScope: 'both',
        templateTier: 'A',
    },
    cursor: {
        name: 'cursor',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: false,
        hasRules: true,
        instructionFile: '.cursor/rules/brainclaw.md',
        sharedInstructionFile: false,
        mcpConfigScope: 'machine',
        templateTier: 'B',
    },
    windsurf: {
        name: 'windsurf',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: false,
        hasRules: true,
        instructionFile: '.windsurfrules',
        sharedInstructionFile: true,
        mcpConfigScope: 'machine',
        templateTier: 'B',
    },
    cline: {
        name: 'cline',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: true,
        hasSkills: false,
        hasRules: true,
        instructionFile: '.clinerules/brainclaw.md',
        sharedInstructionFile: false,
        mcpConfigScope: 'project',
        templateTier: 'B',
    },
    roo: {
        name: 'roo',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: true,
        hasSkills: false,
        hasRules: true,
        instructionFile: '.roo/rules/brainclaw.md',
        sharedInstructionFile: false,
        mcpConfigScope: 'project',
        templateTier: 'B',
    },
    continue: {
        name: 'continue',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: false,
        hasRules: true,
        instructionFile: '.continue/rules/brainclaw.md',
        sharedInstructionFile: false,
        mcpConfigScope: 'both',
        templateTier: 'B',
    },
    opencode: {
        name: 'opencode',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: false,
        hasRules: true,
        instructionFile: 'AGENTS.md',
        sharedInstructionFile: true,
        mcpConfigScope: 'project',
        templateTier: 'B',
    },
    codex: {
        name: 'codex',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: false,
        hasRules: true,
        instructionFile: 'AGENTS.md',
        sharedInstructionFile: true,
        mcpConfigScope: 'machine',
        templateTier: 'B',
    },
    antigravity: {
        name: 'antigravity',
        hasMcp: true,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: false,
        hasRules: true,
        instructionFile: 'GEMINI.md',
        sharedInstructionFile: true,
        mcpConfigScope: 'machine',
        templateTier: 'B',
    },
    'github-copilot': {
        name: 'github-copilot',
        hasMcp: false,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: true,
        hasRules: true,
        instructionFile: '.github/copilot-instructions.md',
        sharedInstructionFile: true,
        mcpConfigScope: 'none',
        templateTier: 'C',
    },
    openclaw: {
        name: 'openclaw',
        hasMcp: false,
        hasHooks: false,
        hasAutoApprove: false,
        hasSkills: true,
        hasRules: false,
        instructionFile: 'skills/openclaw/SKILL.md',
        sharedInstructionFile: false,
        mcpConfigScope: 'none',
        templateTier: 'C',
    },
};
/**
 * Get the capability profile for a known agent.
 * Returns undefined for unknown agent names.
 */
export function getAgentCapabilityProfile(name) {
    return PROFILES[name];
}
/**
 * Get all known agent capability profiles.
 */
export function getAllAgentCapabilityProfiles() {
    return Object.values(PROFILES);
}
/**
 * Get all agent names that match a given template tier.
 */
export function getAgentsByTier(tier) {
    return Object.values(PROFILES).filter((p) => p.templateTier === tier);
}
/**
 * Check if an agent name is a known brainclaw-supported agent.
 */
export function isKnownAgent(name) {
    return name in PROFILES;
}
/**
 * Summarize which integration surfaces are available for a given agent.
 * Useful for setup UI to explain what brainclaw will configure.
 */
export function describeAgentSurfaces(name) {
    const profile = getAgentCapabilityProfile(name);
    if (!profile)
        return [];
    const surfaces = [];
    if (profile.hasMcp) {
        surfaces.push(`MCP server (${profile.mcpConfigScope})`);
    }
    if (profile.hasRules) {
        surfaces.push(`Instruction file (${profile.instructionFile})`);
    }
    if (profile.hasAutoApprove) {
        surfaces.push('Auto-approve MCP tools');
    }
    if (profile.hasHooks) {
        surfaces.push('Session hooks (pre-prompt + stop)');
    }
    if (profile.hasSkills) {
        surfaces.push('Slash command / skill');
    }
    return surfaces;
}
//# sourceMappingURL=agent-capability.js.map