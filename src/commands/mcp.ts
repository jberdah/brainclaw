import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { resolveCrossProjectTarget, writeCrossProjectNote } from '../core/cross-project.js';
import { applyBootstrapImport, renderBootstrapInterview, renderBootstrapSummary, runBootstrapProfile, uninstallBootstrapImport } from '../core/bootstrap.js';
import { buildAgentToolingContext, renderAgentToolingSummary } from '../core/agent-context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { buildExecutionContext, renderExecutionContextSummary } from '../core/execution-context.js';
import { checkBrainclawInstallableUpdate, getInstalledBrainclawVersion, readDiskBrainclawVersion, renderBrainclawInstallableUpdateNotice } from '../core/brainclaw-version.js';
import { loadConfig } from '../core/config.js';
import { loadAllSessions, loadCurrentSession, saveCurrentSession, gcStaleSessions } from '../core/identity.js';
import { loadState, mutateState, persistState, saveState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { generateCandidateIdWithLabel, listArchivedCandidates, listCandidates, saveCandidate } from '../core/candidates.js';
import { generateClaimId, listClaims, loadClaim, saveClaim } from '../core/claims.js';
import { createWorktree as coreCreateWorktree } from '../core/worktree.js';
import { createRuntimeNote } from './runtime-note.js';
import { acceptCandidate } from './accept.js';
import { rejectCandidate } from './reject.js';
import { startSession } from './session-start.js';
import { endSession } from './session-end.js';
import { switchProject, listAvailableProjects } from './switch.js';
import {
  agentCanWriteDirect,
  AgentIdentityResolutionError,
  AgentTrustError,
  listAgentIdentities,
  requireMinimumTrustLevel,
  requireRegisteredAgentIdentity,
  resolveAgentScope,
  resolveCurrentAgentIdentity,
  resolveCurrentAgentName,
  resolveCurrentModel,
} from '../core/agent-registry.js';
import { appendAuditEntry, readAuditLog, type AuditAction } from '../core/audit.js';
import { nowISO, generateIdWithLabel, generateId } from '../core/ids.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from '../core/instructions.js';
import { buildReputationSnapshot, toPublicReputationSummary } from '../core/reputation.js';
import { search } from '../core/search.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { validateMcpInput, validateMcpField } from '../core/input-validation.js';
import { buildEstimationReport } from './estimation-report.js';
import { runDoctor } from './doctor.js';
import { buildProjectDiscovery, saveDiscoveryProfile, loadDiscoveryProfile, renderDiscoverySummary } from '../core/project-discovery.js';
import { listCapabilities, listTools as listRegistryTools, createCapability, createTool as createRegistryTool } from '../core/registries.js';
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
import { resolveEffectiveCwd, resolveProjectRef, resolveTargetStore, resolveStoreChain, type StoreTarget } from '../core/store-resolution.js';
import { probeForQuickSetup, buildQuickSetupProbeResponse, buildOnboardingPreview, type ProjectTypeChoice, type TopologyChoice } from '../core/setup-flow.js';
import { ensureUserStore } from '../core/setup-state.js';
import { readUnseenEvents, buildNotificationSummary } from '../core/event-log.js';
import { BootstrapInterviewAnswerSchema } from '../core/schema.js';
import type { BootstrapInterviewAnswer, CandidateType, Constraint, Decision, MemoryVisibility, PlanItem, PlanStep, PlanStatus, PlanType, Priority, Trap } from '../core/schema.js';

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
        profile: { type: 'string', description: 'Optional profile override: dev, openclaw, ops, research.' },
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
    description: 'View the append-only audit log of all memory mutations.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Show entries since this ISO date.' },
        actor: { type: 'string', description: 'Filter by actor name or agent ID.' },
        action: { type: 'string', description: 'Filter by action type (create, accept, reject, etc.).' },
        limit: { type: 'number', description: 'Show last N entries (default 20).' },
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
    description: 'Claim a work scope (advisory lock). Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Scope being claimed.' },
        description: { type: 'string', description: 'Description of the work.' },
        agent: { type: 'string', description: 'Agent or person name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        planId: { type: 'string', description: 'Optional linked plan item ID.' },
        store: { type: 'string', description: 'Target store level: local (default), repo, workspace.' },
        createWorktree: { type: 'boolean', description: 'If true, create a git linked worktree for this claim (requires a branch name via worktreeBranch).' },
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
        contextProfile: { type: 'string', description: 'Context profile when includeContext is true: dev, openclaw, ops, research.' },
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

function normalizeBootstrapInterviewAnswersArg(value: unknown): BootstrapInterviewAnswer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => BootstrapInterviewAnswerSchema.parse(entry));
}

