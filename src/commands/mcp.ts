import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { resolveCrossProjectTarget, writeCrossProjectNote } from '../core/cross-project.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { checkBrainclawInstallableUpdate, getInstalledBrainclawVersion, readDiskBrainclawVersion, renderBrainclawInstallableUpdateNotice } from '../core/brainclaw-version.js';
import { loadConfig } from '../core/config.js';
import { loadState, persistState, saveState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { generateCandidateIdWithLabel, saveCandidate } from '../core/candidates.js';
import { generateClaimId, listClaims, loadClaim, saveClaim } from '../core/claims.js';
import { checkPolicy } from '../core/policy.js';
import { createWorktree as coreCreateWorktree } from '../core/worktree.js';
import { createRuntimeNote } from './runtime-note.js';
import { acceptCandidate } from './accept.js';
import { rejectCandidate } from './reject.js';
import { startSession } from './session-start.js';
import { endSession } from './session-end.js';
import {
  agentCanWriteDirect,
  AgentIdentityResolutionError,
  AgentTrustError,
  requireMinimumTrustLevel,
  requireRegisteredAgentIdentity,
  resolveCurrentModel,
} from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO, generateId } from '../core/ids.js';
import { buildOperationalIdentity, loadSessionById } from '../core/identity.js';
import { validateMcpInput, validateMcpField } from '../core/input-validation.js';
import { createCapability, createTool as createRegistryTool } from '../core/registries.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import {
  checkGitPresence,
  scanGitRepos,
  parseRoots,
  parseRepoSelection,
  parseAgentSelection,
  runGlobalInstall,
  initReposAndConfigureAgents,
  readSetupState,
  ALL_KNOWN_AGENTS,
} from './setup.js';
import { resolveEffectiveCwd, resolveProjectRef, resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import { probeForQuickSetup, buildQuickSetupProbeResponse, buildOnboardingPreview, type ProjectTypeChoice, type TopologyChoice } from '../core/setup-flow.js';
import { ensureUserStore } from '../core/setup-state.js';
import type { CandidateType, MemoryVisibility, PlanStatus, PlanType, Priority } from '../core/schema.js';
import { createPlan, addStep as addStepOp, completeStep as completeStepOp, updatePlan as updatePlanOp } from '../core/operations/plan.js';
import { deleteMemoryItem, updateMemoryItem, type MemoryItemType } from '../core/operations/memory-mutation.js';

export type ContextFormat = 'markdown' | 'json' | 'template';
export type McpProtocolVersion = '2024-11-05' | '2025-11-25';
export type McpConnectionState = 'pre_init' | 'awaiting_initialized' | 'ready' | 'closed';
export type JsonRpcId = string | number | null;

export const SCHEMA_VERSION = '0.6.0';
export const MCP_PROTOCOL_VERSIONS: McpProtocolVersion[] = ['2025-11-25', '2024-11-05'];
export const MCP_SERVER_NOT_INITIALIZED = -32002;

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  schema_version?: string;
  [key: string]: unknown;
}

export interface McpReadToolContext {
  cwd?: string;
}

export interface McpToolExecutionPayload {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  connectionSessionId?: string;
}

export interface McpToolExecutionOutcome {
  response: McpToolResponse;
  nextConnectionSessionId?: string;
  /** Tool name — used for usage tracking. */
  toolName?: string;
}

export interface McpTaskRunnerOptions {
  executeTool: McpToolExecutor;
  onResult: (requestId: JsonRpcId, outcome: McpToolExecutionOutcome) => void;
  onInternalError: (requestId: JsonRpcId, error: unknown) => void;
}

export interface McpConnectionOptions {
  cwd: string;
  send: (message: Record<string, unknown>) => void;
  executeTool?: McpToolExecutor;
}

export interface ParsedMcpMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
  isNotification: boolean;
}

export interface McpInitializeResult {
  protocolVersion: McpProtocolVersion;
  serverInfo: { name: string; version: string };
  capabilities: { tools: { listChanged: boolean } };
}

export interface McpToolErrorShape {
  kind: string;
  message: string;
  details?: unknown;
}

export type McpToolExecutor = (payload: McpToolExecutionPayload, signal: AbortSignal) => Promise<McpToolExecutionOutcome>;

export const MCP_READ_TOOLS = [
  {
    name: 'bclaw_get_context',
    description: 'Get project memory context for a specific file or path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path or glob pattern to filter memory by.' },
        project: { type: 'string', description: 'Optional explicit project namespace for instruction resolution.' },
        agent: { type: 'string', description: 'Optional agent name for agent-layer instruction resolution.' },
        host: { type: 'string', description: 'Optional host identifier used to include machine-local runtime context.' },
        allHosts: { type: 'boolean', description: 'Include machine-local runtime context from all hosts.' },
        profile: { type: 'string', description: 'Optional profile override: dev (default), dense (all sections, max items), compact (plans+constraints), copilot (constraints+traps), quick (minimal), openclaw, ops, research.' },
        includePending: { type: 'boolean', description: 'Include pending candidates in the context.' },
        maxItems: { type: 'number', description: 'Maximum number of ranked items to return.' },
        maxChars: { type: 'number', description: 'Approximate character budget applied after ranking.' },
        digest: { type: 'boolean', description: 'Include a short deterministic digest for the selected context.' },
        since_session: { type: 'string', description: 'Include a compact memory diff since the given session started.' },
        bootstrap: { type: 'boolean', description: 'Enable brownfield bootstrap fallback when memory is sparse.' },
        refreshBootstrap: { type: 'boolean', description: 'Refresh the brownfield bootstrap profile before building context.' },
        format: { type: 'string', description: 'Output format: markdown, json, or template.' },
        explain: { type: 'boolean', description: 'Include ranking reasons in markdown output.' },
        compactTemplate: { type: 'boolean', description: 'Use compact template format when format=template.' },
      },
    },
  },
  {
    name: 'bclaw_bootstrap',
    description: 'Derive brownfield bootstrap signals, adaptive interview prompts for CLI or IDE chat agents, and an import proposal from repository docs, manifests, native agent files, and git history.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional path or scope to tailor the bootstrap.' },
        refresh: { type: 'boolean', description: 'Force a fresh bootstrap scan.' },
        audience: { type: 'string', description: 'Optional interview audience filter: cli, ide_chat, or any.' },
        interview: { type: 'boolean', description: 'Render interview text instead of the summary text.' },
        apply: { type: 'boolean', description: 'Apply the current import proposal into canonical memory.' },
        uninstall: { type: 'boolean', description: 'Uninstall the last bootstrap-managed import.' },
        interviewAnswers: {
          type: 'array',
          description: 'Optional structured interview answers. Each answer may include question_id, response_text, response_items, response_boolean, and explicit suggestions.',
          items: { type: 'object' },
        },
      },
    },
  },
  {
    name: 'bclaw_get_execution_context',
    description: 'Inspect the local execution environment, installable Brainclaw update channel, and optionally agent tooling signals.',
    inputSchema: {
      type: 'object',
      properties: {
        includeAgentTooling: { type: 'boolean', description: 'Include AGENTS.md, skills, and local MCP inventory.' },
      },
    },
  },
  {
    name: 'bclaw_release_notes',
    description: 'Return the agent-first release notes for the latest installable Brainclaw version from the configured update source. Returns structured highlights, breaking risk, and action recommendation when available.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'bclaw_read_handoff',
    description: 'Read an open handoff ticket with its captured git diff and state snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The handoff ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_get_agent_board',
    description: 'Get an agent collaboration board with active plans, claims, handoffs, and resolved instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Optional agent name to filter claims and handoffs.' },
        project: { type: 'string', description: 'Optional project namespace.' },
        path: { type: 'string', description: 'Optional target path used to infer project scope.' },
        host: { type: 'string', description: 'Optional host identifier used to include machine-local runtime notes.' },
        allHosts: { type: 'boolean', description: 'Include machine-local runtime notes from all hosts.' },
        includeReputation: { type: 'boolean', description: 'Include bounded reputation summaries for board consumers.' },
        includeSessionMeta: { type: 'boolean', description: 'Include session_start/session_end runtime notes (excluded by default to reduce noise).' },
      },
    },
  },
  {
    name: 'bclaw_search',
    description: 'Full-text search across all memory items (decisions, constraints, traps, candidates, handoffs) using BM25 scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string.' },
        type: { type: 'string', description: 'Filter by item type (decision, constraint, trap, handoff, candidate, plan).' },
        section: { type: 'string', description: 'Filter by section (state, candidates, runtime).' },
        since: { type: 'string', description: 'Filter items created after this ISO date.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default 10).' },
        offset: { type: 'number', description: 'Number of results to skip (for pagination).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bclaw_estimation_report',
    description: 'Show estimation accuracy report for completed plans. Returns ratio of estimated vs actual effort per agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Filter by agent/author name.' },
      },
    },
  },
  {
    name: 'bclaw_list_plans',
    description: 'List plan items with optional filters on status, type, assignee, and project.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include done and dropped plans.' },
        status: { type: 'string', description: 'Filter by status: todo, in_progress, blocked, done, dropped.' },
        type: { type: 'string', description: 'Filter by plan type.' },
        assignee: { type: 'string', description: 'Filter by assignee name.' },
        project: { type: 'string', description: 'Filter by project namespace.' },
        id: { type: 'string', description: 'Get a single plan by ID (exact match).' },
        limit: { type: 'number', description: 'Maximum number of plans to return (default: 20).' },
        offset: { type: 'number', description: 'Number of plans to skip (for pagination).' },
        recursive: { type: 'boolean', description: 'Include plans from descendant brainclaw projects. Shows aggregated view with provenance.' },
        compact: { type: 'boolean', description: 'Return only key fields (id, short_label, text, status, priority) to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_list_claims',
    description: 'List work claims with optional filters on project, plan, and agent.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include released claims.' },
        project: { type: 'string', description: 'Filter by project namespace.' },
        plan: { type: 'string', description: 'Filter by linked plan id.' },
        agent: { type: 'string', description: 'Filter by agent name.' },
        limit: { type: 'number', description: 'Maximum number of claims to return (default: 20).' },
        offset: { type: 'number', description: 'Number of claims to skip (for pagination).' },
      },
    },
  },
  {
    name: 'bclaw_list_agents',
    description: 'List registered agent identities and optionally include bounded reputation summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        includeReputation: { type: 'boolean', description: 'Include bounded reputation summaries for each agent.' },
      },
    },
  },
  {
    name: 'bclaw_list_instructions',
    description: 'List raw or resolved shared instructions with the same filters exposed by the CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Filter by layer: global, project, agent.' },
        project: { type: 'string', description: 'Project namespace filter.' },
        agent: { type: 'string', description: 'Agent name filter.' },
        active: { type: 'boolean', description: 'Only include active instructions.' },
        resolved: { type: 'boolean', description: 'Resolve effective instructions for the given scope.' },
        path: { type: 'string', description: 'Infer project namespace from a target path when strategy=folder.' },
        limit: { type: 'number', description: 'Maximum number of instructions to return (default: 20).' },
        offset: { type: 'number', description: 'Number of instructions to skip (for pagination).' },
      },
    },
  },
  {
    name: 'bclaw_list_candidates',
    description: 'List review candidates across pending, accepted, rejected, or all queues.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Candidate bucket: pending, accepted, rejected, or all.' },
        type: { type: 'string', description: 'Filter by candidate type.' },
        assignee: { type: 'string', description: 'Filter pending candidates by assignee tag (assignee:<name>).' },
        limit: { type: 'number', description: 'Maximum number of candidates to return (default: 20).' },
        offset: { type: 'number', description: 'Number of candidates to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields (id, type, text, status) to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_get_capabilities',
    description: 'List all registered project capabilities with full metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by capability category.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any).' },
      },
    },
  },
  {
    name: 'bclaw_list_tools',
    description: 'List all registered project tools with metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by tool type (workflow, validator, generator, utility, explorer).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any).' },
      },
    },
  },
  {
    name: 'bclaw_search_tools',
    description: 'Search tools by query and tags.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (matches tool name, description, tags).' },
        type: { type: 'string', description: 'Filter by tool type.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (all must match).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'bclaw_doctor',
    description: 'Run health checks on the brainclaw memory store. Returns structured check results with ok/warn/error status and metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        migrationCheck: { type: 'boolean', description: 'Include detailed schema migration status.' },
      },
    },
  },
  {
    name: 'bclaw_history',
    description: 'Show full mutation history of a memory item from the audit log.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID to retrieve history for.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_audit',
    description: 'View the audit log or generate a governance posture report. Use governance=true for an aggregated view of claims, constraints, traps, instructions and recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Show entries since this ISO date.' },
        actor: { type: 'string', description: 'Filter by actor name or agent ID.' },
        action: { type: 'string', description: 'Filter by action type (create, accept, reject, etc.).' },
        limit: { type: 'number', description: 'Show last N entries (default 20).' },
        governance: { type: 'boolean', description: 'Generate a governance posture report instead of chronological log.' },
        scope: { type: 'string', description: 'Filter governance report by scope (used with governance=true).' },
      },
    },
  },
  {
    name: 'bclaw_get_discovery',
    description: 'Scan workspace for MCP configs, instruction files, skills, hooks, and agent integrations. Returns a structured discovery profile. Saves result to .brainclaw/discovery/ by default.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Force a fresh scan even if a cached profile exists (default: true).' },
        noSave: { type: 'boolean', description: 'Do not persist the discovery profile.' },
      },
    },
  },
  {
    name: 'bclaw_conflict_check',
    description: 'Check for claim conflicts between the current agent and other agents. Returns overlapping scopes.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name to check conflicts for (default: current agent).' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_who',
    description: 'List all active agent sessions on this workspace. Shows user, agent, active project, claims, and last activity for each session.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include stale sessions (default: false).' },
        gc: { type: 'boolean', description: 'Remove stale sessions and return count.' },
      },
    },
  },
  {
    name: 'bclaw_check_policy',
    description: 'Pre-execution policy check. Verifies claims, constraints, traps and governance instructions for a given scope. Returns blocks (hard stops) and warnings (context to consider). Call before editing to ensure compliance.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'File or directory scope to check (e.g. "src/core/foo.ts" or "src/commands").' },
        agent: { type: 'string', description: 'Agent name to check claims for.' },
        agentId: { type: 'string', description: 'Agent id to check claims for.' },
        action: { type: 'string', description: 'Intended action: edit, create, delete (informational, does not change check logic in v1).' },
      },
      required: ['scope'],
    },
  },
  {
    name: 'bclaw_check_security',
    description: 'Check supply chain security scores for packages via Socket.dev. Returns pass/warn/block verdict per package. Requires security.preinstall.enabled in config. Uses the free public Socket MCP endpoint (no auth needed).',
    inputSchema: {
      type: 'object',
      properties: {
        packages: { type: 'string', description: 'Comma-separated package names (e.g. "axios,express" or "axios@1.14.1").' },
        ecosystem: { type: 'string', description: 'Package ecosystem: npm or pypi. Defaults to npm.' },
      },
      required: ['packages'],
    },
  },
] as const;

