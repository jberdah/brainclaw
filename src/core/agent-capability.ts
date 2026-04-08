/**
 * Agent capability profiles — describes what integration surfaces each
 * agent supports so brainclaw can adapt its instruction file content,
 * integration depth, and pressure level accordingly.
 *
 * Three profile tiers drive instruction file templates:
 *   A (full)    — MCP + hooks → lightweight instructions (context via hooks/MCP)
 *   B (standard) — MCP, no hooks → working rules + architecture + top traps
 *   C (limited) — no MCP → rich static content (plans, traps, decisions)
 *
 * Tier A agents (as of 2026-04): Claude Code, Copilot, Codex, Cursor,
 * Windsurf (12 hooks!), Cline (macOS/Linux only).
 * Note: Cline hooks don't work on Windows — but templateTier stays A
 * because brainclaw generates hooks that gracefully degrade.
 */

export type AgentCategory = 'code-agent' | 'autonomous-agent' | 'desktop-ai';
export type WorkflowModel = 'interactive' | 'task-based' | 'scheduled';
export type RoleCapability = 'execute' | 'coordinate' | 'review' | 'consult';
export type PromptDeliveryMethod = 'inline_arg' | 'temp_file' | 'stdin_pipe' | 'inbox_structured';
export type ExecutionSurface = 'cli' | 'ide' | 'extension' | 'remote';

export interface AgentCapabilityProfile {
  /** Agent identifier (matches ALL_KNOWN_AGENTS in setup.ts) */
  name: string;
  /** Agent category: code-agent (IDE-driven), autonomous-agent (headless), desktop-ai (app) */
  category: AgentCategory;
  /** Workflow model: interactive (human-in-loop), task-based (receive→execute→report), scheduled (cron) */
  workflowModel: WorkflowModel;
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

  // ── Multi-agent coordination fields ──────────────────────────────────────

