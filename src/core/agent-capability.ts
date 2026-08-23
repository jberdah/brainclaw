/**
 * Agent capability profiles — describes what integration surfaces each
 * agent supports so brainclaw can adapt its instruction file content,
 * integration depth, and pressure level accordingly.
 *
 * Three profile tiers drive instruction file templates:
 *   A (full)      — managed MCP/native surfaces → lightweight instructions
 *   B (standard)  — MCP with fewer automation surfaces → more directive rules
 *   C (limited)   — no MCP → rich static content (plans, traps, decisions)
 *
 * Hook support is declared separately through `hasHooks` and `runtime.hooks`.
 * Do not infer hooks from `templateTier`.
 */

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
    /** Can be spawned as a CLI subprocess by the dispatcher */
    canBeSpawnedCli: boolean;
    /** Can spawn other agents as CLI subprocesses (coordinator/spawner capability) */
    canSpawnOtherCli: boolean;
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
  /**
   * Max concurrent task instances this agent can run in a single project.
   * - 1 (default): single instance (IDE agents, Copilot)
   * - N > 1: agent supports N parallel instances with separate worktrees (CLI agents)
   * Structurelle capacity — the dispatcher computes dynamic availability at runtime
   * as: slots_remaining = max_concurrent_tasks - active_claims_in_project.
   */
  max_concurrent_tasks: number;
  /** CLI invoke template (uses {prompt} placeholder). Undefined = not CLI-spawnable */
  invoke_template?: string;
  /** Binary that must be in PATH for invoke_template */
  invoke_binary?: string;
  /** CLI invoke template for review mode (read-only tools). Falls back to invoke_template */
  invoke_review_template?: string;
  /** CLI invoke template for consult mode (read-only, advisory). Falls back to invoke_review_template or invoke_template */
  invoke_consult_template?: string;
  /**
   * pln#520 step 3 — flag this binary uses to select a model (e.g. `--model`).
   * When set, a resolved model is injected into the parsed invoke template so
   * model choice is decoupled from agent identity (run `claude-code` with any
   * model instead of needing a per-model pseudo-identity like `claude-sonnet`).
   * Unset → the agent ignores model selection (model baked into its template).
   */
  model_flag?: string;
  /**
   * Parsed-token index where `<model_flag> <model>` should be inserted.
   * Defaults to 1 (right after the binary). Set this for CLIs whose model flag
   * belongs after a subcommand, e.g. `codex exec --model <model>`.
   */
  model_flag_insert_index?: number;
  /** Default model for this agent, last link in the model resolution chain. */
  default_model?: string;
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
  | 'kilocode'
  | 'mistral-vibe'
  | 'hermes'
  | 'openclaw'
  | 'nanoclaw'
  | 'nemoclaw'
  | 'picoclaw'
  | 'zeroclaw'
  | 'claude-sonnet';

/** Agent name aliases — maps common short names to canonical profile names. */
const AGENT_ALIASES: Record<string, AgentName> = {
  'copilot': 'github-copilot',
  'gh-copilot': 'github-copilot',
  'gemini': 'antigravity',
  'mistral': 'mistral-vibe',
  'vibe': 'mistral-vibe',
  'hermes-agent': 'hermes',
};

/**
 * Resolve an alias to its canonical agent name (case-insensitive).
 *
 * Agent names are case-insensitive: every canonical profile key and every alias
 * is lowercase, so we trim + lowercase the input before resolving. This is the
 * single normalization point — registry, messaging, spawn-check and the
 * coordinate/dispatch pre-flight all route through here, so a target like
 * "Codex" or "Gemini" resolves identically to "codex" / "gemini". Without it the
 * dispatch pre-flight collapsed an unresolved name into "no CLI spawn template
 * (IDE-only?)" and silently dropped the reviewer (github-copilot/Gemini hit this
 * passing targetAgents=["Codex"]).
 */
export function resolveAgentAlias(name: string): string {
  const key = name.trim().toLowerCase();
  return AGENT_ALIASES[key] ?? key;
}