const MCP_WRITE_TOOLS = [
  {
    name: 'bclaw_switch',
    description: 'Switch active project in a multi-project workspace. Session-scoped by default: only this agent sees the switch, other agents are unaffected. Use list=true to see available projects.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project reference: name, path, or project_id.' },
        list: { type: 'boolean', description: 'List available projects instead of switching.' },
        clear: { type: 'boolean', description: 'Clear active project (return to workspace root).' },
      },
    },
  },
  {
    name: 'bclaw_setup',
    description: 'Interactive onboarding wizard. Two modes: (1) Quick mode (default): probes the current repo and asks project type + topology, then inits. (2) Batch mode: scan root directories and init multiple repos. Call without step to start — brainclaw auto-detects the best mode.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'Resume step: "quick_init" (quick mode), or "project_roots"/"repo_selection"/"agent_selection" (batch mode). Omit to start.' },
        choice: { type: 'string', description: 'User choice for the current step.' },
        project_type: { type: 'string', description: 'Quick mode: "standalone", "workspace", or "linked".' },
        topology: { type: 'string', description: 'Quick mode: "embedded" (shared via git) or "sidecar" (local only).' },
        roots: { type: 'string', description: 'Batch mode: comma-separated root paths.' },
        repo_selection: { type: 'string', description: 'Batch mode: repo selection from previous step.' },
        mode: { type: 'string', description: 'Force "quick" or "batch" mode. Default: auto-detect.' },
      },
    },
  },
  {
    name: 'bclaw_write_note',
    description: 'Add a runtime note. Requires contributor trust level or above. Use crossProject to push a notification note to a linked project (requires role: publisher in cross_project_links config).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Note content.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        visibility: { type: 'string', description: 'Visibility: shared, machine, private.' },
        ttl: { type: 'string', description: 'Optional TTL: 30m, 2h, 7d.' },
        autoReflect: { type: 'boolean', description: 'Attempt to reflect the runtime note into durable memory immediately.' },
        crossProject: { type: 'string', description: 'Push note to a linked project (name or path). Requires role: publisher in cross_project_links config.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'bclaw_create_candidate',
    description: 'Create a memory candidate for review. Trusted/curator agents write through directly.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Candidate content.' },
        type: { type: 'string', description: 'Type: constraint, decision, trap, handoff.' },
        agent: { type: 'string', description: 'Author agent name.' },
        agentId: { type: 'string', description: 'Registered author agent id.' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string', description: 'Category for constraints: architecture, performance, security, reliability, compatibility, process, other.' },
        outcome: { type: 'string', description: 'Outcome for decisions: approved, rejected, deferred, pending.' },
        severity: { type: 'string', description: 'Severity for traps: low, medium, high.' },
        planId: { type: 'string', description: 'Optional plan item ID this decision or trap relates to.' },
        scope: { type: 'string', description: 'Memory scope: project (default), machine, or user. Machine-scoped items apply to all projects on this machine.' },
        store: { type: 'string', description: 'Target store level: local (default), repo, workspace, user. Use "user" to write to ~/.brainclaw/ (visible across all projects).' },
        targetProject: { type: 'string', description: 'Cross-project report: create this candidate in a linked project (name or path). The candidate appears in the target project pending inbox with source attribution.' },
      },
      required: ['text', 'type'],
    },
  },
  {
    name: 'bclaw_accept',
    description: 'Accept a pending candidate into canonical memory. Requires trusted or curator trust level.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Candidate ID to accept.' },
        by: { type: 'string', description: 'Reviewer identity.' },
        byId: { type: 'string', description: 'Reviewer agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_reject',
    description: 'Reject a pending candidate. Requires trusted or curator trust level.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Candidate ID to reject.' },
        reason: { type: 'string', description: 'Reason for rejection.' },
        by: { type: 'string', description: 'Reviewer identity.' },
        byId: { type: 'string', description: 'Reviewer agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_claim',
    description: 'Claim a work scope (advisory lock). Automatically creates an isolated git worktree for this claim. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Scope being claimed.' },
        description: { type: 'string', description: 'Description of the work.' },
        agent: { type: 'string', description: 'Agent or person name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        planId: { type: 'string', description: 'Optional linked plan item ID.' },
        project: { type: 'string', description: 'Project name or path. Use this when working on a project different from the MCP server workspace (e.g. CLI agents in a different directory).' },
        store: { type: 'string', description: 'Target store level: local (default), repo, workspace.' },
        worktreeBranch: { type: 'string', description: 'Branch name for the worktree. Defaults to feat/<scope-slug>.' },
      },
      required: ['scope', 'description'],
    },
  },
  {
    name: 'bclaw_release_claim',
    description: 'Release a work claim.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Claim ID to release.' },
        planStatus: { type: 'string', description: 'Optional: update linked plan status.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_session_start',
    description: 'Start a session and capture initial context. Pass includeContext and/or includeBoard to get full context + agent board in a single call, eliminating the need for separate bclaw_get_context and bclaw_get_agent_board calls.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        context: { type: 'string', description: 'Context target path.' },
        includeContext: { type: 'boolean', description: 'Include project memory context in the response (equivalent to bclaw_get_context).' },
        includeBoard: { type: 'boolean', description: 'Include agent board (plans, claims, handoffs) in the response (equivalent to bclaw_get_agent_board).' },
        contextProfile: { type: 'string', description: 'Context profile when includeContext is true: dev (default), dense, compact, copilot, quick, openclaw, ops, research. If unset, uses the agent default profile.' },
        contextFormat: { type: 'string', description: 'Context format when includeContext is true: markdown, json, or template.' },
      },
    },
  },
  {
    name: 'bclaw_session_end',
    description: 'End a session and optionally auto-reflect observations as candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session ID.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        summary: { type: 'string', description: 'Session summary text.' },
        narrative: { type: 'string', description: 'Free-text narrative of what happened in the session and why. Goes beyond the auto-generated commit list: "Tried X, failed because Y, pivoted to Z. Watch out for A."' },
        autoReflect: { type: 'boolean', description: 'Auto-reflect session notes as candidates.' },
        reflect: { type: 'boolean', description: 'Include structured reflection questions. Answer via bclaw_write_note with tag [reflection].' },
      },
    },
  },
  {
    name: 'bclaw_create_plan',
    description: 'Create a new plan item. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plan item description.' },
        type: { type: 'string', description: 'Plan type: feat, fix, chore, spike, doc.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        priority: { type: 'string', description: 'Priority: low, medium, high, critical.' },
        estimate: { type: 'number', description: 'Estimated effort in minutes (positive integer).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the plan item.' },
        assignee: { type: 'string', description: 'Assignee agent or person name.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'bclaw_update_plan',
    description: 'Update the status, effort, or other fields of a plan item. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plan item ID.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        status: { type: 'string', description: 'New status: todo, in_progress, done, blocked, cancelled.' },
        actualEffort: { type: 'string', description: 'Actual effort (e.g. "45min", "2h").' },
        priority: { type: 'string', description: 'New priority: low, medium, high, critical.' },
        assignee: { type: 'string', description: 'New assignee.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_add_step',
    description: 'Add a sub-step to a plan item. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan item ID.' },
        text: { type: 'string', description: 'Step description.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        assignee: { type: 'string', description: 'Optional assignee.' },
      },
      required: ['planId', 'text'],
    },
  },
  {
    name: 'bclaw_complete_step',
    description: 'Mark a plan sub-step as done. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan item ID.' },
        stepId: { type: 'string', description: 'Step ID to complete.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['planId', 'stepId'],
    },
  },
  {
    name: 'bclaw_delete_memory',
    description: 'Delete a memory item (constraint, decision, or trap) by ID. Requires trusted or curator trust level.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID of the item to delete.' },
        type: { type: 'string', description: 'Item type: constraint, decision, trap.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id', 'type'],
    },
  },
  {
    name: 'bclaw_update_memory',
    description: 'Update text, tags, or trap status of a constraint, decision, or trap by ID. Optionally move it to a different store level. Requires trusted or curator trust level.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID of the item to update.' },
        type: { type: 'string', description: 'Item type: constraint, decision, trap.' },
        text: { type: 'string', description: 'New text (optional).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing).' },
        status: { type: 'string', description: 'New status for traps: active, resolved, expired.' },
        moveToStore: { type: 'string', description: 'Move item to a different store level: local, repo, workspace, user.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id', 'type'],
    },
  },
  {
    name: 'bclaw_add_capability',
    description: 'Register a new project capability. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Capability name.' },
        description: { type: 'string', description: 'Capability description.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'bclaw_add_tool',
    description: 'Register a new project tool. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name.' },
        description: { type: 'string', description: 'Tool description.' },
        type: { type: 'string', description: 'Tool type: workflow, validator, generator, utility, explorer (default: utility).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'bclaw_update_handoff',
    description: 'Update the status, recipient, or contract of an open handoff. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Handoff ID to update.' },
        status: { type: 'string', description: 'New status: open, closed.' },
        to: { type: 'string', description: 'New recipient agent name.' },
        files_touched: { type: 'array', items: { type: 'string' }, description: 'Files touched in this handoff.' },
        pre_conditions: { type: 'array', items: { type: 'string' }, description: 'Pre-conditions for the receiving agent.' },
        post_conditions: { type: 'array', items: { type: 'string' }, description: 'Post-conditions the receiving agent must satisfy.' },
        tests_to_verify: { type: 'array', items: { type: 'string' }, description: 'Tests the receiving agent should verify.' },
        linked_plans: { type: 'array', items: { type: 'string' }, description: 'Linked plan IDs.' },
        narrative: { type: 'string', description: 'Free-text narrative of what happened and why, beyond the auto-generated commit list.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
] as const;

