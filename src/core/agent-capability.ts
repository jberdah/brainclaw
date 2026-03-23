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

export type AgentName =
  | 'claude-code'
  | 'cursor'
  | 'windsurf'
  | 'cline'
  | 'roo'
  | 'continue'
  | 'opencode'
  | 'codex'
  | 'antigravity'
  | 'github-copilot'
  | 'openclaw';

const PROFILES: Record<AgentName, AgentCapabilityProfile> = {
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
export function getAgentCapabilityProfile(name: string): AgentCapabilityProfile | undefined {
  return PROFILES[name as AgentName];
}

/**
 * Get all known agent capability profiles.
 */
export function getAllAgentCapabilityProfiles(): AgentCapabilityProfile[] {
  return Object.values(PROFILES);
}

/**
 * Get all agent names that match a given template tier.
 */
export function getAgentsByTier(tier: 'A' | 'B' | 'C'): AgentCapabilityProfile[] {
  return Object.values(PROFILES).filter((p) => p.templateTier === tier);
}

/**
 * Check if an agent name is a known brainclaw-supported agent.
 */
export function isKnownAgent(name: string): name is AgentName {
  return name in PROFILES;
}

/**
 * Summarize which integration surfaces are available for a given agent.
 * Useful for setup UI to explain what brainclaw will configure.
 */
export function describeAgentSurfaces(name: string): string[] {
  const profile = getAgentCapabilityProfile(name);
  if (!profile) return [];

  const surfaces: string[] = [];

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