function normalizeBootstrapInterviewAudienceArg(value: unknown): 'cli' | 'ide_chat' | 'any' {
  if (value === 'cli' || value === 'ide_chat' || value === 'any') {
    return value;
  }
  return 'any';
}

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
  if (!isSupportedProtocolVersion(requested)) {
    throw new McpProtocolError(
      -32602,
      'Unsupported protocol version',
      id,
      { supportedVersions: MCP_PROTOCOL_VERSIONS },
    );
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

function resolveMutationIdentity(args: Record<string, unknown>, fields: { nameField: string; idField: string }, cwd?: string) {
  try {
    return {
      identity: requireRegisteredAgentIdentity({
        agentName: typeof args[fields.nameField] === 'string' ? String(args[fields.nameField]) : undefined,
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
): { identity?: ReturnType<typeof requireRegisteredAgentIdentity>; error?: McpToolErrorShape } {
  const resolved = resolveMutationIdentity(args, fields, cwd);
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
 * Bi-modal stdin parser that accepts both Content-Length framed messages
 * (MCP/LSP standard) and legacy newline-delimited JSON.
 *
 * Detection: if the first non-empty data starts with "Content-Length:",
 * we use Content-Length mode for the rest of the connection.
 * Otherwise, we fall back to newline-delimited mode.
 */
export class StdioTransport {
  private buffer = Buffer.alloc(0);
  private mode: 'detecting' | 'content-length' | 'newline' = 'detecting';
  private onMessage: (line: string) => void;
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
    if (this.mode === 'detecting') {
      // Skip leading whitespace/newlines to detect mode
      const str = this.buffer.toString('utf-8');
      const trimmed = str.trimStart();
      if (trimmed.length === 0) return; // need more data
      this.mode = trimmed.startsWith('Content-Length:') ? 'content-length' : 'newline';
    }

    if (this.mode === 'content-length') {
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

  const connection = new McpServerConnection({
    cwd,
    send: sendContentLengthFramed,
  });

  const transport = new StdioTransport(
    (line) => connection.handleLine(line),
    () => connection.close(),
  );
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

function getReviewAssignee(tags: string[]): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith('assignee:')) {
      return tag.slice('assignee:'.length).trim() || undefined;
    }
  }
  return undefined;
}

export function handleMcpReadToolCall(
  name: string,
  args: Record<string, unknown> = {},
  context: McpReadToolContext = {},
): McpToolResponse {
  let cwd = context.cwd ?? resolveEffectiveCwd();

  // If a project param is provided, resolve it to an actual cwd override
  const projectArg = args.project as string | undefined;
  if (projectArg) {
    const resolvedProject = resolveProjectRef(projectArg, cwd);
    if (resolvedProject) {
      cwd = resolvedProject;
    }
  }

  if (name === 'bclaw_get_context') {
    const result = buildContext({
      target: args.path as string | undefined,
      project: projectArg,
      agent: args.agent as string | undefined,
      host: args.host as string | undefined,
      allHosts: args.allHosts as boolean | undefined,
      profile: args.profile as 'dev' | 'openclaw' | 'ops' | 'research' | undefined,
      includePending: args.includePending as boolean | undefined,
      maxItems: args.maxItems as number | undefined,
      maxChars: args.maxChars as number | undefined,
      digest: args.digest as boolean | undefined,
      sinceSession: args.since_session as string | undefined,
      bootstrap: args.bootstrap as boolean | undefined,
      refreshBootstrap: args.refreshBootstrap as boolean | undefined,
      cwd,
    });

    // Load available capabilities and tools from dedicated registries
    const capabilities = listCapabilities(cwd);
    const tools = listRegistryTools(cwd);

    const format = normaliseFormat(args.format);
    const content = renderContextForMcp(result, format, {
      explain: args.explain as boolean | undefined,
      compactTemplate: args.compactTemplate as boolean | undefined,
    });

    // Add metadata discovery section to content
    let enrichedContent = content;
    if (capabilities.length > 0 || tools.length > 0) {
      const suggestions: string[] = [];
      if (capabilities.length > 0) {
        suggestions.push(`\n## Available Capabilities (${capabilities.length})`);
        capabilities.slice(0, 5).forEach((cap) => {
          suggestions.push(`- [${cap.id}] ${cap.name} (${cap.category})`);
        });
        if (capabilities.length > 5) {
          suggestions.push(`- ... and ${capabilities.length - 5} more`);
        }
      }
      if (tools.length > 0) {
        suggestions.push(`\n## Available Tools (${tools.length})`);
        tools.slice(0, 5).forEach((tool) => {
          suggestions.push(`- [${tool.id}] ${tool.name} (${tool.type})`);
        });
        if (tools.length > 5) {
          suggestions.push(`- ... and ${tools.length - 5} more`);
        }
      }
      suggestions.push('\n💡 Tip: Use bclaw_get_capabilities, bclaw_list_tools, or bclaw_search_tools for detailed discovery');
      enrichedContent = content + suggestions.join('\n');
    }

    // Check for unseen events from other agents
    const agentName = (args.agent as string) ?? resolveCurrentAgentName(cwd);
    const unseenEvents = readUnseenEvents(agentName, cwd);
    const notifications = buildNotificationSummary(unseenEvents);

    return {
      content: [{ type: 'text', text: enrichedContent || 'No relevant memory found.' }],
      structuredContent: {
        ...result,
        available_capabilities: capabilities.map((cap) => ({
          id: cap.id,
          name: cap.name,
          category: cap.category,
        })),
        available_tools: tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          type: tool.type,
        })),
        ...(notifications ? { pending_notifications: notifications, unseen_event_count: unseenEvents.length } : {}),
      },
    };
  }

  if (name === 'bclaw_bootstrap') {
    const interviewAnswers = normalizeBootstrapInterviewAnswersArg(args.interviewAnswers);
    if (args.apply && args.uninstall) {
      throw new Error('bclaw_bootstrap does not allow apply and uninstall at the same time.');
    }
    if (args.uninstall) {
      const result = uninstallBootstrapImport(cwd);
      const text = !result.receipt
        ? 'No bootstrap import receipt found.'
        : `Bootstrap uninstall completed: ${result.deactivatedCount} instruction(s) deactivated, ${result.deletedCount} artifact(s) deleted, ${result.skippedCount} artifact(s) skipped.`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          receipt: result.receipt,
          deactivated_count: result.deactivatedCount,
          deleted_count: result.deletedCount,
          skipped_count: result.skippedCount,
        },
      };
    }
    if (args.apply) {
      const applied = applyBootstrapImport({
        target: args.target as string | undefined,
        refresh: args.refresh as boolean | undefined,
        interviewAnswers,
        cwd,
      });
      return {
        content: [{
          type: 'text',
          text: `Bootstrap import applied: ${applied.createdCount} item(s) created, ${applied.skippedCount} suggestion(s) skipped.`,
        }],
        structuredContent: {
          created_count: applied.createdCount,
          skipped_count: applied.skippedCount,
          receipt: applied.receipt,
          import_plan: applied.proposal,
        },
      };
    }
    const result = runBootstrapProfile({
      target: args.target as string | undefined,
      refresh: args.refresh as boolean | undefined,
      interviewAnswers,
      cwd,
    });
    const audience = normalizeBootstrapInterviewAudienceArg(args.audience);
    const text = args.interview
      ? renderBootstrapInterview(result, audience)
      : renderBootstrapSummary(result);

    // Extract top-level suggested questions for conversational bootstrap (step 11)
    const suggestedQuestions = result.importPlan.interview?.questions?.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      rationale: q.rationale,
      priority: q.priority,
    })) ?? [];

    // Separate auto-imports (high confidence) from proposals (need discussion)
    const autoImports = result.importPlan.suggestions.filter((s) => s.confidence === 'high');
    const proposals = result.importPlan.suggestions.filter((s) => s.confidence !== 'high');

    return {
      content: [{ type: 'text', text }],
        structuredContent: {
          summary: result.profile.summary,
          target: result.profile.target,
          repo_fingerprint: result.profile.repo_fingerprint,
          sources_scanned: result.profile.sources_scanned,
          workspace_kind: result.profile.workspace_kind,
        onboarding_mode: result.profile.onboarding_mode,
        confidence: result.profile.confidence,
        native_instruction_files: result.profile.native_instruction_files,
        gaps: result.profile.gaps,
        seed_count: result.profile.seed_count,
        seeds: result.seeds,
        import_plan: result.importPlan,
        auto_imports: autoImports,
        proposals,
        suggested_questions: suggestedQuestions,
        last_application: result.lastApplication,
        reused_profile: result.reusedProfile,
      },
    };
  }

  if (name === 'bclaw_get_execution_context') {
    const executionContext = buildExecutionContext({ cwd });
    const config = loadConfig(cwd);
    const installableUpdate = checkBrainclawInstallableUpdate(config, cwd, { useDefaultNpmSource: true });
    const installableUpdateNotice = renderBrainclawInstallableUpdateNotice(installableUpdate);
    const agentTooling = args.includeAgentTooling ? buildAgentToolingContext({ cwd }) : undefined;
    const text = [
      renderExecutionContextSummary(executionContext, true),
      ...(installableUpdateNotice ? ['', installableUpdateNotice] : []),
      ...(agentTooling ? ['', renderAgentToolingSummary(agentTooling)] : []),
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        execution_context: executionContext,
        installable_update: installableUpdate,
        ...(agentTooling ? { agent_tooling: agentTooling } : {}),
      },
    };
  }

  if (name === 'bclaw_read_handoff') {
    const state = loadState(cwd);
    const handoff = state.open_handoffs.find((entry) => entry.id === args.id);
    let text = `Handoff not found: ${String(args.id)}`;
    if (handoff) {
      text = `From: ${handoff.from}\nTo: ${handoff.to}\nTask: ${handoff.text}\n`;
      if (handoff.plan_id) text += `Plan: ${handoff.plan_id}\n`;
      if (handoff.contract) {
        const c = handoff.contract;
        text += '\n--- Contract ---\n';
        if (c.files_touched?.length) text += `Files touched:\n${c.files_touched.map(f => `  - ${f}`).join('\n')}\n`;
        if (c.pre_conditions?.length) text += `Pre-conditions:\n${c.pre_conditions.map(p => `  - ${p}`).join('\n')}\n`;
        if (c.post_conditions?.length) text += `Post-conditions:\n${c.post_conditions.map(p => `  - ${p}`).join('\n')}\n`;
        if (c.tests_to_verify?.length) text += `Tests to verify:\n${c.tests_to_verify.map(t => `  - ${t}`).join('\n')}\n`;
        if (c.linked_plans?.length) text += `Linked plans:\n${c.linked_plans.map(l => `  - ${l}`).join('\n')}\n`;
      }
      text += '\n';
      if (handoff.snapshot?.diff) {
        text += `--- Uncommitted Git Diff ---\n\`\`\`diff\n${handoff.snapshot.diff}\n\`\`\`\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'bclaw_get_agent_board') {
    const board = buildCoordinationSnapshot({
      agent: args.agent as string | undefined,
      project: args.project as string | undefined,
      target: args.path as string | undefined,
      host: args.host as string | undefined,
      allHosts: args.allHosts as boolean | undefined,
      includeReputation: args.includeReputation as boolean | undefined,
      includeSessionMeta: args.includeSessionMeta as boolean | undefined,
      autoAcknowledge: true,
      cwd,
    });
    const lines: string[] = [];
    lines.push(`Agent board${board.agent ? ` for ${board.agent}` : ''}${board.project ? ` (${board.project})` : ''}`);
    lines.push('');
    if (board.project_id) lines.push(`Project ID: ${board.project_id}`);
    if (board.agent && board.agent_id) lines.push(`Agent ID: ${board.agent_id}`);
    lines.push(`Current host: ${board.current_host}`);
    if (board.all_hosts) lines.push('Host filter: all-hosts');
    else if (board.host_filter) lines.push(`Host filter: ${board.host_filter}`);
    if (args.includeReputation && board.reputation_summary) {
      lines.push(`Reputation: tracked=${board.reputation_summary.tracked_agents}, avg_trust=${board.reputation_summary.avg_internal_trust}`);
      if (board.agent_reputation) {
        lines.push(`Agent trust: ${board.agent_reputation.internal_trust} (cq=${board.agent_reputation.contribution_quality}, rv=${board.agent_reputation.review_reliability}, ct=${board.agent_reputation.continuity_hygiene})`);
      }
    }
    lines.push(`Active plans: ${board.active_plans.length}`);
    for (const plan of board.active_plans.slice(0, 10)) {
      const claims = plan.claims.length ? ` claims=${plan.claims.map((claim) => claim.agent).join(',')}` : '';
      lines.push(`- [${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})${claims}`);
    }
    lines.push(`Active claims: ${board.active_claims.length}`);
    for (const claim of board.active_claims.slice(0, 10)) {
      const identity = claim.agent_id ? ` [${claim.agent_id}]` : '';
      const session = claim.session_id ? ` session=${claim.session_id}` : '';
      lines.push(`- [${claim.id}] ${claim.agent}${identity} -> ${claim.scope}${claim.plan_id ? ` (plan ${claim.plan_id})` : ''}${session}`);
    }
    const sessionMetaHint = board.session_meta_hidden > 0 ? ` (+${board.session_meta_hidden} session lifecycle notes hidden — pass includeSessionMeta to show)` : '';
    lines.push(`Runtime notes: ${board.runtime_notes.length}${sessionMetaHint}`);
    for (const note of board.runtime_notes.slice(-10)) {
      const scope = note.visibility === 'shared' ? 'shared' : `${note.visibility}:${note.host_id ?? 'unknown-host'}`;
      const identity = note.agent_id ? ` [${note.agent_id}]` : '';
      lines.push(`- [${note.id}] ${note.agent}${identity}: ${note.text}${note.plan_id ? ` (plan ${note.plan_id})` : ''} [${scope}]`);
    }
    lines.push(`Open handoffs: ${board.open_handoffs.length}`);
    for (const handoff of board.open_handoffs.slice(0, 10)) {
      const contractHint = handoff.contract ? ' [contract]' : '';
      lines.push(`- [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}${contractHint}`);
    }
    lines.push(`Resolved instructions: ${board.resolved_instructions.length}`);
    for (const instruction of board.resolved_instructions.slice(0, 10)) {
      lines.push(`- [${instruction.id}] <${instruction.layer}${instruction.scope ? `:${instruction.scope}` : ''}> ${instruction.text}`);
    }
    if (board.other_agents && board.other_agents.length > 0) {
      lines.push(`Other agents: ${board.other_agents.length}`);
      for (const other of board.other_agents) {
        lines.push(`- ${other.name}: ${other.claim_count} claim(s) on ${other.scopes.join(', ')}`);
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { ...board },
    };
  }

  if (name === 'bclaw_search') {
    const query = String(args.query ?? '');
    if (!query) {
      throw new Error('Missing required argument: query');
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const allResults = search({
      query,
      section: (args.section ?? args.type) as string | undefined,
      since: args.since as string | undefined,
      maxResults: offset + limit,
      cwd,
    });
    const total = allResults.length;
    const page = allResults.slice(offset, offset + limit);
    const lines = page.map((result) => `[${result.id}] (${result.section}) score=${result.score.toFixed(2)}: ${result.text.slice(0, 120)}`);
    return {
      content: [{ type: 'text', text: page.length > 0 ? lines.join('\n') : 'No results found.' }],
      structuredContent: { total, offset, limit, results: page },
    };
  }

  if (name === 'bclaw_estimation_report') {
    const report = buildEstimationReport({ agent: args.agent as string | undefined, cwd });
    const lines: string[] = [`Estimation Report — ${report.summary.total} completed plan(s)`];
    if (report.summary.calibration_hint) {
      lines.push(`Calibration: ${report.summary.calibration_hint}`);
      lines.push(`Median ratio: ${report.summary.median_ratio}x · Mean: ${report.summary.mean_ratio}x`);
    }
    for (const e of report.entries) {
      const est = e.estimated_minutes !== undefined ? `est:${e.estimated_minutes}min` : 'no estimate';
      const act = e.elapsed_minutes !== undefined ? `actual:${e.elapsed_minutes}min` : 'no actual';
      const ratio = e.ratio !== undefined ? ` ratio:${e.ratio}x` : '';
      lines.push(`[${e.id.slice(0, 8)}] ${e.text.slice(0, 60)} — ${est} · ${act}${ratio}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: report as unknown as Record<string, unknown>,
    };
  }

  if (name === 'bclaw_list_plans') {
    let plans = loadState(cwd).plan_items;

    // Direct lookup by ID
    if (args.id) {
      const plan = plans.find((p) => p.id === String(args.id) || p.short_label === String(args.id));
      if (!plan) {
        return { content: [{ type: 'text', text: `Plan '${args.id}' not found.` }], structuredContent: { total: 0, plans: [] } };
      }
      return {
        content: [{ type: 'text', text: `[${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})` }],
        structuredContent: { total: 1, plans: [plan] },
      };
    }

    // Filters
    if (!args.all) {
      plans = plans.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
    }
    if (args.status) {
      plans = plans.filter((plan) => plan.status === args.status);
    }
    if (args.type) {
      plans = plans.filter((plan) => plan.type === args.type);
    }
    if (args.assignee) {
      const assignee = String(args.assignee).toLowerCase();
      plans = plans.filter((plan) => plan.assignee?.toLowerCase() === assignee);
    }
    if (args.project) {
      const project = String(args.project).toLowerCase();
      plans = plans.filter((plan) => plan.project?.toLowerCase() === project);
    }

    const totalFiltered = plans.length;

    // Pagination
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const paginated = plans.slice(offset, offset + limit);

    const lines = paginated.length === 0
      ? ['No plan items found.']
      : [
          `${totalFiltered} plan(s)${totalFiltered > paginated.length ? ` (showing ${offset + 1}-${offset + paginated.length})` : ''}:`,
          ...paginated.map((plan) => {
            const meta: string[] = [plan.type ?? 'feat', plan.status, plan.priority];
            if (plan.assignee) meta.push(`assignee ${plan.assignee}`);
            if (plan.project) meta.push(`project ${plan.project}`);
            if (plan.depends_on.length > 0) meta.push(`depends_on ${plan.depends_on.join(',')}`);
            const tags = plan.tags.length ? ` [${plan.tags.join(', ')}]` : '';
            return `[${plan.id}] ${plan.text} (${meta.join(' · ')})${tags}`;
          }),
        ];

    // Compact mode: strip heavy fields
    const outputPlans = args.compact
      ? paginated.map(({ id, short_label, text, status, priority, tags, assignee, type }) => ({
          id, short_label, text, status, priority, tags, assignee, type,
        }))
      : paginated;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total: totalFiltered, offset, limit, plans: outputPlans },
    };
  }

  if (name === 'bclaw_list_claims') {
    let claims = listClaims(cwd);
    if (!args.all) {
      claims = claims.filter((claim) => claim.status === 'active');
    }
    if (args.project) {
      claims = claims.filter((claim) => claim.project === args.project);
    }
    if (args.plan) {
      claims = claims.filter((claim) => claim.plan_id === args.plan);
    }
    if (args.agent) {
      claims = claims.filter((claim) => claim.agent === args.agent);
    }

    const total = claims.length;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const page = claims.slice(offset, offset + limit);
    const label = args.all ? 'claim(s)' : 'active claim(s)';

    const lines = page.length === 0
      ? ['No active claims.']
      : [
          `${total} ${label}${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((claim) => {
            const status = claim.status !== 'active' ? ` (${claim.status})` : '';
            const extras: string[] = [];
            if (claim.session_id) extras.push(`session ${claim.session_id.slice(-8)}`);
            if (claim.plan_id) extras.push(`plan ${claim.plan_id}`);
            if (claim.project) extras.push(`project ${claim.project}`);
            const suffix = extras.length ? ` [${extras.join(', ')}]` : '';
            return `[${claim.id}] ${claim.agent} -> ${claim.scope}: ${claim.description}${suffix}${status}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, claims: page },
    };
  }

  if (name === 'bclaw_list_agents') {
    const agents = listAgentIdentities(cwd);
    const current = resolveCurrentAgentIdentity(cwd);
    const reputation = args.includeReputation ? buildReputationSnapshot(cwd) : undefined;
    const reputationById = new Map((reputation?.agents ?? []).map((agent) => [agent.agent_id ?? agent.key, toPublicReputationSummary(agent)]));
    const structuredAgents = args.includeReputation
      ? agents.map((agent) => ({
          ...agent,
          reputation: reputationById.get(agent.agent_id),
        }))
      : agents;

    const lines = structuredAgents.length === 0
      ? ['No registered agents.']
      : [
          `${structuredAgents.length} registered agent(s):`,
          ...structuredAgents.map((agent) => {
            const reputation = (agent as {
              reputation?: {
                internal_trust: number;
                contribution_quality: number;
                review_reliability: number;
                continuity_hygiene: number;
              };
            }).reputation;
            const currentLabel = current?.agent_id === agent.agent_id ? ' [current]' : '';
            const capabilitiesLabel = agent.capabilities.length > 0 ? ` caps=${agent.capabilities.join(',')}` : '';
            const fingerprintLabel = agent.identity_key ? ` fp=${agent.identity_key.fingerprint.slice(0, 12)}` : '';
            const reputationLabel = reputation
              ? ` trust=${reputation.internal_trust} cq=${reputation.contribution_quality} rv=${reputation.review_reliability} ct=${reputation.continuity_hygiene}`
              : '';
            return `- ${agent.agent_name} (${agent.agent_id}, kind=${agent.kind})${currentLabel}${reputationLabel}${capabilitiesLabel}${fingerprintLabel}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        current_agent_id: current?.agent_id,
        current_agent: current?.agent_name,
        agents: structuredAgents,
      },
    };
  }

  if (name === 'bclaw_list_instructions') {
    const config = loadConfig(cwd);
    const project = args.project as string | undefined;
    const inferredProject = project ?? inferProjectFromTarget(args.path as string | undefined, config);
    const resolvedAgent = args.resolved ? resolveAgentScope(args.agent as string | undefined) : args.agent as string | undefined;
    const source = args.resolved
      ? resolveInstructions(loadInstructions(cwd), { project: inferredProject, agent: resolvedAgent })
      : loadInstructions(cwd);

    let entries = source;
    if (args.active) {
      entries = entries.filter((entry) => entry.active);
    }
    if (args.layer) {
      entries = entries.filter((entry) => entry.layer === args.layer);
    }
    if (inferredProject) {
      entries = entries.filter((entry) => entry.layer !== 'project' || entry.scope === inferredProject);
    }
    if (args.agent) {
      entries = entries.filter((entry) => entry.layer !== 'agent' || entry.scope === args.agent);
    }

    const total = entries.length;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const page = entries.slice(offset, offset + limit);

    const lines = page.length === 0
      ? ['No instructions found.']
      : [
          `${total} instruction(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((entry) => {
            const scope = entry.scope ? `:${entry.scope}` : '';
            const flags: string[] = [entry.layer];
            if (!entry.active) flags.push('inactive');
            if (entry.supersedes) flags.push(`supersedes ${entry.supersedes}`);
            const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
            return `[${entry.id}] <${entry.layer}${scope}> ${entry.text} (${flags.join(' · ')})${tags}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, instructions: page },
    };
  }

  if (name === 'bclaw_list_candidates') {
    const status = String(args.status ?? 'pending').toLowerCase();
    let candidates = status === 'accepted'
      ? listArchivedCandidates('accepted', cwd)
      : status === 'rejected'
        ? listArchivedCandidates('rejected', cwd)
        : status === 'all'
          ? [
              ...listCandidates('pending', cwd),
              ...listArchivedCandidates('accepted', cwd),
              ...listArchivedCandidates('rejected', cwd),
            ]
          : listCandidates('pending', cwd);

    if (args.type) {
      candidates = candidates.filter((candidate) => candidate.type === args.type);
    }
    if (args.assignee) {
      const assignee = String(args.assignee).toLowerCase();
      candidates = candidates.filter((candidate) => getReviewAssignee(candidate.tags)?.toLowerCase() === assignee);
    }

    const total = candidates.length;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const page = candidates.slice(offset, offset + limit);
    const isCompact = args.compact === true;

    const lines = page.length === 0
      ? ['No candidates found.']
      : [
          `${total} candidate(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((candidate) => {
            if (isCompact) {
              return `[${candidate.id}] ${candidate.type}/${candidate.status}: ${candidate.text.slice(0, 120)}${candidate.text.length > 120 ? '…' : ''}`;
            }
            const assignee = getReviewAssignee(candidate.tags);
            const tags = candidate.tags.length ? ` [${candidate.tags.join(', ')}]` : '';
            const assigneeLabel = assignee ? ` assignee=${assignee}` : '';
            return `[${candidate.id}] ${candidate.type}/${candidate.status}${assigneeLabel}: ${candidate.text}${tags}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, candidates: page },
    };
  }

  if (name === 'bclaw_get_capabilities') {
    const allCapabilities = listCapabilities(cwd);

    const filtered = allCapabilities.filter((cap) => {
      const categoryFilter = args.category as string | undefined;
      const tagsFilter = args.tags as string[] | undefined;

      if (categoryFilter && cap.category !== categoryFilter) return false;
      if (tagsFilter && tagsFilter.length > 0) {
        if (!tagsFilter.every((tag) => cap.tags.includes(tag))) return false;
      }
      return true;
    });

    const lines: string[] = [`Capabilities (${filtered.length}):`];
    filtered.forEach((cap) => {
      lines.push(`\n[${cap.id}] ${cap.name}`);
      lines.push(`    Category: ${cap.category}`);
      lines.push(`    Author: ${cap.author}`);
      if (cap.tags.length > 0) {
        lines.push(`    Tags: ${cap.tags.join(', ')}`);
      }
    });

    return {
      content: [{ type: 'text', text: lines.join('\n') || 'No capabilities found.' }],
      structuredContent: { total: filtered.length, capabilities: filtered },
    };
  }

  if (name === 'bclaw_list_tools') {
    const allTools = listRegistryTools(cwd);

    const filtered = allTools.filter((tool) => {
      const typeFilter = args.type as string | undefined;
      const tagsFilter = args.tags as string[] | undefined;

      if (typeFilter && tool.type !== typeFilter) return false;
      if (tagsFilter && tagsFilter.length > 0) {
        if (!tagsFilter.every((tag) => tool.tags.includes(tag))) return false;
      }
      return true;
    });

    const lines: string[] = [`Tools (${filtered.length}):`];
    filtered.forEach((tool) => {
      lines.push(`\n[${tool.id}] ${tool.name}`);
      lines.push(`    Type: ${tool.type}`);
      lines.push(`    Author: ${tool.author}`);
      if (tool.tags.length > 0) {
        lines.push(`    Tags: ${tool.tags.join(', ')}`);
      }
    });

    return {
      content: [{ type: 'text', text: lines.join('\n') || 'No tools found.' }],
      structuredContent: { total: filtered.length, tools: filtered },
    };
  }

  if (name === 'bclaw_search_tools') {
    const query = String(args.query ?? '');
    if (!query) {
      throw new Error('Missing required argument: query');
    }

    const allTools = listRegistryTools(cwd);
    const queryLower = query.toLowerCase();

    const filtered = allTools.filter((tool) => {
      const typeFilter = args.type as string | undefined;
      const tagsFilter = args.tags as string[] | undefined;

      if (typeFilter && tool.type !== typeFilter) return false;
      if (tagsFilter && tagsFilter.length > 0) {
        if (!tagsFilter.every((tag) => tool.tags.includes(tag))) return false;
      }

      return (
        tool.name.toLowerCase().includes(queryLower) ||
        tool.description.toLowerCase().includes(queryLower) ||
        tool.tags.some((tag) => tag.toLowerCase().includes(queryLower))
      );
    });

    const lines: string[] = [`Search results for '${query}' (${filtered.length} tool(s)):`];
    filtered.forEach((tool) => {
      lines.push(`\n[${tool.id}] ${tool.name}`);
      lines.push(`    Type: ${tool.type}`);
    });

    return {
      content: [{ type: 'text', text: lines.join('\n') || 'No tools found.' }],
      structuredContent: { query, total: filtered.length, tools: filtered },
    };
  }

  if (name === 'bclaw_get_discovery') {
    const refresh = args.refresh !== false; // default: true
    const noSave = args.noSave as boolean | undefined;

    let profile;
    if (!refresh) {
      profile = loadDiscoveryProfile(cwd);
    }
    if (!profile) {
      profile = buildProjectDiscovery({ cwd });
      if (!noSave) {
        saveDiscoveryProfile(profile, cwd);
      }
    }

    return {
      content: [{ type: 'text', text: renderDiscoverySummary(profile) }],
      structuredContent: { ...profile, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_conflict_check') {
    const agentNameArg = args.agent as string | undefined;
    const agentIdArg = args.agentId as string | undefined;
    const currentAgentName = agentNameArg ?? resolveCurrentAgentName(cwd);
    const allClaimsForCheck = listClaims(cwd).filter((c) => c.status === 'active');
    const myClaimsForCheck = allClaimsForCheck.filter((c) =>
      agentIdArg ? c.agent_id === agentIdArg : c.agent === currentAgentName
    );
    const otherClaimsForCheck = allClaimsForCheck.filter((c) =>
      agentIdArg ? c.agent_id !== agentIdArg : c.agent !== currentAgentName
    );

    const conflicts: Array<{ my_claim: string; my_scope: string; other_claim: string; other_agent: string; other_scope: string; reason: string }> = [];
    for (const mine of myClaimsForCheck) {
      const myScopes = mine.scope.replace(/\\/g, '/').split(/\s+/);
      for (const other of otherClaimsForCheck) {
        const otherScopes = other.scope.replace(/\\/g, '/').split(/\s+/);
        for (const ms of myScopes) {
          for (const os of otherScopes) {
            if (ms === os || ms.startsWith(os + '/') || os.startsWith(ms + '/')) {
              conflicts.push({
                my_claim: mine.id, my_scope: mine.scope,
                other_claim: other.id, other_agent: other.agent, other_scope: other.scope,
                reason: ms === os ? `exact: ${ms}` : `overlap: ${ms} ↔ ${os}`,
              });
            }
          }
        }
      }
    }

    const text = conflicts.length === 0
      ? `No claim conflicts for ${currentAgentName}.`
      : `${conflicts.length} conflict(s) found:\n${conflicts.map((c) => `  ${c.my_scope} ↔ ${c.other_agent}:${c.other_scope} (${c.reason})`).join('\n')}`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: { agent: currentAgentName, conflicts, total: conflicts.length, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_switch') {
    if (args.list === true) {
      try {
        const result = listAvailableProjects(cwd);
        const lines = result.projects.map(p => {
          const marker = p.active ? '→' : ' ';
          const label = p.name ? `${p.name} (${p.relative_path})` : p.relative_path;
          return `${marker} ${label}`;
        });
        return {
          content: [{ type: 'text', text: lines.length > 0 ? `Projects in workspace:\n${lines.join('\n')}` : 'No projects found.' }],
          structuredContent: { ...result, schema_version: SCHEMA_VERSION },
        };
      } catch (err) {
        return createToolErrorResponse('switch_error', err instanceof Error ? err.message : String(err));
      }
    }

    if (args.clear === true) {
      try {
        const session = loadCurrentSession(cwd);
        if (session?.active_project) {
          const { active_project: _removed, ...rest } = session;
          saveCurrentSession(rest, cwd);
        }
        return {
          content: [{ type: 'text', text: '✔ Active project cleared. Commands will use workspace root.' }],
          structuredContent: { cleared: true, schema_version: SCHEMA_VERSION },
        };
      } catch (err) {
        return createToolErrorResponse('switch_error', err instanceof Error ? err.message : String(err));
      }
    }

    const projectRef = args.project as string | undefined;
    if (!projectRef) {
      return createToolErrorResponse('validation_error', 'Missing required argument: project (or use list=true / clear=true)');
    }

    try {
      const result = switchProject(projectRef, { cwd, sessionOnly: true });
      const text = `✔ Switched to ${result.name ? `"${result.name}"` : result.path} (${result.scope}-scoped)`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...result, schema_version: SCHEMA_VERSION },
      };
    } catch (err) {
      return createToolErrorResponse('switch_error', err instanceof Error ? err.message : String(err));
    }
  }

  if (name === 'bclaw_who') {
    // loadAllSessions and gcStaleSessions imported at top of file
    const doGc = args.gc === true;
    const showAll = args.all === true;

    if (doGc) {
      const removed = gcStaleSessions(cwd);
      return {
        content: [{ type: 'text', text: `✔ Removed ${removed} stale session(s).` }],
        structuredContent: { gc: true, removed, schema_version: SCHEMA_VERSION },
      };
    }

    const allSessions = loadAllSessions(cwd);
    const ttlMs = 4 * 60 * 60 * 1000;
    const now = Date.now();
    const sessions = showAll
      ? allSessions
      : allSessions.filter((s) => (now - Date.parse(s.last_seen_at)) <= ttlMs);

    const activeClaims = listClaims(cwd).filter((c) => c.status === 'active');
    const output = sessions.map((s) => ({
      session_id: s.session_id,
      user: s.user ?? 'unknown',
      agent: s.agent,
      agent_id: s.agent_id,
      project: s.active_project?.name ?? s.active_project?.path ?? null,
      claims: activeClaims.filter((c) => c.agent_id === s.agent_id).length,
      last_seen_at: s.last_seen_at,
      stale: (now - Date.parse(s.last_seen_at)) > ttlMs,
    }));

    const lines = sessions.length === 0
      ? 'No active sessions.'
      : output.map((s) => `${s.user} | ${s.agent} | ${s.project ?? '(root)'} | ${s.claims} claims | ${s.stale ? 'stale' : 'active'}`).join('\n');

    return {
      content: [{ type: 'text', text: lines }],
      structuredContent: { sessions: output, total: output.length, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_doctor') {
    // Capture doctor JSON output by redirecting console.log
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a: unknown[]) => captured.push(a.join(' '));
    console.warn = (...a: unknown[]) => captured.push(a.join(' '));
    console.error = (...a: unknown[]) => captured.push(a.join(' '));
    try {
      runDoctor({ json: true, cwd, migrationCheck: args.migrationCheck as boolean | undefined });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    const jsonStr = captured.join('\n');
    let structured: Record<string, unknown> = {};
    try { structured = JSON.parse(jsonStr) as Record<string, unknown>; } catch { /* non-JSON fallback */ }
    const ok = structured.ok as boolean | undefined;
    const checks = (structured.checks as Array<{ name: string; status: string; message: string }>) ?? [];
    const errors = checks.filter(c => c.status === 'error');
    const warns = checks.filter(c => c.status === 'warn');
    const summary = ok
      ? `✔ All ${checks.length} checks passed.`
      : `${errors.length} error(s), ${warns.length} warning(s) out of ${checks.length} checks.`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: { ...structured, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_history') {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('Missing required argument: id');
    const entries = readAuditLog({ itemId: id }, cwd);
    const lines = [`History for ${id} — ${entries.length} event(s):`];
    for (const e of entries) {
      const reason = e.reason ? ` | ${e.reason}` : '';
      lines.push(`  ${e.timestamp} [${e.actor}] ${e.action}${reason}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { id, total: entries.length, entries, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_audit') {
    const limit = (args.limit as number | undefined) ?? 20;
    const entries = readAuditLog({
      since: args.since as string | undefined,
      actor: args.actor as string | undefined,
      action: args.action as AuditAction | undefined,
    }, cwd);
    const sliced = entries.slice(-limit);
    const lines = [`Audit log — showing ${sliced.length} of ${entries.length} entries:`];
    for (const e of sliced) {
      const itemInfo = e.item_id ? ` → ${e.item_id}` : '';
      const typeInfo = e.item_type ? ` (${e.item_type})` : '';
      const reason = e.reason ? ` | ${e.reason}` : '';
      lines.push(`  ${e.timestamp} [${e.actor}] ${e.action}${itemInfo}${typeInfo}${reason}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total: entries.length, returned: sliced.length, entries: sliced, schema_version: SCHEMA_VERSION },
    };
  }

  throw new Error(`Unknown read tool: ${name}`);
}

export async function executeMcpToolCall(payload: McpToolExecutionPayload): Promise<McpToolExecutionOutcome> {
  const { name, args, cwd, connectionSessionId } = payload;

  try {
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
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
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
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
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
      const candId = generateCandidateIdWithLabel(cwd);
      const type = String(args.type ?? 'decision') as CandidateType;
      const writeThrough = agentCanWriteDirect(identity.agent_id ?? resolvedIdentity.agent_id, cwd);
      const candidatePlanId = args.planId as string | undefined;
      const candidateScope = args.scope as string | undefined;
      const targetStore = args.store as string | undefined;
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
      const storeTarget = (args.store as StoreTarget | undefined) ?? 'local';
      const claimCwd = resolveTargetStore(cwd, storeTarget);
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', claimCwd);
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
      if (args.createWorktree) {
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
      }, claimCwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'claim', item_id: claimId, item_type: 'claim' }, claimCwd);
      const postClaimItems = getTriggeredItems('trigger:post-claim', claimCwd);
      const postClaimText = renderTriggeredItems(postClaimItems);
      const noPlanWarn = !(args.planId as string | undefined)
        ? '\n⚠ No plan item linked to this claim. Run bclaw_create_plan first and pass planId to track this work formally.'
        : '';
      const worktreeNote = worktreePath ? `\n  Worktree: ${worktreePath}` : '';
      const claimText = `✔ Claimed scope [${claimId}]${worktreeNote}${noPlanWarn}${worktreeWarn}${postClaimText ? `\n${postClaimText}` : ''}`;

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
      appendAuditEntry({ actor: claimObj.agent, action: 'release_claim', item_id: claimId, item_type: 'claim' }, cwd);
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
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
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
      const sessionStartMsg = postSessionStartText
        ? `✔ Session started\n${postSessionStartText}`
        : '✔ Session started';

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
          profile: args.contextProfile as 'dev' | 'openclaw' | 'ops' | 'research' | undefined,
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
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const result = endSession({
        session: args.session as string | undefined,
        agent: resolved.identity?.agent_name,
        agentId: resolved.identity?.agent_id,
        summary: args.summary as string | undefined,
        autoReflect: args.autoReflect as boolean | undefined,
        reflect: args.reflect as boolean | undefined,
        cwd,
      });
      const preSessionEndItems = getTriggeredItems('trigger:pre-session-end', cwd);
      const preSessionEndText = renderTriggeredItems(preSessionEndItems);

      const parts: string[] = ['✔ Session ended'];
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
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
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
      const id = mutateState((state) => {
        const { id, short_label } = generateIdWithLabel('plan_items');
        const timestamp = nowISO();
        const planType = args.type as PlanType | undefined;
        const entry: PlanItem = {
          id,
          short_label,
          text: planText,
          type: planType,
          created_at: timestamp,
          updated_at: timestamp,
          author: resolved.identity!.agent_name,
          status: 'todo',
          priority: (args.priority as Priority) ?? 'medium',
          assignee: args.assignee as string | undefined,
          tags: (args.tags as string[]) ?? [],
          depends_on: [],
          estimated_effort: estimatedEffort,
        };
        state.plan_items.push(entry);
        return id;
      }, cwd);
      appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'create', item_id: id, item_type: 'plan' }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Plan item added: [${id}] ${planText}` }],
          plan_id: id,
        }),
      };
    }

    if (name === 'bclaw_update_plan') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const planId = String(args.id ?? '').trim();
      if (!planId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      const updateResult = mutateState((state) => {
        const plan = state.plan_items.find((item) => item.id === planId || item.short_label === planId);
        if (!plan) {
          return undefined;
        }
        const timestamp = nowISO();
        if (args.status) {
          plan.status = args.status as PlanStatus;
          if (args.status === 'in_progress' && !plan.started_at) plan.started_at = timestamp;
          if (args.status === 'done' && !plan.completed_at) plan.completed_at = timestamp;
        }
        if (args.assignee !== undefined) plan.assignee = args.assignee as string;
        if (args.priority) plan.priority = args.priority as Priority;
        if (args.actualEffort) plan.actual_effort = args.actualEffort as string;
        plan.updated_at = timestamp;
        return { id: plan.id, text: plan.text, status: plan.status };
      }, cwd);
      if (!updateResult) {
        return { response: createToolErrorResponse('not_found', `Plan item '${planId}' not found`) };
      }
      appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: updateResult.id, item_type: 'plan' }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Plan item updated: [${updateResult.id}] ${updateResult.text}` }],
          plan_id: updateResult.id,
          status: updateResult.status,
        }),
      };
    }

    if (name === 'bclaw_add_step') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const stepPlanId = String(args.planId ?? '').trim();
      const stepText = String(args.text ?? '').trim();
      if (!stepPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!stepText) return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
      const addStepResult = mutateState((state) => {
        const plan = state.plan_items.find((p) => p.id === stepPlanId || p.short_label === stepPlanId);
        if (!plan) return undefined;
        const step: PlanStep = {
          id: generateId('plan_steps'),
          text: stepText,
          status: 'todo',
          assignee: args.assignee as string | undefined,
          created_at: nowISO(),
          updated_at: nowISO(),
        };
        plan.steps = [...(plan.steps ?? []), step];
        plan.updated_at = nowISO();
        return {
          stepId: step.id,
          planId: plan.id,
          done: plan.steps.filter((s) => s.status === 'done').length,
          total: plan.steps.length,
        };
      }, cwd);
      if (!addStepResult) return { response: createToolErrorResponse('not_found', `Plan '${stepPlanId}' not found`) };
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Step added: [${addStepResult.stepId}] ${stepText} (${addStepResult.done}/${addStepResult.total} done)` }],
          step_id: addStepResult.stepId,
          plan_id: addStepResult.planId,
          progress: { done: addStepResult.done, total: addStepResult.total },
        }),
      };
    }

    if (name === 'bclaw_complete_step') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const csPlanId = String(args.planId ?? '').trim();
      const csStepId = String(args.stepId ?? '').trim();
      if (!csPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!csStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
      const completeResult = mutateState((state) => {
        const plan = state.plan_items.find((p) => p.id === csPlanId || p.short_label === csPlanId);
        if (!plan) return { kind: 'plan_missing' } as const;
        const step = (plan.steps ?? []).find((s) => s.id === csStepId);
        if (!step) return { kind: 'step_missing' } as const;
        step.status = 'done';
        step.updated_at = nowISO();
        plan.updated_at = nowISO();
        return {
          kind: 'ok',
          stepId: step.id,
          stepText: step.text,
          planId: plan.id,
          done: plan.steps!.filter((s) => s.status === 'done').length,
          total: plan.steps!.length,
        } as const;
      }, cwd);
      if (completeResult.kind === 'plan_missing') return { response: createToolErrorResponse('not_found', `Plan '${csPlanId}' not found`) };
      if (completeResult.kind === 'step_missing') return { response: createToolErrorResponse('not_found', `Step '${csStepId}' not found in plan '${csPlanId}'`) };
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Step completed: [${completeResult.stepId}] ${completeResult.stepText} (${completeResult.done}/${completeResult.total} done)` }],
          step_id: completeResult.stepId,
          plan_id: completeResult.planId,
          progress: { done: completeResult.done, total: completeResult.total },
          all_done: completeResult.done === completeResult.total,
        }),
      };
    }

    if (name === 'bclaw_delete_memory') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd);
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

      // Walk store chain to find the item
      const chain = resolveStoreChain(cwd);
      let foundStore: (typeof chain)[number] | undefined;

      for (const store of chain) {
        const state = loadState(store.cwd);
        const found =
          (itemType === 'constraint' && state.active_constraints.some((c) => c.id === itemId || c.short_label === itemId)) ||
          (itemType === 'decision' && state.recent_decisions.some((d) => d.id === itemId || d.short_label === itemId)) ||
          (itemType === 'trap' && state.known_traps.some((t) => t.id === itemId || t.short_label === itemId));
        if (found) {
          foundStore = store;
          break;
        }
      }

      if (!foundStore) {
        return { response: createToolErrorResponse('not_found', `${itemType} with id '${itemId}' not found in any store`) };
      }

      // Delete from the found store
      const state = loadState(foundStore.cwd);
      const beforeCount =
        itemType === 'constraint' ? state.active_constraints.length :
        itemType === 'decision' ? state.recent_decisions.length :
        state.known_traps.length;

      if (itemType === 'constraint') {
        state.active_constraints = state.active_constraints.filter((c) => c.id !== itemId && c.short_label !== itemId);
      } else if (itemType === 'decision') {
        state.recent_decisions = state.recent_decisions.filter((d) => d.id !== itemId && d.short_label !== itemId);
      } else if (itemType === 'trap') {
        state.known_traps = state.known_traps.filter((t) => t.id !== itemId && t.short_label !== itemId);
      }

      persistState(state, foundStore.cwd);
      appendAuditEntry(
        { actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'delete', item_id: itemId, item_type: itemType as CandidateType },
        foundStore.cwd,
      );

      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Deleted [${itemId}] (${itemType})` }],
          deleted_id: itemId,
          item_type: itemType,
          store_level: foundStore.role,
        }),
      };
    }

    if (name === 'bclaw_update_memory') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd);
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

      // Walk store chain to find the item
      const chain = resolveStoreChain(cwd);
      let sourceStore: (typeof chain)[number] | undefined;
      let item: Constraint | Decision | Trap | undefined;

      for (const store of chain) {
        const state = loadState(store.cwd);
        if (itemType === 'constraint') {
          item = state.active_constraints.find((c) => c.id === itemId || c.short_label === itemId);
        } else if (itemType === 'decision') {
          item = state.recent_decisions.find((d) => d.id === itemId || d.short_label === itemId);
        } else if (itemType === 'trap') {
          item = state.known_traps.find((t) => t.id === itemId || t.short_label === itemId);
        }
        if (item) {
          sourceStore = store;
          break;
        }
      }

      if (!sourceStore || !item) {
        return { response: createToolErrorResponse('not_found', `${itemType} with id '${itemId}' not found in any store`) };
      }

      const previousStore = sourceStore.role;

      // Update text and tags
      if (newText) item.text = newText;
      if (newTags) item.tags = newTags;
      if (newStatus && itemType === 'trap') (item as Trap).status = newStatus as Trap['status'];

      // Handle moveToStore
      if (moveToStore) {
        const targetCwd = resolveTargetStore(cwd, moveToStore as StoreTarget);

        // Delete from source store
        const sourceState = loadState(sourceStore.cwd);
        if (itemType === 'constraint') {
          sourceState.active_constraints = sourceState.active_constraints.filter((c) => c.id !== itemId);
        } else if (itemType === 'decision') {
          sourceState.recent_decisions = sourceState.recent_decisions.filter((d) => d.id !== itemId);
        } else if (itemType === 'trap') {
          sourceState.known_traps = sourceState.known_traps.filter((t) => t.id !== itemId);
        }
        persistState(sourceState, sourceStore.cwd);

        // Add to target store
        const targetState = loadState(targetCwd);
        if (itemType === 'constraint') {
          targetState.active_constraints.push(item as Constraint);
        } else if (itemType === 'decision') {
          targetState.recent_decisions.push(item as Decision);
        } else if (itemType === 'trap') {
          targetState.known_traps.push(item as Trap);
        }
        persistState(targetState, targetCwd);
      } else {
        // Just update in place
        const state = loadState(sourceStore.cwd);
        if (itemType === 'constraint') {
          const idx = state.active_constraints.findIndex((c) => c.id === itemId);
          if (idx >= 0) state.active_constraints[idx] = item as Constraint;
        } else if (itemType === 'decision') {
          const idx = state.recent_decisions.findIndex((d) => d.id === itemId);
          if (idx >= 0) state.recent_decisions[idx] = item as Decision;
        } else if (itemType === 'trap') {
          const idx = state.known_traps.findIndex((t) => t.id === itemId);
          if (idx >= 0) state.known_traps[idx] = item as Trap;
        }
        persistState(state, sourceStore.cwd);
      }

      appendAuditEntry(
        { actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: itemId, item_type: itemType as CandidateType },
        sourceStore.cwd,
      );

      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Updated [${itemId}] (${itemType})` }],
          updated_id: itemId,
          item_type: itemType,
          previous_store: previousStore,
          new_store: moveToStore,
        }),
      };
    }

    if (name === 'bclaw_add_capability') {
      const capName = String(args.name ?? '').trim();
      const capDesc = String(args.description ?? '').trim();
      if (!capName || !capDesc) {
        return { response: createToolErrorResponse('validation_error', 'Missing required arguments: name and description') };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
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
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
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
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd);
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