const ALL_TOOLS = [...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS];

class McpProtocolError extends Error {
  code: number;
  id: JsonRpcId;
  data?: unknown;

  constructor(code: number, message: string, id: JsonRpcId = null, data?: unknown) {
    super(message);
    this.code = code;
    this.id = id;
    this.data = data;
  }
}

interface TaskRecord {
  requestId: JsonRpcId;
  payload: McpToolExecutionPayload;
  controller: AbortController;
  cancelled: boolean;
  enqueuedAt: number;
}

/**
 * Lightweight metrics for the single-writer mutation queue.
 * Exposed via McpTaskRunner.metrics for observability.
 */
export interface McpTaskRunnerMetrics {
  /** Total tasks executed since server start. */
  totalExecuted: number;
  /** Total tasks cancelled before execution. */
  totalCancelled: number;
  /** Current queue depth (waiting tasks). */
  queueDepth: number;
  /** Peak queue depth observed. */
  peakQueueDepth: number;
  /** Last task execution duration in ms. */
  lastDurationMs: number;
  /** Last task queue wait time in ms (time between enqueue and start). */
  lastWaitMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedProtocolVersion(value: unknown): value is McpProtocolVersion {
  return typeof value === 'string' && MCP_PROTOCOL_VERSIONS.includes(value as McpProtocolVersion);
}

function toolResponse(
  response: {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    [key: string]: unknown;
  },
  isError: boolean = false,
): McpToolResponse {
  const structuredContent = response.structuredContent
    ? { ...response.structuredContent, schema_version: SCHEMA_VERSION }
    : undefined;
  return {
    ...response,
    structuredContent,
    isError,
    schema_version: SCHEMA_VERSION,
  };
}

export function createToolErrorResponse(kind: string, message: string, details?: unknown): McpToolResponse {
  return toolResponse({
    content: [{ type: 'text', text: `Error: ${message}` }],
    structuredContent: {
      error: {
        kind,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
  }, true);
}

// Bootstrap helpers moved to mcp-read-handlers.ts

function requireObjectParams(params: unknown, id: JsonRpcId): Record<string, unknown> {
  if (params === undefined) {
    return {};
  }
  if (!isRecord(params)) {
    throw new McpProtocolError(-32602, 'Invalid params', id);
  }
  return params;
}

function resolveRequestedProtocolVersion(params: Record<string, unknown>, id: JsonRpcId): McpProtocolVersion {
  const requested = params.protocolVersion;
  if (typeof requested !== 'string' || !requested.trim()) {
    throw new McpProtocolError(-32602, 'Invalid params', id);
  }
  if (!isSupportedProtocolVersion(requested)) {
    // MCP version negotiation: when the client proposes an unsupported version,
    // respond with the oldest supported version to maximize compatibility.
    return MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]!;
  }
  return requested;
}

function getCancelledRequestId(params: Record<string, unknown>): JsonRpcId | undefined {
  const candidate = params.requestId ?? params.id;
  if (typeof candidate === 'string' || typeof candidate === 'number' || candidate === null) {
    return candidate;
  }
  return undefined;
}

function resolveMutationIdentity(args: Record<string, unknown>, fields: { nameField: string; idField: string }, cwd?: string, sessionId?: string) {
  try {
    // Session-pinned identity: if no explicit agent in args, use the session's pinned agent
    let agentName = typeof args[fields.nameField] === 'string' ? String(args[fields.nameField]) : undefined;
    if (!agentName && sessionId) {
      const session = loadSessionById(sessionId, cwd);
      if (session?.agent) {
        agentName = session.agent;
      }
    }
    return {
      identity: requireRegisteredAgentIdentity({
        agentName,
        agentId: typeof args[fields.idField] === 'string' ? String(args[fields.idField]) : undefined,
        cwd,
        allowCurrent: true,
        allowEnv: true,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof AgentIdentityResolutionError) {
      return {
        error: {
          kind: error.kind,
          message: error.message,
          details: error.details,
        } satisfies McpToolErrorShape,
      };
    }
    return {
      error: {
        kind: 'identity_error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies McpToolErrorShape,
    };
  }
}

function ensureTrust(
  args: Record<string, unknown>,
  fields: { nameField: string; idField: string },
  level: 'contributor' | 'trusted' | 'curator',
  cwd?: string,
  sessionId?: string,
): { identity?: ReturnType<typeof requireRegisteredAgentIdentity>; error?: McpToolErrorShape } {
  const resolved = resolveMutationIdentity(args, fields, cwd, sessionId);
  if ('error' in resolved) {
    return resolved;
  }

  try {
    requireMinimumTrustLevel(resolved.identity, level);
    return resolved;
  } catch (error: unknown) {
    if (error instanceof AgentTrustError) {
      return {
        error: {
          kind: error.kind,
          message: error.message,
          details: error.details,
        },
      };
    }
    return {
      error: {
        kind: 'trust_error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function explicitSessionIdFromEnv(): string | undefined {
  return process.env.BRAINCLAW_SESSION_ID?.trim()
    || process.env.OPENCLAW_SESSION_ID?.trim()
    || process.env.CLAUDE_SESSION_ID?.trim()
    || process.env.COPILOT_SESSION_ID?.trim();
}

export function parseMcpLine(line: string): ParsedMcpMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new McpProtocolError(-32700, 'Parse error');
  }

  if (Array.isArray(parsed)) {
    throw new McpProtocolError(-32600, 'Batch requests are not supported');
  }

  if (!isRecord(parsed)) {
    throw new McpProtocolError(-32600, 'Invalid Request');
  }

  if (parsed.jsonrpc !== '2.0') {
    throw new McpProtocolError(-32600, 'Invalid Request');
  }

  if (typeof parsed.method !== 'string' || parsed.method.trim() === '') {
    throw new McpProtocolError(-32600, 'Invalid Request');
  }

  if ('id' in parsed && typeof parsed.id !== 'string' && typeof parsed.id !== 'number' && parsed.id !== null) {
    throw new McpProtocolError(-32600, 'Invalid Request');
  }

  if ('params' in parsed && parsed.params !== undefined && !isRecord(parsed.params)) {
    throw new McpProtocolError(-32602, 'Invalid params', ('id' in parsed ? (parsed.id as JsonRpcId) : null) ?? null);
  }

  return {
    jsonrpc: '2.0',
    id: ('id' in parsed ? (parsed.id as JsonRpcId) : undefined),
    method: parsed.method,
    params: parsed.params as Record<string, unknown> | undefined,
    isNotification: !('id' in parsed),
  };
}

export function createInitializeResult(protocolVersion: McpProtocolVersion): McpInitializeResult {
  return {
    protocolVersion,
    serverInfo: { name: 'brainclaw', version: SCHEMA_VERSION },
    capabilities: { tools: { listChanged: false } },
  };
}

export class McpTaskRunner {
  private readonly executeTool: McpToolExecutor;
  private readonly onResult: (requestId: JsonRpcId, outcome: McpToolExecutionOutcome) => void;
  private readonly onInternalError: (requestId: JsonRpcId, error: unknown) => void;
  private active: TaskRecord | undefined;
  private queue: TaskRecord[] = [];

  private _totalExecuted = 0;
  private _totalCancelled = 0;
  private _peakQueueDepth = 0;
  private _lastDurationMs = 0;
  private _lastWaitMs = 0;

  constructor(options: McpTaskRunnerOptions) {
    this.executeTool = options.executeTool;
    this.onResult = options.onResult;
    this.onInternalError = options.onInternalError;
  }

  get activeRequestId(): JsonRpcId | undefined {
    return this.active?.requestId;
  }

  get queuedRequestIds(): JsonRpcId[] {
    return this.queue.map((task) => task.requestId);
  }

  /** Current single-writer queue metrics. */
  get metrics(): McpTaskRunnerMetrics {
    return {
      totalExecuted: this._totalExecuted,
      totalCancelled: this._totalCancelled,
      queueDepth: this.queue.length,
      peakQueueDepth: this._peakQueueDepth,
      lastDurationMs: this._lastDurationMs,
      lastWaitMs: this._lastWaitMs,
    };
  }

  enqueue(requestId: JsonRpcId, payload: McpToolExecutionPayload): void {
    this.queue.push({
      requestId,
      payload,
      controller: new AbortController(),
      cancelled: false,
      enqueuedAt: performance.now(),
    });
    if (this.queue.length > this._peakQueueDepth) {
      this._peakQueueDepth = this.queue.length;
    }
    this.drain();
  }

  cancel(requestId: JsonRpcId): 'active' | 'queued' | 'missing' {
    if (this.active && this.active.requestId === requestId) {
      this.active.cancelled = true;
      this.active.controller.abort();
      this._totalCancelled++;
      return 'active';
    }

    const index = this.queue.findIndex((task) => task.requestId === requestId);
    if (index >= 0) {
      const [task] = this.queue.splice(index, 1);
      task.cancelled = true;
      task.controller.abort();
      this._totalCancelled++;
      return 'queued';
    }

    return 'missing';
  }

  close(): void {
    if (this.active) {
      this.active.cancelled = true;
      this.active.controller.abort();
    }
    for (const task of this.queue) {
      task.cancelled = true;
      task.controller.abort();
    }
    this.queue = [];
  }

  private drain(): void {
    if (this.active) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    if (next.cancelled) {
      this._totalCancelled++;
      this.drain();
      return;
    }
    this.active = next;
    void this.runTask(next);
  }

  private async runTask(task: TaskRecord): Promise<void> {
    const startedAt = performance.now();
    this._lastWaitMs = startedAt - task.enqueuedAt;
    try {
      const outcome = await this.executeTool(task.payload, task.controller.signal);
      outcome.toolName = task.payload.name;
      if (!task.cancelled) {
        this.onResult(task.requestId, outcome);
      }
    } catch (error: unknown) {
      if (!task.cancelled) {
        this.onInternalError(task.requestId, error);
      }
    } finally {
      this._lastDurationMs = performance.now() - startedAt;
      this._totalExecuted++;
      if (this.active === task) {
        this.active = undefined;
      }
      this.drain();
    }
  }
}

export class McpServerConnection {
  readonly cwd: string;
  state: McpConnectionState = 'pre_init';
  protocolVersion?: McpProtocolVersion;
  connectionSessionId?: string;

  /** Version of brainclaw code loaded in this process at boot time. */
  private readonly bootVersion: string;
  /** Throttle disk version checks — at most once per 60s. */
  private lastVersionCheckAt = 0;
  private versionMismatchAdvisory: string | undefined;

  private readonly send: (message: Record<string, unknown>) => void;
  private readonly taskRunner: McpTaskRunner;

  constructor(options: McpConnectionOptions) {
    this.cwd = options.cwd;
    this.send = options.send;
    this.bootVersion = getInstalledBrainclawVersion();
    this.taskRunner = new McpTaskRunner({
      executeTool: options.executeTool ?? createWorkerToolExecutor(),
      onResult: (requestId, outcome) => {
        this.connectionSessionId = outcome.nextConnectionSessionId;
        // Inject version mismatch advisory if stale
        const advisory = this.checkVersionMismatch();
        if (advisory && outcome.response.content.length > 0) {
          outcome.response.content = [
            { type: 'text', text: advisory },
            ...outcome.response.content,
          ];
        }
        // Track usage: append response size to usage.jsonl
        if (outcome.toolName) {
          this.trackUsage(outcome.toolName, outcome.response);
        }
        this.sendResult(requestId, outcome.response);
      },
      onInternalError: (requestId, error) => {
        this.sendError(requestId, -32603, error instanceof Error ? error.message : 'Internal error');
      },
    });
  }

  /**
   * Compare the version loaded in memory with the version on disk.
   * Returns an advisory string if they differ, undefined otherwise.
   * Throttled to one disk read per 60 seconds.
   */
  private checkVersionMismatch(): string | undefined {
    const now = Date.now();
    if (now - this.lastVersionCheckAt < 60_000) {
      return this.versionMismatchAdvisory;
    }
    this.lastVersionCheckAt = now;

    try {
      const diskVersion = readDiskBrainclawVersion();
      if (diskVersion !== '0.0.0' && diskVersion !== this.bootVersion) {
        this.versionMismatchAdvisory = `⚠ Brainclaw MCP server is running v${this.bootVersion} but v${diskVersion} is installed on disk. Restart the MCP server to load the new version.\n  → In VS Code: Cmd/Ctrl+Shift+P → "MCP: List Servers" → restart brainclaw\n`;
      } else {
        this.versionMismatchAdvisory = undefined;
      }
    } catch {
      this.versionMismatchAdvisory = undefined;
    }

    return this.versionMismatchAdvisory;
  }

  /**
   * Append a usage record to .brainclaw/usage.jsonl.
   * Fire-and-forget — usage tracking must never block tool responses.
   */
  private trackUsage(toolName: string, response: McpToolResponse): void {
    try {
      const responseChars = response.content
        .filter(c => c.type === 'text')
        .reduce((sum, c) => sum + c.text.length, 0);
      const estimatedTokens = Math.ceil(responseChars / 4);

      const record = JSON.stringify({
        ts: new Date().toISOString(),
        tool: toolName,
        chars: responseChars,
        tokens_est: estimatedTokens,
        is_error: response.isError ?? false,
        agent: process.env.BRAINCLAW_AGENT ?? undefined,
      });

      const usagePath = path.join(this.cwd, '.brainclaw', 'usage.jsonl');
      fs.appendFileSync(usagePath, record + '\n', 'utf-8');
    } catch {
      // Non-fatal — usage tracking failure must never break MCP
    }
  }

  handleLine(line: string): void {
    if (this.state === 'closed' || !line.trim()) {
      return;
    }

    let message: ParsedMcpMessage;
    try {
      message = parseMcpLine(line);
    } catch (error: unknown) {
      if (error instanceof McpProtocolError) {
        this.sendError(error.id, error.code, error.message, error.data);
        return;
      }
      this.sendError(null, -32603, error instanceof Error ? error.message : 'Internal error');
      return;
    }

    const { id, method, isNotification } = message;

    try {
      if (method === 'notifications/cancelled') {
        this.handleCancellation(requireObjectParams(message.params, null));
        return;
      }

      if (method === 'initialize') {
        if (isNotification) {
          return;
        }
        if (this.state !== 'pre_init') {
          this.sendError(id ?? null, -32600, 'Server already initialized');
          return;
        }
        const params = requireObjectParams(message.params, id ?? null);
        const protocolVersion = resolveRequestedProtocolVersion(params, id ?? null);
        this.protocolVersion = protocolVersion;
        this.state = 'awaiting_initialized';
        this.sendResult(id ?? null, createInitializeResult(protocolVersion));
        return;
      }

      if (method === 'notifications/initialized' || method === 'initialized') {
        if (this.state === 'awaiting_initialized') {
          this.state = 'ready';
        }
        return;
      }

      if (method === 'ping') {
        if (!isNotification) {
          this.sendResult(id ?? null, {});
        }
        return;
      }

      if (this.state !== 'ready') {
        if (!isNotification) {
          this.sendError(id ?? null, MCP_SERVER_NOT_INITIALIZED, 'Server not initialized');
        }
        return;
      }

      if (method === 'tools/list') {
        if (!isNotification) {
          this.sendResult(id ?? null, { tools: ALL_TOOLS });
        }
        return;
      }

      if (method === 'tools/call') {
        if (isNotification) {
          return;
        }
        const params = requireObjectParams(message.params, id ?? null);
        const name = typeof params.name === 'string' ? params.name : undefined;
        if (!name) {
          this.sendError(id ?? null, -32602, 'Invalid params');
          return;
        }
        const args = params.arguments === undefined ? {} : requireObjectParams(params.arguments, id ?? null);
        this.taskRunner.enqueue(id ?? null, {
          name,
          args,
          cwd: this.cwd,
          connectionSessionId: this.connectionSessionId,
        });
        return;
      }

      if (!isNotification) {
        this.sendError(id ?? null, -32601, `Method not found: ${method}`);
      }
    } catch (error: unknown) {
      if (error instanceof McpProtocolError) {
        this.sendError(error.id, error.code, error.message, error.data);
        return;
      }
      this.sendError(id ?? null, -32603, error instanceof Error ? error.message : 'Internal error');
    }
  }

  close(): void {
    this.state = 'closed';
    this.taskRunner.close();
  }

  private handleCancellation(params: Record<string, unknown>): void {
    const requestId = getCancelledRequestId(params);
    if (requestId === undefined) {
      return;
    }
    this.taskRunner.cancel(requestId);
  }

  private sendResult(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }
}

/**
 * Send an MCP message with Content-Length framing (LSP-style).
 * Format: `Content-Length: <N>\r\n\r\n<JSON>`
 */
function sendContentLengthFramed(message: Record<string, unknown>): void {
  const json = JSON.stringify(message);
  const byteLength = Buffer.byteLength(json, 'utf-8');
  process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${json}`);
}

/**
 * Send an MCP message as bare newline-delimited JSON.
 * Used when the client sends bare JSON (e.g. Claude Code).
 */
function sendNewlineDelimited(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

/**
 * Bi-modal stdin parser that accepts both Content-Length framed messages
 * (MCP/LSP standard) and legacy newline-delimited JSON.
 *
 * Detection: if the first non-empty data starts with "Content-Length:",
 * we use Content-Length mode for the rest of the connection.
 * Otherwise, we fall back to newline-delimited mode.
 */
export class StdioTransport {
  private buffer = Buffer.alloc(0);
  /** Detected framing mode — exposed so the server can match output format. */
  detectedMode: 'detecting' | 'content-length' | 'newline' = 'detecting';
  onMessage: (line: string) => void;
  private onClose: () => void;

  constructor(onMessage: (line: string) => void, onClose: () => void) {
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  start(): void {
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    process.stdin.on('end', () => this.onClose());
    process.stdin.on('close', () => this.onClose());
  }

  private drain(): void {
    if (this.detectedMode === 'detecting') {
      // Skip leading whitespace/newlines to detect mode
      const str = this.buffer.toString('utf-8');
      const trimmed = str.trimStart();
      if (trimmed.length === 0) return; // need more data
      this.detectedMode = trimmed.startsWith('Content-Length:') ? 'content-length' : 'newline';
    }

    if (this.detectedMode === 'content-length') {
      this.drainContentLength();
    } else {
      this.drainNewline();
    }
  }

  private drainContentLength(): void {
    while (this.buffer.length > 0) {
      const str = this.buffer.toString('utf-8');
      // Find the header/body separator: \r\n\r\n
      const separatorIndex = str.indexOf('\r\n\r\n');
      if (separatorIndex === -1) return; // need more data for headers

      // Parse Content-Length from headers
      const headers = str.slice(0, separatorIndex);
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip to after separator and try again
        this.buffer = Buffer.from(str.slice(separatorIndex + 4), 'utf-8');
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = separatorIndex + 4; // after \r\n\r\n
      const bodyStartBytes = Buffer.byteLength(str.slice(0, bodyStart), 'utf-8');

      // Check if we have enough bytes for the body
      if (this.buffer.length < bodyStartBytes + contentLength) return; // need more data

      const bodyBuffer = this.buffer.subarray(bodyStartBytes, bodyStartBytes + contentLength);
      const body = bodyBuffer.toString('utf-8');
      this.buffer = this.buffer.subarray(bodyStartBytes + contentLength);

      if (body.trim()) {
        this.onMessage(body);
      }
    }
  }

  private drainNewline(): void {
    while (true) {
      const str = this.buffer.toString('utf-8');
      const newlineIndex = str.indexOf('\n');
      if (newlineIndex === -1) return;

      const line = str.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = Buffer.from(str.slice(newlineIndex + 1), 'utf-8');

      if (line.trim()) {
        this.onMessage(line);
      }
    }
  }
}

export function runMcp(): void {
  const cwd = resolveEffectiveCwd();

  if (!memoryExists(cwd)) {
    console.error('Project memory not initialized. Run `brainclaw init` first.');
    process.exit(1);
  }

  const transport = new StdioTransport(
    () => {}, // placeholder, replaced below
    () => connection.close(),
  );

  /** Adaptive send: match the framing format the client uses. */
  const adaptiveSend = (message: Record<string, unknown>): void => {
    if (transport.detectedMode === 'content-length') {
      sendContentLengthFramed(message);
    } else {
      sendNewlineDelimited(message);
    }
  };

  const connection = new McpServerConnection({
    cwd,
    send: adaptiveSend,
  });

  transport.onMessage = (line: string) => connection.handleLine(line);
  transport.start();
}

function createWorkerToolExecutor(): McpToolExecutor {
  return (payload, signal) => new Promise<McpToolExecutionOutcome>((resolve, reject) => {
    const worker = new Worker(new URL('./mcp-worker.js', import.meta.url), {
      workerData: payload,
    });
    let settled = false;

    const cleanup = (): void => {
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
      signal.removeEventListener('abort', onAbort);
    };

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = (): void => {
      settle(() => {
        void worker.terminate().finally(() => reject(new Error('Task cancelled')));
      });
    };

    worker.on('message', (message: unknown) => {
      settle(() => {
        resolve(message as McpToolExecutionOutcome);
      });
    });

    worker.on('error', (error) => {
      settle(() => {
        reject(error);
      });
    });

    worker.on('exit', (code) => {
      if (settled) {
        return;
      }
      settle(() => {
        reject(new Error(`Worker exited unexpectedly with code ${code}`));
      });
    });

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function normaliseFormat(value: unknown): ContextFormat {
  if (value === 'json' || value === 'template') {
    return value;
  }
  return 'markdown';
}

export function renderContextForMcp(
  result: ReturnType<typeof buildContext>,
  format: ContextFormat,
  options: { explain?: boolean; compactTemplate?: boolean },
): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  if (format === 'template') {
    const compact = options.compactTemplate || result.profile === 'openclaw';
    return renderContextPromptTemplate(result, compact);
  }
  return renderContextMarkdown(result, options.explain);
}

export function parseTtl(ttl: string): string | undefined {
  const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
  if (!match) return undefined;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3_600_000 : value * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}

// Read handlers moved to mcp-read-handlers.ts
import { handleMcpReadToolCall } from './mcp-read-handlers.js';
export { handleMcpReadToolCall };


export async function executeMcpToolCall(payload: McpToolExecutionPayload): Promise<McpToolExecutionOutcome> {
  const { name, args, cwd, connectionSessionId } = payload;

  try {
    // Async read: bclaw_check_security (requires network call to Socket MCP)
    if (name === 'bclaw_check_security') {
      const { handleCheckSecurity } = await import('./check-security-mcp.js');
      return { response: toolResponse(await handleCheckSecurity(args, cwd)) };
    }

    if (MCP_READ_TOOLS.some((tool) => tool.name === name)) {
      return {
        response: toolResponse(handleMcpReadToolCall(name, args, { cwd })),
      };
    }

    // Resolve model once for all write operations
    const currentModel = resolveCurrentModel(cwd);

    if (name === 'bclaw_setup') {
      const step = args.step as string | undefined;
      const choice = (args.choice as string | undefined) ?? '';
      const rootsArg = args.roots as string | undefined;
      const repoSelectionArg = args.repo_selection as string | undefined;
      const modeArg = args.mode as string | undefined;
      const env = process.env;

      if (!checkGitPresence()) {
        return { response: toolResponse({ content: [{ type: 'text', text: 'Git is not installed or not found in PATH. Install git from https://git-scm.com before running brainclaw setup.' }], structuredContent: { error: 'git_not_found' } }, true) };
      }

      // ─── Quick mode: probe current repo ──────────────────────────────
      if (!step) {
        // Auto-detect mode: if we're in a git repo, use quick mode unless batch is forced
        const forceBatch = modeArg === 'batch';
        if (!forceBatch) {
          const probe = probeForQuickSetup(cwd);
          if (probe.isGitRepo || probe.alreadyInitialized) {
            const response = buildQuickSetupProbeResponse(probe);
            return { response: toolResponse({ content: [{ type: 'text', text: response.text }], structuredContent: response.structured }) };
          }
        }

        // Fall through to batch mode
        const existingState = readSetupState(env);
        const alreadyRun = existingState ? `Setup was previously run on ${new Date(existingState.completed_at).toLocaleDateString()}. You can re-run it.` : undefined;
        return { response: toolResponse({ content: [{ type: 'text', text: [alreadyRun, "Where are the user's project directories? Please ask the user to provide one or more root paths where their git repositories are located (e.g. ~/Projects, C:\\Users\\user\\code)."].filter(Boolean).join('\n\n') }], structuredContent: { pending_question: 'project_roots', prompt: 'Please ask the user: "Where are your projects? Enter one or more root directories (comma-separated):"', ...(alreadyRun ? { already_run: alreadyRun } : {}) } }) };
      }

      // ─── Quick mode step: init with choices ──────────────────────────
      if (step === 'quick_init') {
        const projectType = (args.project_type as ProjectTypeChoice | undefined) ?? 'standalone';
        const topology = (args.topology as TopologyChoice | undefined) ?? 'embedded';

        // Ensure user store exists
        ensureUserStore(env);

        // Map choices to init options
        const projectMode = projectType === 'workspace' ? 'multi-project' as const : 'auto' as const;
        const topologyMode = topology === 'sidecar' ? 'sidecar' as const : 'embedded' as const;

        // Run init
        try {
          const { runInit } = await import('./init.js');
          await runInit({
            yes: true,
            cwd,
            skipAgentBootstrap: false,
            projectMode,
            topology: topologyMode,
          });
        } catch (err) {
          return { response: toolResponse({ content: [{ type: 'text', text: `Init failed: ${err instanceof Error ? err.message : String(err)}` }], structuredContent: { error: 'init_failed', details: err instanceof Error ? err.message : String(err) } }, true) };
        }

        // Detect agent and report
        const detected = detectAiAgent(env);
        const summary: string[] = [
          `✔ Initialized ${cwd.split(/[\\/]/).pop() ?? cwd} (${projectType}, ${topology})`,
        ];
        if (detected) {
          summary.push(`✔ Agent detected: ${detected.name}`);
        }
        summary.push('✔ Reload your agent session to activate brainclaw MCP tools.');

        // Check if bootstrap is available and generate preview
        const probe = probeForQuickSetup(cwd);
        const bootstrapAvailable = probe.hasContent;
        const preview = buildOnboardingPreview(cwd);

        return {
          response: toolResponse({
            content: [{ type: 'text', text: summary.join('\n') + (bootstrapAvailable ? '\n\nThe repo has existing content. Run bclaw_bootstrap to extract initial project context.' : '') + '\n\n' + preview }],
            structuredContent: {
              setup_complete: true,
              project_type: projectType,
              topology,
              detected_agent: detected?.name ?? null,
              bootstrap_available: bootstrapAvailable,
              preview,
              summary,
            },
          }),
        };
      }

      if (step === 'project_roots') {
        const roots = parseRoots(choice, env);
        if (roots.length === 0) {
          return { response: toolResponse({ content: [{ type: 'text', text: 'No valid directories found from the provided paths. Please ask the user for valid root directories.' }], structuredContent: { error: 'no_valid_roots', provided: choice } }, true) };
        }
        const repos = scanGitRepos(roots);
        const repoList = repos.map((r, i) => `  ${i + 1}) ${r.alreadyInitialised ? '[✔ init]' : '[      ]'} ${r.name}  (${r.path})`).join('\n');
        return { response: toolResponse({ content: [{ type: 'text', text: `Found ${repos.length} repository candidate(s):\n${repoList}\n\nAsk the user which repositories to initialise.` }], structuredContent: { pending_question: 'repo_selection', roots: roots.join(','), repos: repos.map((r) => ({ path: r.path, name: r.name, alreadyInitialised: r.alreadyInitialised })), prompt: 'Please ask the user: "Which repositories to initialise? Reply: (a)ll, (c)urrent, or numbers like 1,3"' } }) };
      }

      if (step === 'repo_selection') {
        if (!rootsArg) {
          return { response: toolResponse({ content: [{ type: 'text', text: 'Missing roots parameter. Pass the roots value from the previous step.' }], structuredContent: { error: 'missing_roots' } }, true) };
        }
        const roots = parseRoots(rootsArg, env);
        const repos = scanGitRepos(roots);
        const selectedRepos = parseRepoSelection(choice, repos, cwd);
        const detected = detectAiAgent(env);
        const agentList = ALL_KNOWN_AGENTS.map((a, i) => `  ${i + 1}) ${a}${a === detected?.name ? ' ← detected' : ''}`).join('\n');
        return { response: toolResponse({ content: [{ type: 'text', text: `Selected ${selectedRepos.length} repo(s). Detected AI agent: ${detected?.name ?? 'none'}.\n\nAvailable agents:\n${agentList}\n\nAsk the user which agents to configure.` }], structuredContent: { pending_question: 'agent_selection', roots: rootsArg, repo_selection: choice, selected_repos: selectedRepos.map((r) => ({ path: r.path, name: r.name })), detected_agent: detected?.name ?? null, all_agents: ALL_KNOWN_AGENTS, prompt: 'Please ask the user: "Which agents to configure? Reply: (d)etected, (a)ll, or agent names like claude-code,cursor"' } }) };
      }

      if (step === 'agent_selection') {
        if (!rootsArg || !repoSelectionArg) {
          return { response: toolResponse({ content: [{ type: 'text', text: 'Missing roots or repo_selection parameter from previous steps.' }], structuredContent: { error: 'missing_params' } }, true) };
        }
        const roots = parseRoots(rootsArg, env);
        const repos = scanGitRepos(roots);
        const selectedRepos = parseRepoSelection(repoSelectionArg, repos, cwd);
        const detected = detectAiAgent(env);
        const selectedAgents = parseAgentSelection(choice, detected?.name);
        const summary: string[] = [];
        const written = runGlobalInstall(selectedAgents, env);
        for (const f of written) summary.push(`✔ Global config: ${f}`);
        const { initialisedRepos, configActions } = await initReposAndConfigureAgents(selectedRepos, selectedAgents, env);
        for (const p of initialisedRepos) summary.push(`✔ Initialised repo: ${p}`);
        for (const a of configActions) summary.push(a);
        let reloadMsg = '✔ Setup complete! Reload your AI agent session to activate brainclaw MCP tools.';
        if (detected?.name === 'claude-code') reloadMsg += '\n  → In VS Code: Cmd/Ctrl+Shift+P → "Claude: Reload MCP Servers"';
        else if (detected?.name === 'cursor') reloadMsg += '\n  → In Cursor: restart the editor';
        else if (detected?.name === 'windsurf') reloadMsg += '\n  → In Windsurf: restart the editor';
        return { response: toolResponse({ content: [{ type: 'text', text: [reloadMsg, '', ...summary].join('\n') }], structuredContent: { setup_complete: true, initialised_repos: initialisedRepos, global_configs_written: written, agent_configs_written: configActions, detected_agent: detected?.name ?? null, summary } }) };
      }

      return { response: toolResponse({ content: [{ type: 'text', text: `Unknown step: "${step}". Valid steps: project_roots, repo_selection, agent_selection.` }], structuredContent: { error: 'unknown_step', step } }, true) };
    }

    if (name === 'bclaw_write_note') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const text = String(args.text ?? '');
      const tags = (args.tags as string[] | undefined) ?? [];
      const inputValidation = validateMcpInput(text, tags);
      if (!inputValidation.ok) {
        return { response: createToolErrorResponse('validation_error', inputValidation.errors[0]?.message ?? 'Invalid input', inputValidation.errors) };
      }
      const identity = resolved.identity!;

      // Cross-project push
      if (args.crossProject) {
        try {
          const link = resolveCrossProjectTarget(String(args.crossProject), cwd);
          const opIdentity = buildOperationalIdentity(identity.agent_name, cwd, {
            agentId: identity.agent_id,
            sessionId: connectionSessionId,
          });
          const noteId = generateId('rtn');
          writeCrossProjectNote(link.absolutePath, {
            schema_version: 2,
            id: noteId,
            agent: opIdentity.agent,
            agent_id: opIdentity.agent_id,
            project_id: opIdentity.project_id ?? '',
            session_id: opIdentity.session_id,
            text,
            created_at: nowISO(),
            tags,
            visibility: 'shared',
            host_id: opIdentity.host_id ?? '',
            note_type: 'observation',
          }, cwd);
          return {
            response: toolResponse({
              content: [{ type: 'text', text: `✔ Cross-project note pushed to '${link.projectName}' [${noteId}]` }],
              note_id: noteId,
              target_project: link.projectName,
              target_path: link.absolutePath,
            }),
          };
        } catch (e: unknown) {
          return { response: createToolErrorResponse('validation_error', e instanceof Error ? e.message : String(e)) };
        }
      }

      const result = createRuntimeNote(text, {
        agent: identity.agent_name,
        agentId: identity.agent_id,
        tag: tags,
        visibility: (args.visibility as MemoryVisibility | undefined) ?? 'shared',
        ttl: args.ttl as string | undefined,
        autoReflect: args.autoReflect as boolean | undefined,
        cwd,
        sessionId: connectionSessionId,
        model: currentModel,
      }, false);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Note created [${result.noteId}]` }],
          note_id: result.noteId,
          session_id: result.sessionId,
          auto_reflect_attempted: result.autoReflectAttempted,
          detected_type: result.detectedType,
          candidate_id: result.candidateId,
          promoted_item_id: result.promotedItemId,
          skip_reason: result.skipReason,
        }),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : result.sessionId,
      };
    }

    if (name === 'bclaw_create_candidate') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const candidateText = String(args.text ?? '');
      const candidateTags = (args.tags as string[] | undefined) ?? [];
      const candidateValidation = validateMcpInput(candidateText, candidateTags);
      if (!candidateValidation.ok) {
        return { response: createToolErrorResponse('validation_error', candidateValidation.errors[0]?.message ?? 'Invalid input', candidateValidation.errors) };
      }
      const resolvedIdentity = resolved.identity!;
      const identity = buildOperationalIdentity(resolvedIdentity.agent_name, cwd, {
        agentId: resolvedIdentity.agent_id,
        sessionId: connectionSessionId,
      });
      const type = String(args.type ?? 'decision') as CandidateType;
      const candidatePlanId = args.planId as string | undefined;
      const candidateScope = args.scope as string | undefined;
      const targetStore = args.store as string | undefined;

      // Cross-project report: save candidate in a linked project
      const targetProjectArg = args.targetProject as string | undefined;
      if (targetProjectArg) {
        const targetLink = resolveCrossProjectTarget(targetProjectArg, cwd);
        if (!targetLink) {
          return { response: createToolErrorResponse('not_found', `Cross-project target not found: ${targetProjectArg}. Declare it in cross_project_links config.`) };
        }
        const targetCwd = targetLink.absolutePath;
        const candId = generateCandidateIdWithLabel(targetCwd);
        const sourceConfig = loadConfig(cwd);
        const candidate: any = {
          id: candId.id, short_label: candId.short_label, type, text: candidateText,
          created_at: nowISO(),
          author: identity.agent, author_id: identity.agent_id,
          project_id: identity.project_id, host_id: identity.host_id, session_id: identity.session_id,
          source: `cross-project:${sourceConfig.project_name ?? 'unknown'}`,
          tags: [...candidateTags, 'cross-project-report'],
          status: 'pending' as const,
          severity: type === 'trap' ? ((args.severity as 'low' | 'medium' | 'high' | undefined) ?? 'medium') : undefined,
          plan_id: candidatePlanId, scope: candidateScope,
          model: currentModel,
          star_count: 0, starred_by: [], usage_count: 0, usage_events: [],
        };
        saveCandidate(candidate, targetCwd);
        appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: candId.id, item_type: type }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Cross-project report [${candId.short_label}] sent to ${targetLink.projectName} (pending review in target project)` }],
            candidate_id: candId.id,
            target_project: targetLink.projectName,
            target_path: targetLink.absolutePath,
            write_through: false,
          }),
          nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
        };
      }

      const candId = generateCandidateIdWithLabel(cwd);
      const writeThrough = agentCanWriteDirect(identity.agent_id ?? resolvedIdentity.agent_id, cwd);
      const effectiveCwd = targetStore ? resolveTargetStore(cwd, targetStore as StoreTarget) : cwd;
      const candidate: any = {
        id: candId.id,
        short_label: candId.short_label,
        type,
        text: candidateText,
        created_at: nowISO(),
        author: identity.agent,
        author_id: identity.agent_id,
        project_id: identity.project_id,
        host_id: identity.host_id,
        session_id: identity.session_id,
        tags: candidateTags,
        status: 'pending' as const,
        severity: type === 'trap' ? ((args.severity as 'low' | 'medium' | 'high' | undefined) ?? 'medium') : undefined,
        category: type === 'constraint' ? (args.category as string | undefined) : undefined,
        outcome: type === 'decision' ? (args.outcome as string | undefined) : undefined,
        scope: candidateScope,
        plan_id: candidatePlanId,
        model: currentModel,
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      };
      const planPrompt = (type === 'decision' || type === 'trap') && !candidatePlanId
        ? `\n💡 Does this ${type} relate to an active plan item? If so, re-run with planId: 'pln_xxx' to link it.`
        : '';
      const storeLabel = targetStore && targetStore !== 'local' ? ` [store: ${targetStore}]` : '';
      if (writeThrough) {
        saveCandidate(candidate, effectiveCwd);
        const accepted = acceptCandidate(candId.id, resolvedIdentity.agent_name, effectiveCwd, resolvedIdentity.agent_id);
        appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'promote_direct', item_id: candId.id, item_type: type }, effectiveCwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Direct write [${candId.short_label}] (trusted agent)${storeLabel}${planPrompt}` }],
            candidate_id: candId.id,
            promoted_item_id: accepted.promoted_item_id,
            write_through: true,
            store: targetStore ?? 'local',
            scope: candidateScope,
          }),
          nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
        };
      }
      saveCandidate(candidate, effectiveCwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: candId.id, item_type: type }, effectiveCwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Candidate created [${candId.short_label}] (pending review)${planPrompt}` }],
          candidate_id: candId.id,
          write_through: false,
        }),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
      };
    }

    if (name === 'bclaw_accept') {
      const resolved = ensureTrust(
        { ...args, by: args.by ?? args.agent, byId: args.byId ?? args.agentId },
        { nameField: 'by', idField: 'byId' },
        'trusted',
        cwd,
        connectionSessionId,
      );
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const candId = String(args.id ?? '').trim();
      if (!candId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      const accepted = acceptCandidate(candId, resolved.identity!.agent_name, cwd, resolved.identity!.agent_id);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Accepted [${candId}]` }],
          candidate_id: candId,
          promoted_item_id: accepted.promoted_item_id,
        }),
      };
    }

    if (name === 'bclaw_reject') {
      const resolved = ensureTrust(
        { ...args, by: args.by ?? args.agent, byId: args.byId ?? args.agentId },
        { nameField: 'by', idField: 'byId' },
        'trusted',
        cwd,
        connectionSessionId,
      );
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const candId = String(args.id ?? '').trim();
      if (!candId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      rejectCandidate(candId, args.reason as string | undefined, resolved.identity!.agent_name, cwd, resolved.identity!.agent_id);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Rejected [${candId}]` }],
          candidate_id: candId,
        }),
      };
    }

    if (name === 'bclaw_claim') {
      // Resolve project-scoped cwd before store resolution (fixes worktree in wrong project)
      let effectiveClaimCwd = cwd;
      const claimProjectArg = args.project as string | undefined;
      if (claimProjectArg) {
        const resolvedProject = resolveProjectRef(claimProjectArg, cwd);
        if (resolvedProject) effectiveClaimCwd = resolvedProject;
      }
      const storeTarget = (args.store as StoreTarget | undefined) ?? 'local';
      const claimCwd = resolveTargetStore(effectiveClaimCwd, storeTarget);
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', claimCwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const claimScope = String(args.scope ?? '').trim();
      const claimDescription = String(args.description ?? '').trim();
      const scopeCheck = validateMcpField(claimScope, 'scope');
      if (!scopeCheck.ok) {
        return { response: createToolErrorResponse('validation_error', scopeCheck.message) };
      }
      const descCheck = validateMcpField(claimDescription, 'description');
      if (!descCheck.ok) {
        return { response: createToolErrorResponse('validation_error', descCheck.message) };
      }
      const resolvedIdentity = resolved.identity!;
      const identity = buildOperationalIdentity(resolvedIdentity.agent_name, claimCwd, {
        agentId: resolvedIdentity.agent_id,
        sessionId: connectionSessionId,
      });
      const claimId = generateClaimId();
      let worktreePath: string | undefined;
      let worktreeWarn = '';
      // Always create worktree in MCP context for multi-agent isolation.
      // The createWorktree param is no longer exposed in the schema.
      {
        const branchSlug = claimScope.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 48);
        const worktreeBranch = (args.worktreeBranch as string | undefined)?.trim() || `feat/${branchSlug}`;
        try {
          worktreePath = coreCreateWorktree(claimCwd, worktreeBranch, {
            sessionId: identity.session_id,
            agent: identity.agent,
          });
        } catch (wtErr) {
          worktreeWarn = `\n⚠ Worktree creation failed: ${wtErr instanceof Error ? wtErr.message : String(wtErr)}`;
        }
      }
      const claimTtl = args.ttl as string | undefined;
      const claimExpiresAt = claimTtl ? parseTtl(claimTtl) : undefined;
      saveClaim({
        id: claimId,
        agent: identity.agent,
        agent_id: identity.agent_id,
        user: process.env.USER || process.env.USERNAME || undefined,
        project_id: identity.project_id,
        host_id: identity.host_id,
        session_id: identity.session_id,
        scope: claimScope,
        description: claimDescription,
        created_at: nowISO(),
        status: 'active',
        plan_id: args.planId as string | undefined,
        model: currentModel,
        worktree_path: worktreePath,
        expires_at: claimExpiresAt,
      }, claimCwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'claim', item_id: claimId, item_type: 'claim', scope: claimScope, session_id: identity.session_id, host_id: identity.host_id }, claimCwd);

      // Post-claim policy check: surface constraints/traps as warnings
      const policyResult = checkPolicy({
        scope: claimScope,
        agent: resolvedIdentity.agent_name,
        agentId: resolvedIdentity.agent_id,
        cwd: claimCwd,
      });
      let policyWarn = '';
      const policyWarnings = policyResult.warnings.filter(w => w.kind !== 'no_claim');
      if (policyWarnings.length > 0) {
        policyWarn = '\n\nPolicy warnings for this scope:';
        for (const w of policyWarnings) {
          const idLabel = w.id ? ` (${w.id})` : '';
          policyWarn += `\n  ⚠ [${w.kind}]${idLabel} ${w.message}`;
        }
      }

      const postClaimItems = getTriggeredItems('trigger:post-claim', claimCwd);
      const postClaimText = renderTriggeredItems(postClaimItems);
      const noPlanWarn = !(args.planId as string | undefined)
        ? '\n⚠ No plan item linked to this claim. Run bclaw_create_plan first and pass planId to track this work formally.'
        : '';
      // Branch guardrail: warn if on master/main without a worktree
      let branchWarn = '';
      if (!worktreePath) {
        try {
          const { execSync } = await import('node:child_process');
          const branch = execSync('git branch --show-current', { cwd: claimCwd, encoding: 'utf-8' }).trim();
          if (branch === 'master' || branch === 'main') {
            const branchSlug = claimScope.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 48);
            branchWarn = `\n⚠️ You are on ${branch}. Create a feature branch before editing: git checkout -b feat/${branchSlug}`;
          }
        } catch { /* git not available, skip warning */ }
      }
      const worktreeNote = worktreePath ? `\n  Worktree: ${worktreePath}` : '';
      const expiryNote = claimExpiresAt ? `\n  Expires: ${claimExpiresAt.slice(0, 16).replace('T', ' ')} UTC` : '';
      const claimText = `✔ Claimed scope [${claimId}]${worktreeNote}${expiryNote}${noPlanWarn}${worktreeWarn}${branchWarn}${policyWarn}${postClaimText ? `\n${postClaimText}` : ''}`;

      return {
        response: toolResponse({
          content: [{ type: 'text', text: claimText }],
          claim_id: claimId,
          session_id: identity.session_id,
          worktree_path: worktreePath,
          triggered_items: postClaimItems,
        }),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
      };
    }

    if (name === 'bclaw_release_claim') {
      const claimId = String(args.id ?? '').trim();
      if (!claimId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      let claimObj;
      try {
        claimObj = loadClaim(claimId, cwd);
      } catch {
        return { response: createToolErrorResponse('not_found', `Claim not found: ${claimId}`) };
      }
      saveClaim({ ...claimObj, status: 'released' as const, released_at: nowISO() }, cwd);
      appendAuditEntry({ actor: claimObj.agent, actor_id: claimObj.agent_id, action: 'release_claim', item_id: claimId, item_type: 'claim', scope: claimObj.scope, session_id: claimObj.session_id, host_id: claimObj.host_id }, cwd);
      const releasePlanStatus = args.planStatus as string | undefined;
      let releasePlanUpdated = false;
      if (releasePlanStatus && claimObj.plan_id) {
        const releaseState = loadState(cwd);
        const releasePlan = releaseState.plan_items.find((item) => item.id === claimObj.plan_id);
        if (releasePlan) {
          const ts = nowISO();
          releasePlan.status = releasePlanStatus as PlanStatus;
          if (releasePlanStatus === 'in_progress' && !releasePlan.started_at) releasePlan.started_at = ts;
          if (releasePlanStatus === 'done' && !releasePlan.completed_at) releasePlan.completed_at = ts;
          releasePlan.updated_at = ts;
          persistState(releaseState, cwd);
          releasePlanUpdated = true;
        }
      }
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Released claim [${claimId}]${releasePlanUpdated ? ` — plan ${claimObj.plan_id} → ${releasePlanStatus}` : ''}` }],
          claim_id: claimId,
          ...(releasePlanUpdated ? { plan_id: claimObj.plan_id, plan_status: releasePlanStatus } : {}),
        }),
      };
    }

    if (name === 'bclaw_session_start') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const result = startSession({
        agent: resolved.identity?.agent_name,
        agentId: resolved.identity?.agent_id,
        context: args.context as string | undefined,
        cwd,
      });

      const postSessionStartItems = getTriggeredItems('trigger:post-session-start', cwd);
      const postSessionStartText = renderTriggeredItems(postSessionStartItems);
      const sessionUpdateConfig = loadConfig(cwd);
      const sessionUpdateCheck = checkBrainclawInstallableUpdate(sessionUpdateConfig, cwd, { useDefaultNpmSource: true });
      const sessionUpdateNotice = renderBrainclawInstallableUpdateNotice(sessionUpdateCheck);
      // Stale instructions guardrail: check if agent files match current version
      let staleInstructionsWarn = '';
      {
        const currentVersion = getInstalledBrainclawVersion();
        const agentFilesToCheck = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];
        for (const relPath of agentFilesToCheck) {
          try {
            const fullPath = path.join(cwd, relPath);
            const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 200);
            const match = content.match(/brainclaw v(\d+\.\d+\.\d+)/);
            if (match && match[1] !== currentVersion) {
              staleInstructionsWarn = `\n⚠️ Agent instruction files are stale (generated by v${match[1]}, current is v${currentVersion}). Run: brainclaw export --all`;
              break;
            }
          } catch { /* file doesn't exist, skip */ }
        }
      }
      const sessionStartMsgParts = ['✔ Session started'];
      if (staleInstructionsWarn) sessionStartMsgParts.push(staleInstructionsWarn);
      if (sessionUpdateNotice) sessionStartMsgParts.push(sessionUpdateNotice);
      if (postSessionStartText) sessionStartMsgParts.push(postSessionStartText);
      const sessionStartMsg = sessionStartMsgParts.join('\n');

      const contentParts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: sessionStartMsg }];
      const structured: Record<string, unknown> = {
        session_id: result.session_id,
        agent: result.agent,
        context_target: result.context_target,
      };

      if (args.includeContext) {
        const ctxResult = buildContext({
          target: args.context as string | undefined,
          agent: resolved.identity?.agent_name,
          profile: args.contextProfile as 'dev' | 'dense' | 'openclaw' | 'ops' | 'research' | 'compact' | 'copilot' | 'quick' | undefined,
          cwd,
        });
        const format = normaliseFormat(args.contextFormat);
        const ctxText = renderContextForMcp(ctxResult, format, {});
        contentParts.push({ type: 'text', text: ctxText || 'No relevant memory found.' });
        structured.context = ctxResult;
      }

      if (args.includeBoard) {
        const board = buildCoordinationSnapshot({
          agent: resolved.identity?.agent_name,
          autoAcknowledge: true,
          cwd,
        });
        const boardLines: string[] = [];
        boardLines.push(`Active plans: ${board.active_plans.length}`);
        for (const plan of board.active_plans.slice(0, 10)) {
          const claims = plan.claims.length ? ` claims=${plan.claims.map((c) => c.agent).join(',')}` : '';
          boardLines.push(`- [${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})${claims}`);
        }
        boardLines.push(`Active claims: ${board.active_claims.length}`);
        for (const claim of board.active_claims.slice(0, 10)) {
          boardLines.push(`- [${claim.id}] ${claim.agent} -> ${claim.scope}`);
        }
        boardLines.push(`Open handoffs: ${board.open_handoffs.length}`);
        for (const handoff of board.open_handoffs.slice(0, 5)) {
          boardLines.push(`- [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}`);
        }
        contentParts.push({ type: 'text', text: boardLines.join('\n') });
        structured.board = board;
      }

      return {
        response: toolResponse({
          content: contentParts,
          ...structured,
        }),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : result.session_id,
      };
    }

    if (name === 'bclaw_session_end') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const result = endSession({
        session: args.session as string | undefined,
        agent: resolved.identity?.agent_name,
        agentId: resolved.identity?.agent_id,
        summary: args.summary as string | undefined,
        narrative: args.narrative as string | undefined,
        autoReflect: args.autoReflect as boolean | undefined,
        reflect: args.reflect as boolean | undefined,
        cwd,
      });
      const preSessionEndItems = getTriggeredItems('trigger:pre-session-end', cwd);
      const preSessionEndText = renderTriggeredItems(preSessionEndItems);
      const endUpdateConfig = loadConfig(cwd);
      const endUpdateCheck = checkBrainclawInstallableUpdate(endUpdateConfig, cwd, { useDefaultNpmSource: true });
      const endUpdateNotice = renderBrainclawInstallableUpdateNotice(endUpdateCheck);

      const parts: string[] = ['✔ Session ended'];
      if (endUpdateNotice) parts.push(endUpdateNotice);
      if (preSessionEndText) parts.push(preSessionEndText);
      if (result.reflection_prompt) {
        parts.push('\n📝 Session reflection — please answer these questions:');
        for (let i = 0; i < result.reflection_prompt.questions.length; i++) {
          parts.push(`  ${i + 1}. ${result.reflection_prompt.questions[i]}`);
        }
        parts.push(`\n${result.reflection_prompt.instruction}`);
      }

      return {
        response: toolResponse({
          content: [{ type: 'text', text: parts.join('\n') }],
          session_id: result.session_id,
          notes_in_session: result.notes_in_session,
          candidates_created: result.candidates_created,
          context_diff: result.context_diff,
          triggered_items: preSessionEndItems,
          ...(result.reflection_prompt ? { reflection_prompt: result.reflection_prompt } : {}),
        }),
        nextConnectionSessionId: undefined,
      };
    }

    if (name === 'bclaw_create_plan') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const planText = String(args.text ?? '').trim();
      if (!planText) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
      }
      const textCheck = validateMcpField(planText, 'text');
      if (!textCheck.ok) {
        return { response: createToolErrorResponse('validation_error', textCheck.message) };
      }
      let estimatedEffort: number | undefined;
      if (args.estimate !== undefined) {
        const n = Number(args.estimate);
        if (!Number.isInteger(n) || n <= 0) {
          return { response: createToolErrorResponse('validation_error', 'estimate must be a positive integer (minutes)') };
        }
        estimatedEffort = n;
      }
      try {
        const result = createPlan({
          text: planText,
          author: resolved.identity!.agent_name,
          type: args.type as PlanType | undefined,
          priority: (args.priority as Priority) ?? 'medium',
          assignee: args.assignee as string | undefined,
          tags: (args.tags as string[]) ?? [],
          estimatedEffort,
        }, cwd);
        appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'create', item_id: result.id, item_type: 'plan' }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Plan item added: [${result.id}] ${planText}` }],
            plan_id: result.id,
          }),
        };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_update_plan') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const planId = String(args.id ?? '').trim();
      if (!planId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      try {
        const result = updatePlanOp({
          id: planId,
          status: args.status as PlanStatus | undefined,
          assignee: args.assignee as string | undefined,
          priority: args.priority as Priority | undefined,
          actualEffort: args.actualEffort as string | undefined,
        }, cwd);
        appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: result.id, item_type: 'plan' }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Plan item updated: [${result.id}] ${result.text}` }],
            plan_id: result.id,
            status: result.status,
          }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return { response: createToolErrorResponse('not_found', msg) };
        }
        return { response: createToolErrorResponse('operation_error', msg) };
      }
    }

    if (name === 'bclaw_add_step') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const stepPlanId = String(args.planId ?? '').trim();
      const stepText = String(args.text ?? '').trim();
      if (!stepPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!stepText) return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
      try {
        const result = addStepOp({ planId: stepPlanId, text: stepText, assignee: args.assignee as string | undefined }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Step added: [${result.stepId}] ${stepText} (${result.doneSteps}/${result.totalSteps} done)` }],
            step_id: result.stepId,
            plan_id: result.planId,
            progress: { done: result.doneSteps, total: result.totalSteps },
          }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return { response: createToolErrorResponse('not_found', msg) };
        }
        return { response: createToolErrorResponse('operation_error', msg) };
      }
    }

    if (name === 'bclaw_complete_step') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const csPlanId = String(args.planId ?? '').trim();
      const csStepId = String(args.stepId ?? '').trim();
      if (!csPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!csStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
      try {
        const result = completeStepOp({ planId: csPlanId, stepId: csStepId }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Step completed: [${result.stepId}] (${result.doneSteps}/${result.totalSteps} done)` }],
            step_id: result.stepId,
            plan_id: result.planId,
            progress: { done: result.doneSteps, total: result.totalSteps },
            all_done: result.doneSteps === result.totalSteps,
          }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return { response: createToolErrorResponse('not_found', msg) };
        }
        return { response: createToolErrorResponse('operation_error', msg) };
      }
    }

    if (name === 'bclaw_delete_memory') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const itemId = String(args.id ?? '').trim();
      const itemType = String(args.type ?? '').trim();
      if (!itemId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      if (!itemType) return { response: createToolErrorResponse('validation_error', 'Missing required argument: type') };
      if (!['constraint', 'decision', 'trap'].includes(itemType)) {
        return { response: createToolErrorResponse('validation_error', `Invalid type: ${itemType}`) };
      }
      try {
        const result = deleteMemoryItem(itemId, itemType as MemoryItemType, cwd);
        appendAuditEntry(
          { actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'delete', item_id: itemId, item_type: itemType as CandidateType },
          cwd,
        );
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Deleted [${itemId}] (${itemType})` }],
            deleted_id: result.deletedId,
            item_type: result.itemType,
            store_level: result.storeRole,
          }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return { response: createToolErrorResponse('not_found', msg) };
        }
        return { response: createToolErrorResponse('operation_error', msg) };
      }
    }

    if (name === 'bclaw_update_memory') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const itemId = String(args.id ?? '').trim();
      const itemType = String(args.type ?? '').trim();
      const newText = args.text ? String(args.text).trim() : undefined;
      const newTags = Array.isArray(args.tags) ? args.tags.map((t) => String(t).trim()) : undefined;
      const newStatus = args.status ? String(args.status).trim() : undefined;
      const moveToStore = args.moveToStore ? String(args.moveToStore).trim() : undefined;

      if (!itemId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      if (!itemType) return { response: createToolErrorResponse('validation_error', 'Missing required argument: type') };
      if (!['constraint', 'decision', 'trap'].includes(itemType)) {
        return { response: createToolErrorResponse('validation_error', `Invalid type for update: ${itemType}`) };
      }
      if (!newText && !newTags && !newStatus && !moveToStore) {
        return { response: createToolErrorResponse('validation_error', 'At least one of text, tags, status, or moveToStore must be provided') };
      }
      if (moveToStore && !['local', 'repo', 'workspace', 'user'].includes(moveToStore)) {
        return { response: createToolErrorResponse('validation_error', `Invalid moveToStore target: ${moveToStore}`) };
      }
      if (newStatus && itemType !== 'trap') {
        return { response: createToolErrorResponse('validation_error', 'status updates are only supported for traps') };
      }
      if (newStatus && !['active', 'resolved', 'expired'].includes(newStatus)) {
        return { response: createToolErrorResponse('validation_error', `Invalid trap status: ${newStatus}`) };
      }
      try {
        const result = updateMemoryItem({
          id: itemId,
          type: itemType as MemoryItemType,
          text: newText,
          tags: newTags,
          status: newStatus,
          moveToStore: moveToStore as StoreTarget | undefined,
        }, cwd);
        appendAuditEntry(
          { actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: itemId, item_type: itemType as CandidateType },
          cwd,
        );
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Updated [${itemId}] (${itemType})` }],
            updated_id: result.updatedId,
            item_type: result.itemType,
            previous_store: result.previousStore,
            new_store: result.newStore,
          }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return { response: createToolErrorResponse('not_found', msg) };
        }
        return { response: createToolErrorResponse('operation_error', msg) };
      }
    }

    if (name === 'bclaw_add_capability') {
      const capName = String(args.name ?? '').trim();
      const capDesc = String(args.description ?? '').trim();
      if (!capName || !capDesc) {
        return { response: createToolErrorResponse('validation_error', 'Missing required arguments: name and description') };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const resolvedIdentity = resolved.identity!;
      const extraTags = Array.isArray(args.tags) ? args.tags as string[] : [];
      const cap = createCapability({
        name: capName,
        description: capDesc,
        tags: extraTags,
        author: resolvedIdentity.agent_name,
        authorId: resolvedIdentity.agent_id,
        model: currentModel,
      }, cwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: cap.id, item_type: 'capability', reason: `capability: ${capName}` }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Capability registered: [${cap.id}] ${capName}` }],
          id: cap.id,
          name: capName,
          schema_version: SCHEMA_VERSION,
        }),
      };
    }

    if (name === 'bclaw_add_tool') {
      const toolName = String(args.name ?? '').trim();
      const toolDesc = String(args.description ?? '').trim();
      if (!toolName || !toolDesc) {
        return { response: createToolErrorResponse('validation_error', 'Missing required arguments: name and description') };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const resolvedIdentity = resolved.identity!;
      const toolType = String(args.type ?? 'utility');
      const extraTags = Array.isArray(args.tags) ? args.tags as string[] : [];
      const tool = createRegistryTool({
        name: toolName,
        description: toolDesc,
        type: toolType,
        tags: extraTags,
        author: resolvedIdentity.agent_name,
        authorId: resolvedIdentity.agent_id,
        model: currentModel,
      }, cwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: tool.id, item_type: 'tool', reason: `tool: ${toolName}` }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Tool registered: [${tool.id}] ${toolName} (${toolType})` }],
          id: tool.id,
          name: toolName,
          type: toolType,
          schema_version: SCHEMA_VERSION,
        }),
      };
    }

    if (name === 'bclaw_update_handoff') {
      const handoffId = String(args.id ?? '').trim();
      if (!handoffId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const resolvedIdentity = resolved.identity!;
      const state = loadState(cwd);
      const handoff = state.open_handoffs.find((h) => h.id === handoffId);
      if (!handoff) {
        return { response: createToolErrorResponse('not_found', `Handoff not found: ${handoffId}`) };
      }
      if (args.status) handoff.status = args.status as 'open' | 'closed';
      if (args.to) handoff.to = String(args.to);
      if (args.narrative) handoff.narrative = String(args.narrative);
      // Update contract fields
      const contractUpdates: Record<string, string[]> = {};
      for (const key of ['files_touched', 'pre_conditions', 'post_conditions', 'tests_to_verify', 'linked_plans'] as const) {
        if (Array.isArray(args[key])) contractUpdates[key] = args[key] as string[];
      }
      if (Object.keys(contractUpdates).length > 0) {
        handoff.contract = { ...handoff.contract, ...contractUpdates };
      }
      saveState(state, cwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'update', item_id: handoffId, item_type: 'handoff' }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Handoff updated: [${handoffId}] ${handoff.from} → ${handoff.to} (${handoff.status})` }],
          handoff_id: handoffId,
          status: handoff.status,
          to: handoff.to,
          schema_version: SCHEMA_VERSION,
        }),
      };
    }

    return {
      response: createToolErrorResponse('unknown_tool', `Unknown tool: ${name}`),
    };
  } catch (error: unknown) {
    return {
      response: createToolErrorResponse('command_error', error instanceof Error ? error.message : String(error)),
    };
  }
}