const PROFILES: Record<AgentName, AgentCapabilityProfile> = {
  // --- Code agents (interactive, IDE-driven) ---
  'claude-code': {
    name: 'claude-code', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: true, hasSkills: true, hasRules: true,
    instructionFile: 'CLAUDE.md', sharedInstructionFile: true, mcpConfigScope: 'both', templateTier: 'A',
    role_capabilities: ['execute', 'coordinate', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: true, canBeSpawnedCli: true, canSpawnOtherCli: true, inbox: true },
    max_concurrent_tasks: 3,
    // Claude CLI: -p is a flag (print mode), prompt is positional or via stdin.
    // Use stdin_pipe to avoid shell quoting issues with long prompts.
    prompt_delivery: { methods: ['stdin_pipe', 'inline_arg', 'inbox_structured'], preferred: 'stdin_pipe', max_inline_length: 4000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'claude -p --allowedTools "Edit,Write,Bash,Read,Glob,Grep" {prompt}',
    invoke_binary: 'claude',
    invoke_review_template: 'claude -p --allowedTools "Read,Glob,Grep" {prompt}',
    invoke_consult_template: 'claude -p --allowedTools "Read,Glob,Grep" {prompt}',
    // pln#520 step 3: model is selectable via `--model` — no need for a
    // per-model pseudo-identity. `claude-sonnet` below is now redundant
    // (run `claude-code --model sonnet`) and kept only for back-compat.
    model_flag: '--model',
  },
  'claude-sonnet': {
    name: 'claude-sonnet', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: true, hasSkills: true, hasRules: true,
    instructionFile: 'CLAUDE.md', sharedInstructionFile: true, mcpConfigScope: 'both', templateTier: 'A',
    role_capabilities: ['execute', 'coordinate', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: true, canBeSpawnedCli: true, canSpawnOtherCli: true, inbox: true },
    max_concurrent_tasks: 6,
    prompt_delivery: { methods: ['stdin_pipe', 'inline_arg', 'inbox_structured'], preferred: 'stdin_pipe', max_inline_length: 4000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'claude --model sonnet -p --allowedTools "Edit,Write,Bash,Read,Glob,Grep" {prompt}',
    invoke_binary: 'claude',
    invoke_review_template: 'claude --model sonnet -p --allowedTools "Read,Glob,Grep" {prompt}',
    invoke_consult_template: 'claude --model sonnet -p --allowedTools "Read,Glob,Grep" {prompt}',
  },
  cursor: {
    name: 'cursor', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: true, hasAutoApprove: false, hasSkills: true, hasRules: true,
    instructionFile: '.cursor/rules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'machine', templateTier: 'A',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: true, canBeSpawnedCli: false, canSpawnOtherCli: false, inbox: false },
    prompt_delivery: { methods: ['inbox_structured'], preferred: 'inbox_structured' },
    max_concurrent_tasks: 1,
    execution_env: { surface: 'ide' },
  },
  windsurf: {
    name: 'windsurf', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: true,
    instructionFile: '.windsurfrules', sharedInstructionFile: true, mcpConfigScope: 'machine', templateTier: 'A',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: false, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 1,
    prompt_delivery: { methods: ['inbox_structured'], preferred: 'inbox_structured' },
    execution_env: { surface: 'ide' },
  },
  cline: {
    name: 'cline', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: true, hasSkills: false, hasRules: true,
    instructionFile: '.clinerules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'project', templateTier: 'A',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: true },
    max_concurrent_tasks: 3,
    prompt_delivery: { methods: ['inline_arg', 'inbox_structured'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'extension' },
    invoke_template: 'cline -y "{prompt}"',
    invoke_binary: 'cline',
    invoke_review_template: 'cline -y "{prompt}"',
  },
  roo: {
    name: 'roo', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: true, hasSkills: false, hasRules: true,
    instructionFile: '.roo/rules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'project', templateTier: 'B',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: true },
    max_concurrent_tasks: 2,
    prompt_delivery: { methods: ['inline_arg', 'inbox_structured'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'extension' },
    invoke_template: 'roo -y "{prompt}"',
    invoke_binary: 'roo',
    invoke_review_template: 'roo -y "{prompt}"',
  },
  continue: {
    name: 'continue', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: true,
    instructionFile: '.continue/rules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'both', templateTier: 'B',
    role_capabilities: ['execute', 'consult'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 2,
    prompt_delivery: { methods: ['inline_arg', 'inbox_structured'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'extension' },
    invoke_template: 'cn --auto "{prompt}"',
    invoke_binary: 'cn',
    invoke_review_template: 'cn --auto --readonly "{prompt}"',
  },
  opencode: {
    name: 'opencode', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: true,
    instructionFile: 'AGENTS.md', sharedInstructionFile: true, mcpConfigScope: 'project', templateTier: 'B',
    role_capabilities: ['execute', 'review'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 2,
    prompt_delivery: { methods: ['inline_arg', 'temp_file'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'opencode "{prompt}"',
    invoke_binary: 'opencode',
    invoke_review_template: 'opencode "{prompt}"',
  },
  // Sandbox note (CORRECTED — dec#133, empirical probe codex 0.144.4, 2026-07-18):
  // the earlier belief that `--sandbox workspace-write` blocks brainclaw MCP was
  // FALSE and never re-verified. The MCP server runs as a SEPARATE process outside
  // the sandbox, and `approval_policy=never` (baked into the invoke template below)
  // auto-approves every tool call in headless mode — so MCP reads/writes are
  // reachable from a sandboxed codex run. The REAL residual constraint is `git
  // commit`: the sandbox root excludes `.git`, so the coordinator commits the
  // worktree diff at harvest time (see dispatchCanCommit / harvest.ts). Candidates
  // can still be dropped as filesystem JSON as a fallback, but MCP is not the
  // blocker.
  codex: {
    name: 'codex', category: 'code-agent', workflowModel: 'task-based',
    // hooks: Codex gained a native lifecycle hook surface (SessionStart /
    // UserPromptSubmit / Stop / PreToolUse / … via .codex/hooks.json or [hooks]
    // in config.toml; developers.openai.com/codex/hooks, verified 2026-07 —
    // trp_fe75dafc). brainclaw writes .codex/hooks.json (ensureCodexHooks),
    // giving Codex the same session-lifecycle wiring as Claude Code.
    hasMcp: true, hasHooks: true, hasAutoApprove: false, hasSkills: true, hasRules: true,
    instructionFile: 'AGENTS.md', sharedInstructionFile: true, mcpConfigScope: 'machine', templateTier: 'A',
    role_capabilities: ['execute', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: true, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: true },
    max_concurrent_tasks: 5,
    // pln#475: prefer stdin_pipe to avoid Windows cmd.exe arg-parsing breaking
    // long prompts. codex.cmd resolves through cmd shell, where embedded
    // backticks/`#` chars made codex CLI raise "unexpected argument" (trp#59).
    // Codex CLI reads stdin when the [PROMPT] arg is omitted (`codex exec`
    // with no positional). The execution adapter pipes promptText to stdin.
    // inline_arg stays as a fallback for short prompts on POSIX.
    prompt_delivery: { methods: ['stdin_pipe', 'inline_arg'], preferred: 'stdin_pipe' },
    execution_env: { surface: 'cli' },
    invoke_template: 'codex exec -c approval_policy="never" --sandbox workspace-write "{prompt}"',
    invoke_binary: 'codex',
    // Review runs need shell access for git/grep/rg and filesystem reads of
    // the whole repo. Older templates forced --sandbox read-only on reviews,
    // but that blocks PowerShell exec on Windows and forced reviewers to
    // fall back to GitHub connectors — which fail for local-only commits.
    // Aligning with the regular spawn template (workspace-write) is the
    // accepted pattern per agent_spawn_inventory memory.
    invoke_review_template: 'codex exec -c approval_policy="never" --sandbox workspace-write "{prompt}"',
    // pln#606: `codex exec -m <MODEL>` / `--model` (verified empirically on
    // codex 0.130). We use the long form `--model` for symmetry with the
    // other agent profiles and readability.
    model_flag: '--model',
    model_flag_insert_index: 2,
  },
  antigravity: {
    name: 'antigravity', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: true,
    instructionFile: 'GEMINI.md', sharedInstructionFile: true, mcpConfigScope: 'machine', templateTier: 'B',
    role_capabilities: ['execute', 'consult'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 2,
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
    // Copilot CLI 1.0.35+ supports headless spawn via --allow-all + --no-ask-user and
    // per-session MCP via --additional-mcp-config (validated spike pln#440, 2026-04-24
    // on Windows: non-interactive prompt, file write, and MCP bclaw_create write path).
    role_capabilities: ['execute', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: true, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: true },
    max_concurrent_tasks: 1,
    prompt_delivery: { methods: ['inline_arg', 'inbox_structured'], preferred: 'inline_arg', max_inline_length: 4000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'copilot -p "{prompt}" --allow-all --no-ask-user',
    invoke_binary: 'copilot',
    invoke_review_template: 'copilot -p "{prompt}" --allow-all --no-ask-user',
    // pln#606: `copilot --model <model>` (verified on Copilot CLI 1.0.35+).
    // 'auto' lets Copilot pick automatically; concrete ids come from the
    // entitled catalog fetched by the CLI at startup.
    model_flag: '--model',
  },

  kilocode: {
    name: 'kilocode', category: 'code-agent', workflowModel: 'interactive',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: true,
    instructionFile: '.kilo/rules/brainclaw.md', sharedInstructionFile: false, mcpConfigScope: 'project', templateTier: 'B',
    role_capabilities: ['execute', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 2,
    prompt_delivery: { methods: ['inline_arg', 'temp_file'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'kilo run --auto "{prompt}"',
    invoke_binary: 'kilo',
    invoke_review_template: 'kilo run --auto "{prompt}"',
    invoke_consult_template: 'kilo run --auto "{prompt}"',
  },

  // Mistral Vibe (pln#489) — Tier B: MCP via TOML config + skills + CLI spawn,
  // but no hooks (BeforePrompt feature request #531 still open) and no native
  // rules file equivalent to CLAUDE.md. Reuses AGENTS.md as the static
  // instruction surface and the universal .agents/skills/brainclaw/SKILL.md
  // for skill discovery (auto-discovered by Mistral Vibe alongside .vibe/skills/).
  // Strategic value: EU/FR data sovereignty (Mistral Paris-based, not subject
  // to US CLOUD Act; Apache 2.0 open-source CLI; open-weight models). Caveats:
  // CLI freezes documented on current version, Windows Git Bash unsupported
  // (issue #135), max_concurrent_tasks set conservatively to 2.
  'mistral-vibe': {
    name: 'mistral-vibe', category: 'code-agent', workflowModel: 'task-based',
    hasMcp: true, hasHooks: false, hasAutoApprove: true, hasSkills: true, hasRules: false,
    instructionFile: 'AGENTS.md', sharedInstructionFile: true, mcpConfigScope: 'both', templateTier: 'B',
    role_capabilities: ['execute', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 2,
    prompt_delivery: { methods: ['inline_arg', 'stdin_pipe'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'vibe --prompt "{prompt}" --auto-approve --max-turns 5',
    invoke_binary: 'vibe',
    invoke_review_template: 'vibe --prompt "{prompt}" --auto-approve --max-turns 5',
    invoke_consult_template: 'vibe --prompt "{prompt}" --auto-approve --max-turns 3',
  },

  // Hermes Agent (Nous Research) — autonomous, skills-first agent with native
  // MCP client support via ~/.hermes/config.yaml. Brainclaw uses Hermes as a
  // Tier B surface for now: MCP + universal .agents/skills/ skill, no native
  // Brainclaw hooks until a dedicated Hermes plugin is shipped and validated.
  hermes: {
    name: 'hermes', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'AGENTS.md', sharedInstructionFile: true, mcpConfigScope: 'machine', templateTier: 'B',
    role_capabilities: ['execute', 'review', 'consult'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 1,
    prompt_delivery: { methods: ['inline_arg', 'temp_file'], preferred: 'inline_arg', max_inline_length: 8000 },
    execution_env: { surface: 'cli' },
    invoke_template: 'hermes chat -q "{prompt}"',
    invoke_binary: 'hermes',
    invoke_review_template: 'hermes chat -q "{prompt}"',
    invoke_consult_template: 'hermes chat -q "{prompt}"',
  },

  // --- Autonomous agents (headless, task-based or scheduled) ---
  openclaw: {
    name: 'openclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: true, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/openclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'machine', templateTier: 'B',
    role_capabilities: ['execute', 'coordinate'],
    runtime: { mcp_direct: true, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: true, inbox: true },
    max_concurrent_tasks: 1,
    prompt_delivery: { methods: ['temp_file', 'inbox_structured'], preferred: 'temp_file' },
    execution_env: { surface: 'cli' },
    invoke_template: 'openclaw run --auto "{prompt}"',
    invoke_binary: 'openclaw',
  },
  nanoclaw: {
    name: 'nanoclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/nanoclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 1,
    prompt_delivery: { methods: ['inline_arg', 'stdin_pipe'], preferred: 'inline_arg', max_inline_length: 2000 },
    execution_env: { surface: 'cli' },
  },
  nemoclaw: {
    name: 'nemoclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/nemoclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 1,
    prompt_delivery: { methods: ['inline_arg', 'stdin_pipe'], preferred: 'inline_arg', max_inline_length: 2000 },
    execution_env: { surface: 'cli' },
  },
  picoclaw: {
    name: 'picoclaw', category: 'autonomous-agent', workflowModel: 'scheduled',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/picoclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 1,
    prompt_delivery: { methods: ['inline_arg'], preferred: 'inline_arg', max_inline_length: 1000 },
    execution_env: { surface: 'cli' },
  },
  zeroclaw: {
    name: 'zeroclaw', category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: true, hasRules: false,
    instructionFile: 'skills/zeroclaw/SKILL.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: false },
    max_concurrent_tasks: 1,
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
  // Key by the normalized (lowercased) name so lookups through the
  // case-insensitive resolveAgentAlias match regardless of the casing the
  // registrant used.
  _customProfiles.set(profile.name.trim().toLowerCase(), profile);
}

/**
 * Get the capability profile for an agent by name.
 * Checks custom registry first, then DEFAULT_CAPABILITY_PROFILES.
 * Returns undefined for completely unknown agents.
 */
export function getCapabilityProfile(name: string): AgentCapabilityProfile | undefined {
  const resolved = resolveAgentAlias(name);
  return _customProfiles.get(resolved) ?? PROFILES[resolved as AgentName];
}

/**
 * pln#520 step 3 — concurrency is a resolvable execution-config value, NOT a
 * structural constant baked into agent identity.
 *
 * The host resource a concurrency cap actually protects is the binary on the
 * machine (its API quota / its RAM/CPU footprint), not the agent label.
 * `resolveResourceKey` returns that shared key so callers count usage across
 * every identity that drives one binary. This kills the can_dc4e4a11 bug:
 * `claude-code` and `claude-sonnet` are the SAME `claude` binary on the SAME
 * host but were counted separately (3 + 6 → up to 9 concurrent `claude`
 * processes, oversubscribing the machine + API).
 */
export function resolveResourceKey(name: string): string {
  const profile = getCapabilityProfile(name);
  return profile?.invoke_binary ?? resolveAgentAlias(name);
}

/**
 * Resolve the concurrency limit for an agent. `Infinity` = unlimited.
 *
 * Resolution chain (highest priority first), decoupled from agent identity:
 *   1. explicit `override` (e.g. `brainclaw dispatch --max-concurrency N`)
 *   2. host opt-in cap via `BRAINCLAW_MAX_CONCURRENCY` (protect one machine / quota)
 *   3. structural floor — agents that cannot run headless in parallel
 *      (IDE / desktop agents, i.e. not CLI-spawnable) stay hard-capped at their
 *      profile `max_concurrent_tasks` (you can't spawn N IDE windows headlessly)
 *   4. default for parallelizable CLI agents: UNLIMITED. There is no arbitrary
 *      per-identity throttle — the operator opts into a cap when they want one.
 *
 * When a finite cap applies it is enforced per host-binary resource
 * (see `resolveResourceKey`), so all variants of one binary share the pool.
 */
export function resolveConcurrencyLimit(name: string, opts: { override?: number } = {}): number {
  if (opts.override !== undefined && opts.override > 0) return opts.override;
  const envCap = Number(process.env.BRAINCLAW_MAX_CONCURRENCY);
  if (Number.isFinite(envCap) && envCap > 0) return envCap;
  const profile = getCapabilityProfile(name);
  if (!profile?.runtime?.canBeSpawnedCli) return profile?.max_concurrent_tasks ?? 1;
  return Infinity;
}

/** JSON-safe rendering of a concurrency limit: `Infinity` → `null` (= unlimited). */
export function serializeConcurrencyLimit(limit: number): number | null {
  return Number.isFinite(limit) ? limit : null;
}

/**
 * pln#520 step 3 — resolve the model for a dispatch, decoupled from agent
 * identity. Chain (highest priority first): explicit override (e.g.
 * `dispatch --model`) → lane model → identity model → profile default.
 * Returns `undefined` when nothing in the chain specifies one (the agent's
 * template default applies).
 */
export function resolveModel(
  name: string,
  opts: { override?: string; lane?: string; identity?: string } = {},
): string | undefined {
  const profile = getCapabilityProfile(name);
  return opts.override ?? opts.lane ?? opts.identity ?? profile?.default_model;
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

// ── Structured invoke command ──────────────────────────────────────────────

/**
 * A fully-resolved, ready-to-run command object for spawning an agent.
 * Returned by `buildInvokeCommand`.
 */
export interface InvokeCommand {
  /** The executable to run */
  executable: string;
  /** Arguments array (prompt already interpolated) */
  args: string[];
  /** How the prompt is delivered */
  promptDelivery: 'inline_arg' | 'temp_file' | 'stdin_pipe';
  /** Whether to run in a shell */
  shell: boolean;
  /** The complete bash command as a string (ready to copy-paste or run_in_background) */
  bashCommand: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Original prompt text — needed by executeDispatchedCommand to write temp files or pipe stdin */
  promptText?: string;
  /** Temp file path for temp_file delivery — executeDispatchedCommand writes promptText here before spawning */
  tempFilePath?: string;
}

export interface BuildInvokeCommandOptions {
  /** Which invoke mode to resolve (default: 'worker') */
  mode?: InvokeMode;
  /**
   * Platform override for platform-aware quoting.
   * Defaults to `process.platform`. Pass 'win32' to force Windows quoting.
   */
  platform?: NodeJS.Platform;
  /**
   * When promptDelivery is 'temp_file', this path is substituted instead
   * of `{prompt}`. The caller is responsible for writing the file.
   * Defaults to a deterministic placeholder `/tmp/bclaw_prompt_<hash>.md`.
   */
  tempFilePath?: string;
  /**
   * pln#520 step 3 — model to run, decoupled from agent identity. Injected as
   * `<profile.model_flag> <model>` at the profile's model insertion point when
   * the profile declares a `model_flag` and the template doesn't already pin a
   * model.
   */
  model?: string;
}

/**
 * Escape a string for safe use as a double-quoted shell argument.
 * Escapes characters that have special meaning inside double-quotes
 * on the target platform.
 */
function escapeForDoubleQuote(s: string, isWin32: boolean): string {
  if (isWin32) {
    // On Windows cmd/PowerShell, escape internal double-quotes by doubling them.
    return s.replace(/"/g, '""');
  }
  // On POSIX shells, escape backslash, dollar, backtick, and double-quote.
  return s.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/"/g, '\\"');
}

/**
 * Build a complete shell argument string for embedding inside double-quotes.
 * Returns the string wrapped in double-quotes.
 */
function quoteArg(s: string, isWin32: boolean): string {
  return `"${escapeForDoubleQuote(s, isWin32)}"`;
}

/**
 * Generate a short, stable filename suffix from an arbitrary string.
 * Uses a simple djb2-style hash — no crypto dependency needed.
 */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Parse a raw template string (e.g. `claude -p "{prompt}" --allowedTools "..."`)
 * into [executable, ...rawArgs], keeping the `{prompt}` token as-is.
 *
 * This is a simple shell-word splitter that handles:
 *   - unquoted tokens
 *   - double-quoted tokens (with \" escapes)
 *   - single-quoted tokens (no escape processing)
 * It does NOT handle variable expansion, redirections, or compound commands.
 */
function parseTemplateString(template: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = template.length;

  while (i < len) {
    // Skip whitespace between tokens
    while (i < len && /\s/.test(template[i])) i++;
    if (i >= len) break;

    let token = '';
    while (i < len && !/\s/.test(template[i])) {
      const ch = template[i];

      if (ch === '"') {
        // Consume double-quoted segment
        i++;
        while (i < len && template[i] !== '"') {
          if (template[i] === '\\' && i + 1 < len) {
            i++; // skip backslash, keep next char literal
          }
          token += template[i];
          i++;
        }
        if (i < len) i++; // consume closing "
      } else if (ch === "'") {
        // Consume single-quoted segment (no escaping)
        i++;
        while (i < len && template[i] !== "'") {
          token += template[i];
          i++;
        }
        if (i < len) i++; // consume closing '
      } else {
        token += ch;
        i++;
      }
    }

    if (token.length > 0) tokens.push(token);
  }

  return tokens;
}

/**
 * Build a structured, ready-to-run invoke command for an agent.
 *
 * Resolution order:
 *   1. Look up profile via `getCapabilityProfile`.
 *   2. Return undefined if the agent has no CLI invoke template.
 *   3. Apply mode fallback chain (same as `getDefaultInvokeTemplate`).
 *   4. Determine prompt delivery method:
 *      - If `prompt_delivery.preferred` is 'temp_file' OR prompt exceeds
 *        `max_inline_length`, use 'temp_file'.
 *      - If `prompt_delivery.preferred` is 'stdin_pipe', use 'stdin_pipe'.
 *      - Otherwise use 'inline_arg'.
 *   5. Parse the resolved template into [executable, ...args].
 *   6. Interpolate `{prompt}` token in the args list.
 *   7. Build a platform-aware `bashCommand` string.
 *
 * @param name    Agent name (matches AgentName or custom profile name).
 * @param prompt  The actual prompt text to deliver to the agent.
 * @param options Optional overrides for mode, platform, and temp file path.
 * @returns Structured InvokeCommand, or undefined if the agent is not CLI-spawnable.
 */
export function buildInvokeCommand(
  name: string,
  prompt: string,
  options: BuildInvokeCommandOptions = {},
): InvokeCommand | undefined {
  const profile = getCapabilityProfile(name);
  if (!profile?.invoke_template || !profile?.invoke_binary) return undefined;
  if (!profile.runtime.canBeSpawnedCli) return undefined;

  const mode: InvokeMode = options.mode ?? 'worker';
  const isWin32 = (options.platform ?? process.platform) === 'win32';

  // ── 1. Resolve the template string using the mode fallback chain ──────────
  let templateStr: string;
  switch (mode) {
    case 'consult':
      templateStr =
        profile.invoke_consult_template ??
        profile.invoke_review_template ??
        profile.invoke_template;
      break;
    case 'reviewer':
      templateStr = profile.invoke_review_template ?? profile.invoke_template;
      break;
    default:
      templateStr = profile.invoke_template;
  }

  // ── 2. Determine prompt delivery method ──────────────────────────────────
  const preferredDelivery = profile.prompt_delivery.preferred;
  const maxInline = profile.prompt_delivery.max_inline_length;

  let promptDelivery: 'inline_arg' | 'temp_file' | 'stdin_pipe';

  if (preferredDelivery === 'stdin_pipe') {
    promptDelivery = 'stdin_pipe';
  } else if (
    preferredDelivery === 'temp_file' ||
    (maxInline !== undefined && prompt.length > maxInline)
  ) {
    promptDelivery = 'temp_file';
  } else {
    promptDelivery = 'inline_arg';
  }

  // ── 3. Resolve the prompt value to embed in the command ──────────────────
  let embeddedPrompt: string;
  let tempFilePath: string | undefined;

  if (promptDelivery === 'temp_file') {
    tempFilePath =
      options.tempFilePath ??
      path.join(os.tmpdir(), `bclaw_prompt_${shortHash(prompt)}.md`);
    embeddedPrompt = tempFilePath;
  } else if (promptDelivery === 'stdin_pipe') {
    // stdin_pipe: the {prompt} placeholder in the template (if present) is
    // replaced with an empty string; the actual prompt is piped via stdin.
    embeddedPrompt = '';
  } else {
    embeddedPrompt = prompt;
  }

  // ── 4. Parse the template and interpolate {prompt} ───────────────────────
  const rawTokens = parseTemplateString(templateStr);
  if (rawTokens.length === 0) return undefined;

  // pln#520 step 3: inject the resolved model at the profile's model argument
  // position so model choice is decoupled from agent identity. Only when the
  // profile declares a `model_flag` and the template doesn't already pin a model
  // (don't double it).
  if (options.model && profile.model_flag && !rawTokens.includes(profile.model_flag)) {
    const insertIndex = Math.min(
      Math.max(profile.model_flag_insert_index ?? 1, 1),
      rawTokens.length,
    );
    rawTokens.splice(insertIndex, 0, profile.model_flag, options.model);
  }

  const executable = rawTokens[0];
  const interpolatedTokens = rawTokens.slice(1).map((tok) =>
    tok === '{prompt}' ? embeddedPrompt : tok,
  );

  // ── 5. Build the args array ───────────────────────────────────────────────
  // The args are the interpolated values; they are passed to execFile/spawn
  // without further shell quoting. The bashCommand is built separately.
  // Filter out empty strings from stdin_pipe delivery where {prompt} resolves to ''.
  const args = interpolatedTokens.filter((tok) => tok !== '');

  // ── 6. Build the platform-aware bashCommand string ───────────────────────
  //
  // Strategy:
  //   - For 'inline_arg': embed the prompt inline, double-quoted.
  //   - For 'temp_file' on POSIX: write prompt to temp file with `cat >`,
  //     then run the command; the {prompt} slot holds the file path.
  //   - For 'temp_file' on Windows: assume the caller has written the file;
  //     just run the command with the path. No `cat` pipes.
  //   - For 'stdin_pipe' on POSIX: use a heredoc to pipe prompt into the
  //     command via stdin.
  //   - For 'stdin_pipe' on Windows: omit stdin piping (use inbox fallback).

  let bashCommand: string;

  if (promptDelivery === 'temp_file') {
    if (isWin32) {
      // Caller writes the file; bashCommand is just the command invocation.
      const cmdParts = [executable, ...interpolatedTokens.map((t) => quoteArg(t, isWin32))];
      bashCommand = cmdParts.join(' ');
    } else {
      // POSIX: write prompt to temp file, then run command.
      const escapedPromptForHeredoc = prompt.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      const writeStep = `printf '%s' '${escapedPromptForHeredoc}' > ${tempFilePath}`;
      const cmdParts = [executable, ...interpolatedTokens.map((t) => quoteArg(t, isWin32))];
      bashCommand = `${writeStep} && ${cmdParts.join(' ')}`;
    }
  } else if (promptDelivery === 'stdin_pipe') {
    if (isWin32) {
      // Windows: no heredoc; just run the command without piping.
      const cmdParts = [executable, ...interpolatedTokens.filter(Boolean).map((t) => quoteArg(t, isWin32))];
      bashCommand = cmdParts.join(' ');
    } else {
      // POSIX: use heredoc to pipe prompt into stdin.
      const escapedPromptForHeredoc = prompt.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      const nonEmptyArgs = interpolatedTokens.filter(Boolean);
      const cmdParts = [executable, ...nonEmptyArgs.map((t) => quoteArg(t, isWin32))];
      bashCommand = `printf '%s' '${escapedPromptForHeredoc}' | ${cmdParts.join(' ')}`;
    }
  } else {
    // inline_arg: embed prompt directly, double-quoted.
    const cmdParts = rawTokens.map((tok, idx) => {
      if (idx === 0) return tok; // executable — no quoting
      return tok === '{prompt}' ? quoteArg(embeddedPrompt, isWin32) : tok;
    });
    bashCommand = cmdParts.join(' ');
  }

  return {
    executable,
    args,
    promptDelivery,
    shell: false,
    bashCommand,
    ...(tempFilePath !== undefined ? { env: { BCLAW_PROMPT_FILE: tempFilePath } } : {}),
    promptText: prompt,
    ...(tempFilePath !== undefined ? { tempFilePath } : {}),
  };
}

// ── Brief mode resolution ─────────────────────────────────────────────────

/**
 * Controls how much content is included in a dispatch brief for an agent.
 *
 * - `full`      : Complete brief — Protocol section, available tools, handoffs, context.
 *                 For CLI-spawnable agents that can call MCP (Claude Code, Cline, etc.).
 * - `compact`   : Task description + file paths + steps + constraints only.
 *                 No MCP protocol section — for task-based agents WITHOUT MCP
 *                 access (nanoclaw/nemoclaw/picoclaw/zeroclaw). NOTE: codex is
 *                 NOT compact — it is `full`, because a sandboxed codex run CAN
 *                 reach MCP (dec#133); the sandbox only makes `.git` read-only.
 * - `task_card` : Ultra-short, human-readable task card.
 *                 For IDE-only agents where a human will paste the task (Cursor, Windsurf, Roo).
 */
export type BriefMode = 'full' | 'compact' | 'task_card';

/**
 * Resolve the appropriate brief mode for an agent based on its capability profile.
 *
 * Resolution rules:
 *   1. Agent is NOT canBeSpawnedCli (IDE-only) → 'task_card'
 *   2. Agent is task-based AND has NO MCP access → 'compact'
 *      (brief skips the Protocol section because the agent cannot call
 *      bclaw_assignment_update / bclaw_release_claim anyway)
 *   3. Otherwise → 'full'
 *
 * Rule 2 was previously `workflowModel === 'task-based'` regardless of MCP
 * capability (pln#496 Phase 1.b). That forced codex (task-based + hasMcp:
 * true) onto 'compact' mode, which strips the Protocol section that
 * contains `bclaw_assignment_update(status: …)` lifecycle instructions.
 * Empirically validated 2026-05-04: every codex review in May 2026
 * silently stayed `run_running` forever because codex never received the
 * 'when done, call bclaw_assignment_update(status: completed)' line —
 * last 'successful' review (lop_950a51aef0bb8263) had assignment
 * status='offered', completed_at=null. The hasMcp check fixes this for
 * codex and mistral-vibe (both task-based + MCP) without changing
 * behaviour for genuinely MCP-less agents (nanoclaw / nemoclaw /
 * zeroclaw).
 *
 * Note: stdin_pipe as prompt delivery is an optimization used by several
 * interactive agents (claude-code, cline prefer it for long prompts) and
 * does NOT indicate a sandboxed runtime — use workflowModel as the
 * discriminator instead.
 *
 * Falls back to 'full' for unknown agents.
 */
export function resolveBriefMode(agentName: string): BriefMode {
  const profile = getCapabilityProfile(agentName);
  if (!profile) return 'full';

  if (!profile.runtime.canBeSpawnedCli) return 'task_card';
  if (profile.workflowModel === 'task-based' && !profile.hasMcp) return 'compact';
  return 'full';
}

// ── Dispatch-time capability matrix (pln#528) ──────────────────────────────

/**
 * pln#528 — capability matrix DERIVED from the spawn template, so it stays in
 * sync with how each agent is actually invoked (no per-profile duplication).
 *
 * pln#628 Focus 4A CORRECTION (dec#133, empirical probe codex 0.144.4): the
 * original pln#528 belief — that a `--sandbox` spawn "does NOT wire the brainclaw
 * MCP server" — was a FALSE premise that was never re-verified. In reality the MCP
 * server is a separate out-of-sandbox process and `approval_policy=never`
 * auto-approves every tool call, so MCP is reachable from a sandboxed run. The
 * ONE residual constraint the sandbox actually imposes is `git commit` (.git sits
 * outside the writable root). So the two capabilities are now decoupled: sandbox
 * ⇏ no-MCP, sandbox ⇒ no-commit.
 */
export function isSandboxedSpawn(profile: AgentCapabilityProfile): boolean {
  return /--sandbox\b/.test(profile.invoke_template ?? '');
}

/**
 * Whether the agent, AS SPAWNED by the dispatcher, can reach brainclaw MCP.
 *
 * pln#628 Focus 4A: this is NO LONGER gated by isSandboxedSpawn. dec#133 proved
 * empirically that a sandboxed codex run reaches MCP (both whitelisted and
 * non-whitelisted tools fired) — the sandbox does not sever MCP, it only makes
 * `.git` read-only. MCP reachability therefore tracks `runtime.mcp_direct` alone;
 * the commit constraint is expressed separately by dispatchCanCommit.
 */
export function dispatchHasMcp(profile: AgentCapabilityProfile): boolean {
  return profile.runtime.mcp_direct;
}

/**
 * Whether the spawned worker can `git commit`. A sandbox whose root excludes
 * `.git` cannot — the coordinator must integrate the worker's output instead of
 * relying on a self-commit handoff. NOTE (dec#133): commit-from-sandbox was NOT
 * verified to work even on Windows, so this stays conservative (sandbox ⇒ no
 * commit); do not relax it to a platform check without an empirical probe.
 */
export function dispatchCanCommit(profile: AgentCapabilityProfile): boolean {
  return !isSandboxedSpawn(profile);
}

// ── getDefaultInvokeTemplate ───────────────────────────────────────────────

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
    if (profile.runtime.canBeSpawnedCli && profile.invoke_template && profile.invoke_binary) {
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
  const resolved = resolveAgentAlias(name);
  return resolved in PROFILES;
}

/**
 * Dispatch-time agent validation (pln#451 / trp#51).
 *
 * Callers (coordinate/assign, dispatch, reroute) should reject agents that
 * cannot reasonably be spawned: unknown profile, not spawnable, or the
 * declared invoke_binary isn't on PATH. Non-spawnable agents still pass
 * `requireSpawnable: false` (e.g. dispatching a review task to Copilot).
 */
export interface DispatchValidation {
  valid: boolean;
  reason?: string;
  code?: 'unknown_profile' | 'not_spawnable' | 'binary_missing';
  profile?: AgentCapabilityProfile;
}

export function validateAgentForDispatch(
  name: string,
  options: { requireSpawnable?: boolean } = {},
): DispatchValidation {
  const profile = getCapabilityProfile(name);
  if (!profile) {
    return {
      valid: false,
      code: 'unknown_profile',
      reason: `Unknown agent profile: '${name}'. Registered agents: ${Object.keys(PROFILES).join(', ')}.`,
    };
  }

  if (options.requireSpawnable) {
    if (!profile.runtime.canBeSpawnedCli) {
      return {
        valid: false,
        code: 'not_spawnable',
        reason: `Agent '${name}' has no CLI spawn support (runtime.canBeSpawnedCli=false). Use a worker-capable agent for dispatch.`,
        profile,
      };
    }
    const bin = profile.invoke_binary;
    // In test mode we skip the PATH probe: CI runners don't have external
    // agent CLIs (codex, copilot, …) installed, and tests set BRAINCLAW_NO_SPAWN
    // so no real spawn ever happens. Probing PATH here used to make the
    // bclaw-coordinate suite fail on CI while passing locally whenever the
    // developer had the binaries installed. Profile-based checks
    // (unknown_profile, not_spawnable) still apply — they're deterministic.
    const skipBinaryProbe = process.env.BRAINCLAW_TEST_MODE === '1'
      || process.env.BRAINCLAW_NO_SPAWN === '1';
    if (bin && !skipBinaryProbe) {
      const probe = process.platform === 'win32' ? 'where' : 'which';
      const result = spawnSync(probe, [bin], { encoding: 'utf-8' });
      if (result.status !== 0) {
        return {
          valid: false,
          code: 'binary_missing',
          reason: `Agent '${name}' declares invoke_binary='${bin}' but it is not on PATH. Install the agent CLI or update its profile.`,
          profile,
        };
      }
    }
  }

  return { valid: true, profile };
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