  /** Roles this agent can fulfill in a multi-agent workflow */
  role_capabilities: RoleCapability[];
  /** Runtime integration surfaces available */
  runtime: {
    /** Can be called directly as an MCP server from another agent */
    mcp_direct: boolean;
    /** Supports lifecycle hooks (pre-prompt injection, stop cleanup) */
    hooks: boolean;
    /** Can be spawned as a CLI subprocess */
    spawnable_cli: boolean;
    /** Can receive tasks via brainclaw inbox */
    inbox: boolean;
  };
  /** How brainclaw delivers prompts to this agent */
  prompt_delivery: {
    methods: PromptDeliveryMethod[];
    preferred: PromptDeliveryMethod;
    /** Max characters for inline_arg delivery; longer prompts use preferred fallback */
    max_inline_length?: number;
  };
  /** Execution environment context */
  execution_env: {
    surface: ExecutionSurface;
    os?: string;
    shell?: string;
  };
  /** CLI invoke template (uses {prompt} placeholder). Undefined = not CLI-spawnable */
  invoke_template?: string;
  /** Binary that must be in PATH for invoke_template */
  invoke_binary?: string;
  /** CLI invoke template for review mode (read-only tools). Falls back to invoke_template */
  invoke_review_template?: string;
  /** CLI invoke template for consult mode (read-only, advisory). Falls back to invoke_review_template or invoke_template */
  invoke_consult_template?: string;
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
  | 'openclaw'
  | 'nanoclaw'
  | 'nemoclaw'
  | 'picoclaw'
  | 'zeroclaw';

const PROFILES: Record<AgentName, AgentCapabilityProfile> = {
  // --- Code agents (interactive, IDE-driven) ---
  'claude-code': {
    name: 'claude-code', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: true, hasSkills: true, hasRules: true,
    instructionFile: 'CLAUDE.md', sharedInstructionFile: true, mcpConfigScope: 'both', templateTier: 'A',
    role_capabilities: ['execute', 'coordinate', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: true, spawnable_cli: true, inbox: true },
    prompt_delivery: { methods: ['temp_file', 'inline_arg', 'inbox_structured'], preferred: 'temp_file', max_inline_length: 4000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'claude -p "{prompt}" --allowedTools "Edit,Write,Bash,Read,Glob,Grep"',
    invoke_binary: 'claude',
    invoke_review_template: 'claude -p "{prompt}" --allowedTools "Read,Glob,Grep"',
    invoke_consult_template: 'claude -p "{prompt}" --allowedTools "Read,Glob,Grep"',
  },
  cursor: {
    name: 'cursor', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: false, hasSkills: true, hasRules: true,
    instructionFile: '.cursor/rules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'machine', templateTier: 'A',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: true, spawnable_cli: false, inbox: false },
    prompt_delivery: { methods: ['inbox_structured'], preferred: 'inbox_structured' },
    execution_env: { surface: 'ide' },
  },
  windsurf: {
    name: 'windsurf', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: false, hasSkills: true, hasRules: true,
    instructionFile: '.windsurfrules', sharedInstructionFile: true, mcpConfigScope: 'machine', templateTier: 'A',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: true, spawnable_cli: false, inbox: false },
    prompt_delivery: { methods: ['inbox_structured'], preferred: 'inbox_structured' },
    execution_env: { surface: 'ide' },
  },
  cline: {
    name: 'cline', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: true, hasSkills: true, hasRules: true,
    instructionFile: '.clinerules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'project', templateTier: 'A',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: true, spawnable_cli: true, inbox: true },
    prompt_delivery: { methods: ['inline_arg', 'inbox_structured'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'extension' },
    invoke_template: 'cline "{prompt}"',
    invoke_binary: 'cline',
    invoke_review_template: 'cline "{prompt}"',
  },
  roo: {
    name: 'roo', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: true, hasSkills: false, hasRules: true,
    instructionFile: '.roo/rules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'project', templateTier: 'B',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: false, spawnable_cli: false, inbox: true },
    prompt_delivery: { methods: ['inbox_structured'], preferred: 'inbox_structured' },
    execution_env: { surface: 'extension' },
  },
  continue: {
    name: 'continue', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: true,
    instructionFile: '.continue/rules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'both', templateTier: 'B',
    role_capabilities: ['execute', 'consult'],
    runtime: { mcp_direct: true, hooks: false, spawnable_cli: false, inbox: false },
    prompt_delivery: { methods: ['inbox_structured'], preferred: 'inbox_structured' },
    execution_env: { surface: 'extension' },
  },
  opencode: {
    name: 'opencode', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: true,
    instructionFile: 'AGENTS.md', sharedInstructionFile: true, mcpConfigScope: 'project', templateTier: 'B',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: false, spawnable_cli: true, inbox: false },
    prompt_delivery: { methods: ['inline_arg', 'temp_file'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'opencode run "{prompt}"',
    invoke_binary: 'opencode',
    invoke_review_template: 'opencode run "{prompt}"',
  },
  codex: {
    name: 'codex', category: 'code-agent', workflowModel: 'task-based',
    hasMcp: true, hasHooks: true, hasAutoApprove: false, hasSkills: true, hasRules: true,
    instructionFile: 'AGENTS.md', sharedInstructionFile: true, mcpConfigScope: 'machine', templateTier: 'A',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: true, spawnable_cli: true, inbox: true },
    prompt_delivery: { methods: ['stdin_pipe', 'temp_file'], preferred: 'stdin_pipe' },
    execution_env: { surface: 'cli' },
    invoke_template: 'codex exec --full-auto "{prompt}"',
    invoke_binary: 'codex',
    invoke_review_template: 'codex exec --full-auto "{prompt}"',
  },
  antigravity: {
    name: 'antigravity', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: true,
    instructionFile: 'GEMINI.md', sharedInstructionFile: true, mcpConfigScope: 'machine', templateTier: 'B',
    role_capabilities: ['execute', 'consult'],
    runtime: { mcp_direct: true, hooks: false, spawnable_cli: true, inbox: false },
    prompt_delivery: { methods: ['inline_arg'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'gemini -p "{prompt}"',
    invoke_binary: 'gemini',
    invoke_review_template: 'gemini -p "{prompt}"',
  },
  'github-copilot': {
    name: 'github-copilot', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: false, hasSkills: true, hasRules: true,
    instructionFile: '.github/copilot-instructions.md', sharedInstructionFile: true, mcpConfigScope: 'project', templateTier: 'A',
    role_capabilities: ['execute', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: true, spawnable_cli: true, inbox: false },
    prompt_delivery: { methods: ['inline_arg'], preferred: 'inline_arg', max_inline_length: 4000 },
    execution_env: { surface: 'extension' },
    invoke_template: 'gh copilot -p "{prompt}"',
    invoke_binary: 'gh',
    invoke_review_template: 'gh copilot -p "{prompt}"',
  },

  // --- Autonomous agents (headless, task-based or scheduled) ---
  openclaw: {
    name: 'openclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/openclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'machine', templateTier: 'B',
    role_capabilities: ['execute', 'coordinate'],
    runtime: { mcp_direct: true, hooks: false, spawnable_cli: true, inbox: true },
    prompt_delivery: { methods: ['temp_file', 'inbox_structured'], preferred: 'temp_file' },
    execution_env: { surface: 'cli' },
  },
  nanoclaw: {
    name: 'nanoclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/nanoclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, spawnable_cli: true, inbox: false },
    prompt_delivery: { methods: ['inline_arg', 'stdin_pipe'], preferred: 'inline_arg', max_inline_length: 2000 },
    execution_env: { surface: 'cli' },
  },
  nemoclaw: {
    name: 'nemoclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/nemoclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, spawnable_cli: true, inbox: false },
    prompt_delivery: { methods: ['inline_arg', 'stdin_pipe'], preferred: 'inline_arg', max_inline_length: 2000 },
    execution_env: { surface: 'cli' },
  },
  picoclaw: {
    name: 'picoclaw', category: 'autonomous-agent', workflowModel: 'scheduled',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/picoclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, spawnable_cli: true, inbox: false },
    prompt_delivery: { methods: ['inline_arg'], preferred: 'inline_arg', max_inline_length: 1000 },
    execution_env: { surface: 'cli' },
  },
  zeroclaw: {
    name: 'zeroclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/zeroclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, spawnable_cli: true, inbox: false },
    prompt_delivery: { methods: ['inline_arg', 'stdin_pipe'], preferred: 'stdin_pipe', max_inline_length: 1000 },
    execution_env: { surface: 'cli' },
  },
};

/**
 * Default capability profiles for all known brainclaw-supported agents.
 * Use `registerCapabilityProfile` to add custom agent profiles at runtime.
 */
export const DEFAULT_CAPABILITY_PROFILES: Readonly<Record<AgentName, AgentCapabilityProfile>> = PROFILES;

// ── Custom profile registry (for user-defined / custom agents) ─────────────

const _customProfiles = new Map<string, AgentCapabilityProfile>();

/**
 * Register a custom agent capability profile at runtime.
 * Custom profiles take precedence over DEFAULT_CAPABILITY_PROFILES on lookup.
 */
export function registerCapabilityProfile(profile: AgentCapabilityProfile): void {
  _customProfiles.set(profile.name, profile);
}

/**
 * Get the capability profile for an agent by name.
 * Checks custom registry first, then DEFAULT_CAPABILITY_PROFILES.
 * Returns undefined for completely unknown agents.
 */
export function getCapabilityProfile(name: string): AgentCapabilityProfile | undefined {
  return _customProfiles.get(name) ?? PROFILES[name as AgentName];
}

// ── Default invoke templates for CLI-spawnable agents ──────────────────────

export type InvokeMode = 'worker' | 'reviewer' | 'consult';

export interface DefaultInvokeTemplate {
  command: string;
  channel: 'spawn' | 'inbox';
  timeout: number;
  /** Binary that must be in PATH for this template to work */
  binary: string;
  /** Mode this template was resolved for */
  mode: InvokeMode;
}

/**
 * Get the default invoke template for an agent.
 * Reads invoke_template / invoke_binary from the capability profile.
 * Mode selects the appropriate template variant with fallback chain:
 *   - 'worker' (default): invoke_template
 *   - 'reviewer': invoke_review_template → invoke_template
 *   - 'consult': invoke_consult_template → invoke_review_template → invoke_template
 * Returns undefined for IDE-only agents or unknown agents without a CLI template.
 */
export function getDefaultInvokeTemplate(name: string, mode: InvokeMode = 'worker'): DefaultInvokeTemplate | undefined {
  const profile = getCapabilityProfile(name);
  if (!profile?.invoke_template || !profile?.invoke_binary) return undefined;

  let command: string;
  switch (mode) {
    case 'consult':
      command = profile.invoke_consult_template ?? profile.invoke_review_template ?? profile.invoke_template;
      break;
    case 'reviewer':
      command = profile.invoke_review_template ?? profile.invoke_template;
      break;
    default:
      command = profile.invoke_template;
  }

  return {
    command,
    channel: 'spawn',
    timeout: 600,
    binary: profile.invoke_binary,
    mode,
  };
}

/**
 * Get all agents (known + custom) that have an invoke template (CLI-spawnable).
 */
export function getSpawnableAgents(): Array<{ name: string; template: DefaultInvokeTemplate }> {
  const result: Array<{ name: string; template: DefaultInvokeTemplate }> = [];

  const allProfiles: AgentCapabilityProfile[] = [
    ...Object.values(PROFILES),
    ..._customProfiles.values(),
  ];

  for (const profile of allProfiles) {
    if (profile.runtime.spawnable_cli && profile.invoke_template && profile.invoke_binary) {
      result.push({
        name: profile.name,
        template: {
          command: profile.invoke_template,
          channel: 'spawn',
          timeout: 600,
          binary: profile.invoke_binary,
          mode: 'worker',
        },
      });
    }
  }

  return result;
}

/**
 * Get the capability profile for a known agent.
 * Returns undefined for unknown agent names.
 * @deprecated Prefer getCapabilityProfile — supports custom agents too.
 */
export function getAgentCapabilityProfile(name: string): AgentCapabilityProfile | undefined {
  return getCapabilityProfile(name);
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
  const profile = getCapabilityProfile(name);
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
