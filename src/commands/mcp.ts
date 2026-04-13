import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { resolveCrossProjectWritableTarget, writeCrossProjectSignal } from '../core/cross-project.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate, renderContextBriefing } from '../core/context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { checkBrainclawInstallableUpdate, getInstalledBrainclawVersion, readDiskBrainclawVersion, renderBrainclawInstallableUpdateNotice } from '../core/brainclaw-version.js';
import { loadConfig } from '../core/config.js';
import { loadState, persistState, saveState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { generateCandidateIdWithLabel, saveCandidate } from '../core/candidates.js';
import { generateClaimId, listClaims, loadClaim, saveClaim, createCoordinatorClaim, adoptClaimSession, attachAssignmentMessageToClaim, linkClaimToAssignment } from '../core/claims.js';
import { createSequence, updateSequence } from '../core/sequence.js';
import { assertCrossProjectBoundary, checkPolicy } from '../core/policy.js';
import { createWorktree as coreCreateWorktree } from '../core/worktree.js';
import { createRuntimeNote } from './runtime-note.js';
import { createCandidateFromInput } from './reflect.js';
import { acceptCandidate } from './accept.js';
import { rejectCandidate } from './reject.js';
import { startSession } from './session-start.js';
import { endSession } from './session-end.js';
import { applyHandoffUpdates } from './update-handoff.js';
import {
  agentCanWriteDirect,
  AgentIdentityResolutionError,
  AgentTrustError,
  requireMinimumTrustLevel,
  requireRegisteredAgentIdentity,
  resolveCurrentModel,
  ensureAgentRegisteredForDispatch,
} from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO, generateId } from '../core/ids.js';
import { buildOperationalIdentity, loadAllSessions, loadSessionById } from '../core/identity.js';
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
import type { CandidateType, MemoryVisibility, PlanStatus, PlanType, Priority, SequenceItemInput, SequenceStatus } from '../core/schema.js';
import { createPlan, addStep as addStepOp, completeStep as completeStepOp, updatePlan as updatePlanOp } from '../core/operations/plan.js';
import { sendMessage, ackMessage, countPending, countActionable, getThread, hasActiveAssignment } from '../core/messaging.js';
import { analyzeSequence, dispatch, dispatchReview, generateDispatchBrief } from '../core/dispatcher.js';
import { deleteMemoryItem, updateMemoryItem, type MemoryItemType } from '../core/operations/memory-mutation.js';
import { compact as gcCompact, assessMemoryPressure, buildCompactionTemplate, applyCompaction } from '../core/gc-semantic.js';
import { WorkRequestSchema, CoordinateRequestSchema, type FacadeResponse } from '../core/facade-schema.js';
import { getSpawnableAgents, getCapabilityProfile, buildInvokeCommand, resolveBriefMode } from '../core/agent-capability.js';
import { attemptExecution } from '../core/execution.js';
import { createAgentRun, transitionAgentRun } from '../core/agentruns.js';
import { createAssignment, generateAssignmentId, patchAssignmentMessageId, transitionAssignment } from '../core/assignments.js';

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

type QuickCaptureTarget = 'decision' | 'trap' | 'note';

interface QuickCaptureClassification {
  target: QuickCaptureTarget;
  reason: string;
  decisionScore: number;
  trapScore: number;
}

export const MCP_READ_TOOLS = [
  {
    name: 'bclaw_get_context',
    description: 'Get project memory context for a specific file or path.',
    annotations: { tier: 'standard', category: 'context' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path or glob pattern to filter memory by.' },
        project: { type: 'string', description: 'Optional explicit project namespace for instruction resolution.' },
        agent: { type: 'string', description: 'Optional agent name for agent-layer instruction resolution.' },
        host: { type: 'string', description: 'Optional host identifier used to include machine-local runtime context.' },
        allHosts: { type: 'boolean', description: 'Include machine-local runtime context from all hosts.' },
        profile: { type: 'string', description: 'Optional profile override: dev (default), dense (all sections, max items), compact (plans+constraints), copilot (constraints+traps), quick (minimal), briefing (ultra-compact scope briefing < 500 chars), openclaw, ops, research.' },
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
    annotations: { tier: 'standard', category: 'context' },
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
    annotations: { tier: 'standard', category: 'context' },
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
    annotations: { tier: 'standard', category: 'context' },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'bclaw_read_handoff',
    description: 'Read an open handoff ticket with its captured git diff and state snapshot.',
    annotations: { tier: 'standard', category: 'coordination' },
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
    annotations: { tier: 'standard', category: 'coordination' },
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
    annotations: { tier: 'standard', category: 'memory' },
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
    annotations: { tier: 'advanced', category: 'governance' },
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
    annotations: { tier: 'standard', category: 'coordination' },
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
    name: 'bclaw_list_sequences',
    description: 'List coordination sequences with optional filters on status and id.',
    annotations: { tier: 'advanced', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: draft, active, archived.' },
        id: { type: 'string', description: 'Get a single sequence by ID or short label.' },
        limit: { type: 'number', description: 'Maximum number of sequences to return (default: 20).' },
        offset: { type: 'number', description: 'Number of sequences to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields (id, name, status) to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_list_claims',
    description: 'List work claims with optional filters on project, plan, and agent.',
    annotations: { tier: 'standard', category: 'coordination' },
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
    name: 'bclaw_list_assignments',
    description: 'List assignment runtime records with optional filters on status, agent, claim, plan, sequence, or id.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by assignment status: created, offered, accepted, started, completed, failed, blocked, timed_out, expired, retrying, rerouted.' },
        agent: { type: 'string', description: 'Filter by assigned agent name.' },
        claimId: { type: 'string', description: 'Filter by linked claim ID.' },
        planId: { type: 'string', description: 'Filter by linked plan ID.' },
        sequenceId: { type: 'string', description: 'Filter by linked sequence ID.' },
        id: { type: 'string', description: 'Get a single assignment by ID or short label.' },
        limit: { type: 'number', description: 'Maximum number of assignments to return (default: 20).' },
        offset: { type: 'number', description: 'Number of assignments to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_list_runs',
    description: 'List AgentRun execution attempts with optional filters on status, transport, agent, assignment, claim, plan, sequence, or id.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by run status: created, launching, waiting_input, running, blocked, completed, failed, cancelled, timed_out, interrupted.' },
        transport: { type: 'string', description: 'Filter by transport: cli_spawn, manual_command, inbox_only.' },
        agent: { type: 'string', description: 'Filter by assigned agent name.' },
        assignmentId: { type: 'string', description: 'Filter by linked assignment ID.' },
        claimId: { type: 'string', description: 'Filter by linked claim ID.' },
        planId: { type: 'string', description: 'Filter by linked plan ID.' },
        sequenceId: { type: 'string', description: 'Filter by linked sequence ID.' },
        id: { type: 'string', description: 'Get a single run by ID or short label.' },
        limit: { type: 'number', description: 'Maximum number of runs to return (default: 20).' },
        offset: { type: 'number', description: 'Number of runs to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_assignment_events',
    description: 'List correlated runtime events for assignments and runs with filters on assignment, run, claim, session, agent, or event type.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        assignmentId: { type: 'string', description: 'Filter by linked assignment ID.' },
        runId: { type: 'string', description: 'Filter by linked run ID.' },
        claimId: { type: 'string', description: 'Filter by linked claim ID.' },
        sessionId: { type: 'string', description: 'Filter by runtime session ID.' },
        agent: { type: 'string', description: 'Filter by agent name.' },
        eventType: { type: 'string', description: 'Filter by runtime event type.' },
        id: { type: 'string', description: 'Get a single runtime event by ID.' },
        limit: { type: 'number', description: 'Maximum number of events to return (default: 20).' },
        offset: { type: 'number', description: 'Number of events to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_list_actions',
    description: 'List pending or resolved ActionRequired items for runtime approvals, questions, and clarifications.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by action status: pending, resolved, rejected, cancelled.' },
        kind: { type: 'string', description: 'Filter by action kind: approval, user_input, clarification, plan_approval.' },
        agent: { type: 'string', description: 'Filter by agent name.' },
        assignmentId: { type: 'string', description: 'Filter by linked assignment ID.' },
        runId: { type: 'string', description: 'Filter by linked run ID.' },
        claimId: { type: 'string', description: 'Filter by linked claim ID.' },
        id: { type: 'string', description: 'Get a single action by ID or short label.' },
        limit: { type: 'number', description: 'Maximum number of actions to return (default: 20).' },
        offset: { type: 'number', description: 'Number of actions to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_list_agents',
    description: 'List registered agent identities and optionally include bounded reputation summaries.',
    annotations: { tier: 'advanced', category: 'discovery' },
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
    annotations: { tier: 'advanced', category: 'discovery' },
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
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Candidate bucket: pending, accepted, rejected, or all.' },
        type: { type: 'string', description: 'Filter by candidate type.' },
        assignee: { type: 'string', description: 'Filter pending candidates by assignee tag (assignee:<name>).' },
        source: { type: 'string', enum: ['auto', 'agent', 'human'], description: 'Filter by candidate source: auto (session-end auto-reflect), agent (intentional agent action), human (human-created or legacy).' },
        auto_generated: { type: 'boolean', description: 'When false, exclude auto-generated candidates (source=auto). When true, show only auto-generated candidates.' },
        limit: { type: 'number', description: 'Maximum number of candidates to return (default: 20).' },
        offset: { type: 'number', description: 'Number of candidates to skip (for pagination).' },
        compact: { type: 'boolean', description: 'Return only key fields (id, type, text, status) to reduce output size.' },
      },
    },
  },
  {
    name: 'bclaw_get_capabilities',
    description: 'List all registered project capabilities with full metadata.',
    annotations: { tier: 'advanced', category: 'discovery' },
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
    annotations: { tier: 'advanced', category: 'discovery' },
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
    annotations: { tier: 'advanced', category: 'discovery' },
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
    annotations: { tier: 'advanced', category: 'governance' },
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
    annotations: { tier: 'advanced', category: 'governance' },
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
    annotations: { tier: 'advanced', category: 'governance' },
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
    annotations: { tier: 'advanced', category: 'discovery' },
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
    annotations: { tier: 'advanced', category: 'governance' },
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
    annotations: { tier: 'advanced', category: 'discovery' },
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include stale sessions (default: false).' },
        gc: { type: 'boolean', description: 'Remove stale sessions and return count.' },
      },
    },
  },
  {
    name: 'bclaw_switch',
    description: 'Switch active project in a multi-project workspace. Session-scoped by default: only this agent sees the switch, other agents are unaffected. Use list=true to see available projects.',
    annotations: { tier: 'standard', category: 'session' },
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
    name: 'bclaw_check_policy',
    description: 'Pre-execution policy check. Verifies claims, constraints, traps and governance instructions for a given scope. Returns blocks (hard stops) and warnings (context to consider). Call before editing to ensure compliance.',
    annotations: { tier: 'advanced', category: 'governance' },
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
    annotations: { tier: 'advanced', category: 'governance' },
    inputSchema: {
      type: 'object',
      properties: {
        packages: { type: 'string', description: 'Comma-separated package names (e.g. "axios,express" or "axios@1.14.1").' },
        ecosystem: { type: 'string', description: 'Package ecosystem: npm or pypi. Defaults to npm.' },
      },
      required: ['packages'],
    },
  },
  {
    name: 'bclaw_read_inbox',
    description: 'Read messages from an agent inbox. Returns pending messages by default. Use markAsRead to auto-mark pending messages as read. Supports filtering by status, type, and thread_id.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name whose inbox to read. Defaults to calling agent.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        status: { type: 'string', description: 'Filter by status: pending, read, acknowledged, archived.' },
        type: { type: 'string', description: 'Filter by message type: assign, review, rfc, info, reply.' },
        thread_id: { type: 'string', description: 'Filter by thread ID to see a conversation.' },
        markAsRead: { type: 'boolean', description: 'Mark pending messages as read. Default: false.' },
        limit: { type: 'number', description: 'Maximum messages to return (default: 20).' },
        offset: { type: 'number', description: 'Skip N messages for pagination.' },
      },
    },
  },
  {
    name: 'bclaw_get_thread',
    description: 'Get all messages in a thread across all agent inboxes. Useful for following RFC discussions or review rounds.',
    annotations: { tier: 'advanced', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Thread ID to retrieve.' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'bclaw_dispatch_analysis',
    description: 'Analyze the active sequence and show lane status: which items are ready (all hard deps met), active (claimed by an agent), blocked (waiting on deps), or done. Shows available agents. Use this before bclaw_dispatch to preview assignments.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        lanes: { type: 'array', items: { type: 'string' }, description: 'Only show specific lanes.' },
      },
    },
  },
] as const;

const MCP_WRITE_TOOLS = [
  {
    name: 'bclaw_dispatch',
    description: 'Run a dispatch cycle: analyze the active sequence, generate briefs for ready lanes, and send assignment messages to target agents. Returns ready-to-run bash commands per agent — the coordinator should execute them (e.g. via run_in_background). Use dryRun to preview. Requires trusted or curator trust level.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: { type: 'string' }, description: 'Only dispatch to these agents. Default: all available.' },
        lanes: { type: 'array', items: { type: 'string' }, description: 'Only dispatch items in these lanes.' },
        maxAssignments: { type: 'number', description: 'Max assignments to make (default: all ready).' },
        dryRun: { type: 'boolean', description: 'Preview assignments without sending messages.' },
        autoExecute: { type: 'boolean', description: 'Attempt to spawn agents after delivery (default: true). When false, returns command_ready_manual.' },
        agent: { type: 'string', description: 'Dispatcher agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_dispatch_review',
    description: 'Dispatch code reviews for completed handoffs. Auto-detects handoffs ready for review (linked plan done, no existing review). Generates a structured review brief with diff, narrative, contract, and criteria. Sends to a reviewer agent via inbox. Requires trusted trust level.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string', description: 'Specific handoff ID to review. Default: auto-detect all reviewable handoffs.' },
        reviewer: { type: 'string', description: 'Specific reviewer agent. Default: any available agent that is not the author.' },
        dryRun: { type: 'boolean', description: 'Preview without sending.' },
        agent: { type: 'string', description: 'Dispatcher agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_send_message',
    description: 'Send a message to another agent\'s inbox. Used for work assignment (type: assign), review requests (type: review), RFC discussions (type: rfc), notifications (type: info), and threaded replies (type: reply). Requires contributor trust.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target agent name.' },
        type: { type: 'string', description: 'Message type: assign, review, rfc, info, reply.' },
        text: { type: 'string', description: 'Message body.' },
        ref: { type: 'string', description: 'Reference to a plan, sequence, handoff, or other entity ID.' },
        payload: { type: 'object', description: 'Structured data (brief, criteria, context).' },
        scope: { type: 'string', description: 'File scope relevant to this message.' },
        requires_ack: { type: 'boolean', description: 'Require recipient to acknowledge. Default: false.' },
        thread_id: { type: 'string', description: 'Thread ID for multi-turn conversations. Omit to start a new thread.' },
        agent: { type: 'string', description: 'Sender agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['to', 'type', 'text'],
    },
  },
  {
    name: 'bclaw_ack_message',
    description: 'Acknowledge a message in your inbox. Use after processing an assignment or review request.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message ID or short label to acknowledge.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_setup',
    description: 'Interactive onboarding wizard. Two modes: (1) Quick mode (default): probes the current repo and asks project type + topology, then inits. (2) Batch mode: scan root directories and init multiple repos. Call without step to start — brainclaw auto-detects the best mode.',
    annotations: { tier: 'facade', category: 'session' },
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
    description: 'Add a runtime note. Requires contributor trust level or above. Use crossProject to push a runtime-note signal to a linked project (requires role: publisher in cross_project_links config).',
    annotations: { tier: 'standard', category: 'memory' },
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
        cross_project: { type: 'string', description: 'Snake_case alias of crossProject.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'bclaw_quick_capture',
    description: 'Capture free-form text and classify it locally into a decision, trap, or fallback runtime note. Uses keyword heuristics only, never an LLM.',
    annotations: { tier: 'standard', category: 'memory' },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Free-form capture text.' },
        context: { type: 'string', description: 'Optional file/path/scope context to associate with the capture.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'bclaw_create_candidate',
    description: 'Create a memory candidate for review. Trusted/curator agents write through directly. Use targetProject to push a candidate signal to a linked project.',
    annotations: { tier: 'standard', category: 'memory' },
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
        targetProject: { type: 'string', description: 'Push this candidate as a cross-project signal to a linked project (name or path).' },
        target_project: { type: 'string', description: 'Snake_case alias of targetProject.' },
      },
      required: ['text', 'type'],
    },
  },
  {
    name: 'bclaw_accept',
    description: 'Accept a pending candidate into canonical memory. Requires trusted or curator trust level.',
    annotations: { tier: 'standard', category: 'memory' },
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
    annotations: { tier: 'standard', category: 'memory' },
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
    annotations: { tier: 'standard', category: 'coordination' },
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
        handoffMode: { type: 'string', enum: ['self-commit', 'integrator'], description: 'Handoff mode: "self-commit" (worker commits+merges) or "integrator" (another agent reviews+merges). Default: self-commit.' },
      },
      required: ['scope', 'description'],
    },
  },
  {
    name: 'bclaw_release_claim',
    description: 'Release a work claim.',
    annotations: { tier: 'standard', category: 'coordination' },
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
    annotations: { tier: 'standard', category: 'session' },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        context: { type: 'string', description: 'Context target path.' },
        maintenanceMode: { type: 'string', enum: ['fast', 'full'], description: 'Maintenance mode. Default is full for explicit session-start calls; use fast to skip non-critical maintenance work.' },
        includeContext: { type: 'boolean', description: 'Include project memory context in the response (equivalent to bclaw_get_context).' },
        includeBoard: { type: 'boolean', description: 'Include agent board (plans, claims, handoffs) in the response (equivalent to bclaw_get_agent_board).' },
        contextProfile: { type: 'string', description: 'Context profile when includeContext is true: dev (default), dense, compact, copilot, quick, briefing, openclaw, ops, research. If unset, uses the agent default profile.' },
        contextFormat: { type: 'string', description: 'Context format when includeContext is true: markdown, json, or template.' },
      },
    },
  },
  {
    name: 'bclaw_session_end',
    description: 'End a session and optionally auto-reflect observations as candidates.',
    annotations: { tier: 'standard', category: 'session' },
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session ID.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
        summary: { type: 'string', description: 'Session summary text.' },
        narrative: { type: 'string', description: 'Free-text narrative of what happened in the session and why. Goes beyond the auto-generated commit list: "Tried X, failed because Y, pivoted to Z. Watch out for A."' },
        autoReflect: { type: 'boolean', description: 'Auto-reflect session notes as candidates.' },
        autoRelease: { type: 'boolean', description: 'Auto-release any active claims at session end.' },
        reflectHandoff: { type: 'boolean', description: 'Materialize an open handoff from git commits since session start.' },
        dispatchReview: { type: 'boolean', description: 'When used with reflectHandoff, auto-dispatch a code review if the reflected handoff is reviewable.' },
        reviewer: { type: 'string', description: 'Explicit reviewer for the reflected handoff review dispatch.' },
        reflect: { type: 'boolean', description: 'Include structured reflection questions. Answer via bclaw_write_note with tag [reflection].' },
      },
    },
  },
  {
    name: 'bclaw_create_plan',
    description: 'Create a new plan item. Requires contributor trust level or above.',
    annotations: { tier: 'standard', category: 'coordination' },
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
    name: 'bclaw_create_sequence',
    description: 'Create a coordination sequence shared by agents.',
    annotations: { tier: 'advanced', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sequence name.' },
        description: { type: 'string', description: 'Optional sequence description.' },
        status: { type: 'string', description: 'Status: draft, active, archived.' },
        owner: { type: 'string', description: 'Optional sequence owner.' },
        items: { type: 'array', description: 'Sequence items in rank order.', items: { type: 'object' } },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'bclaw_update_sequence',
    description: 'Update a coordination sequence status, metadata, or items.',
    annotations: { tier: 'advanced', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sequence ID or short label.' },
        name: { type: 'string', description: 'Optional new sequence name.' },
        description: { type: 'string', description: 'Optional new description.' },
        status: { type: 'string', description: 'Status: draft, active, archived.' },
        owner: { type: 'string', description: 'Optional sequence owner.' },
        items: { type: 'array', description: 'Optional replacement items array.', items: { type: 'object' } },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional replacement tags.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_update_plan',
    description: 'Update the status, effort, or other fields of a plan item. Requires contributor trust level or above.',
    annotations: { tier: 'standard', category: 'coordination' },
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
    annotations: { tier: 'standard', category: 'coordination' },
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
    annotations: { tier: 'standard', category: 'coordination' },
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
    annotations: { tier: 'advanced', category: 'memory' },
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
    annotations: { tier: 'advanced', category: 'memory' },
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
    annotations: { tier: 'advanced', category: 'discovery' },
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
    annotations: { tier: 'advanced', category: 'discovery' },
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
    description: 'Update the status, recipient, contract, or review state of an open handoff. Requires contributor trust level or above. Use targetProject to push the resulting handoff state to a linked project.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Handoff ID to update.' },
        targetProject: { type: 'string', description: 'Push the updated handoff as a cross-project signal to a linked project (name or path).' },
        target_project: { type: 'string', description: 'Snake_case alias of targetProject.' },
        status: { type: 'string', description: 'New status: open, closed.' },
        to: { type: 'string', description: 'New recipient agent name.' },
        files_touched: { type: 'array', items: { type: 'string' }, description: 'Files touched in this handoff.' },
        pre_conditions: { type: 'array', items: { type: 'string' }, description: 'Pre-conditions for the receiving agent.' },
        post_conditions: { type: 'array', items: { type: 'string' }, description: 'Post-conditions the receiving agent must satisfy.' },
        tests_to_verify: { type: 'array', items: { type: 'string' }, description: 'Tests the receiving agent should verify.' },
        linked_plans: { type: 'array', items: { type: 'string' }, description: 'Linked plan IDs.' },
        narrative: { type: 'string', description: 'Free-text narrative of what happened and why, beyond the auto-generated commit list.' },
        reviewer: { type: 'string', description: 'Assigned reviewer for the handoff review.' },
        review_verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'Structured review verdict for this handoff.' },
        reviewed_by: { type: 'string', description: 'Agent or reviewer who produced the verdict.' },
        review_summary: { type: 'string', description: 'Short summary of the review outcome.' },
        blocking_issues: { type: 'array', items: { type: 'string' }, description: 'Blocking issues raised by review.' },
        suggestions: { type: 'array', items: { type: 'string' }, description: 'Non-blocking suggestions raised by review.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_compact',
    description: 'LLM-driven semantic memory compaction (two-phase). Phase 1 (no args or assess=true): returns pressure assessment and compaction template listing eligible items. Phase 2 (archiveIds + optional newItems): archives specified items and creates new durable memory entries. Safety: creates a backup before archiving.',
    annotations: { tier: 'advanced', category: 'memory' },
    inputSchema: {
      type: 'object',
      properties: {
        assess: { type: 'boolean', description: 'Phase 1: return pressure assessment and compaction template. Default when no archiveIds provided.' },
        archiveIds: { type: 'array', items: { type: 'string' }, description: 'Phase 2: IDs of items to archive (from assessment eligible list).' },
        newItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['constraint', 'decision', 'trap'], description: 'Memory item type.' },
              text: { type: 'string', description: 'Content of the new memory item.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the new item.' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Severity (traps only). Default: medium.' },
            },
            required: ['type', 'text'],
          },
          description: 'Phase 2: new durable memory items from your compaction summaries.',
        },
        maxItems: { type: 'number', description: 'Max items to show in assessment. Default: 20.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_work',
    description: 'Facade entry point: start a session, load context, and optionally claim a scope in a single call. intent=execute creates a claim; intent=consult/resume/review skips it. Eliminates the need for separate bclaw_session_start + bclaw_get_context + bclaw_claim calls.',
    annotations: { tier: 'facade', category: 'session' },
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['execute', 'consult', 'resume', 'review'], description: 'Work intent. "execute" creates a claim on the scope.' },
        scope: { type: 'string', description: 'Scope being worked on (required for execute intent to create a claim).' },
        planId: { type: 'string', description: 'Optional linked plan item ID.' },
        task: { type: 'string', description: 'Optional task description (used as claim description when creating a claim).' },
        messageId: { type: 'string', description: 'Optional message/thread ID for traceability.' },
        contextTarget: { type: 'string', description: 'Optional path passed to bclaw_get_context to filter memory.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'bclaw_coordinate',
    description: 'Multi-agent coordination facade: assign tasks to agents (with claims), consult agents (no claim), create a review candidate, reroute an active claim to another agent, or summarize a thread. Returns a FacadeResponse with selected_targets, delivery_plan, artifacts, and side_effects.',
    annotations: { tier: 'facade', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['assign', 'consult', 'review', 'reroute', 'summarize'], description: 'Coordination intent. "assign" creates a claim per target agent and dispatches the brief. "consult" dispatches without creating claims. "review" creates a review candidate. "reroute" releases the current claim and reassigns. "summarize" reads a thread and returns a summary.' },
        task: { type: 'string', description: 'Brief or task description delivered to target agents.' },
        scope: { type: 'string', description: 'File or feature scope. Used as claim scope for assign/reroute; as thread id for summarize if threadId is absent.' },
        targetAgents: { type: 'array', items: { type: 'string' }, description: 'Agent names to target. If omitted, all spawnable agents are used.' },
        constraints: { type: 'object', description: 'Optional structured constraints passed alongside the brief (e.g. deadline, reviewCriteria).' },
        threadId: { type: 'string', description: 'Thread ID for summarize intent.' },
        autoExecute: { type: 'boolean', description: 'Attempt to spawn target agents after delivery (default: true). When false, returns command_ready_manual with bash commands for the supervisor to run.' },
        agent: { type: 'string', description: 'Caller agent name.' },
        agentId: { type: 'string', description: 'Caller registered agent id.' },
      },
      required: ['intent', 'task'],
    },
  },
  {
    name: 'bclaw_assignment_update',
    description: 'Report assignment lifecycle status. Part of the Agent SDK runtime protocol. Workers call this to report: accepted (acknowledging receipt), started (work begun), progress (heartbeat), completed (done with artifacts), failed (error), or blocked (external blocker). The assignment_id is provided in the dispatch brief.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        assignment_id: { type: 'string', description: 'Assignment ID from the dispatch brief (asgn_xxx).' },
        status: { type: 'string', enum: ['accepted', 'started', 'progress', 'completed', 'failed', 'blocked'], description: 'Lifecycle status to report.' },
        message: { type: 'string', description: 'Human-readable status message or progress note.' },
        artifacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Artifact type: commit, branch, file, pr, test_result.' },
              ref: { type: 'string', description: 'Reference: SHA, branch name, file path, PR URL.' },
              description: { type: 'string', description: 'Optional description.' },
            },
            required: ['type', 'ref'],
          },
          description: 'Artifacts produced. Most useful for completed status.',
        },
        error_message: { type: 'string', description: 'Error details (for failed status).' },
        blocker: { type: 'string', description: 'Blocker description (for blocked status).' },
        action_required: {
          type: 'object',
          description: 'Optional ActionRequired payload when status=blocked. Lets the worker request approval, user input, or clarification before resuming.',
          properties: {
            kind: { type: 'string', enum: ['approval', 'user_input', 'clarification', 'plan_approval'], description: 'Kind of action needed.' },
            title: { type: 'string', description: 'Short title shown to supervisors/UI.' },
            prompt: { type: 'string', description: 'Question or approval prompt to answer.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Optional answer choices.' },
            response_schema: { type: 'object', description: 'Optional structured response schema hint.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          },
          required: ['kind', 'title', 'prompt'],
        },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['assignment_id', 'status'],
    },
  },
  {
    name: 'bclaw_assignment_action',
    description: 'Resolve or reject a pending ActionRequired item and update the linked Assignment/AgentRun state.',
    annotations: { tier: 'standard', category: 'coordination' },
    inputSchema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'ActionRequired ID (act_xxx).' },
        outcome: { type: 'string', enum: ['resolved', 'rejected', 'cancelled'], description: 'How the supervisor resolves the pending action.' },
        text: { type: 'string', description: 'Human-readable response or rationale.' },
        payload: { type: 'object', description: 'Optional structured response payload.' },
        agent: { type: 'string', description: 'Supervisor/agent responding to the action.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['action_id', 'outcome'],
    },
  },
] as const;

const ALL_TOOLS = [...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS];

type McpToolTier = 'facade' | 'standard' | 'advanced';

/** Tools with tier facade or standard — returned by default. Advanced tools require catalog=all. */
const DEFAULT_PUBLISHED_TOOLS = ALL_TOOLS.filter(
  (tool) => {
    const tier = (tool as { annotations?: { tier?: string } }).annotations?.tier;
    return tier === 'facade' || tier === 'standard';
  },
);

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

const LEGACY_MCP_TOOL_WARNINGS: Record<string, string> = {
  bclaw_session_start: 'Deprecated: use bclaw_work(intent: execute) which handles session start automatically.',
  bclaw_claim: 'Deprecated: use bclaw_work(intent: execute, scope: ...) which creates claims automatically.',
  bclaw_get_context: 'Deprecated: use bclaw_work(intent: consult) which returns context directly.',
  bclaw_check_policy: 'Deprecated: policy checks are now implicit in bclaw_work.',
};

function isLegacyMcpToolFacadeDisabled(name: string): boolean {
  return process.env.BRAINCLAW_FACADE_ONLY === '1' && Object.hasOwn(LEGACY_MCP_TOOL_WARNINGS, name);
}

function createLegacyMcpToolDisabledResponse(): McpToolResponse {
  return createToolErrorResponse('disabled', 'This tool is disabled. Use bclaw_work or bclaw_coordinate instead.');
}

function appendLegacyMcpToolWarning(response: McpToolResponse, name: string): McpToolResponse {
  const warning = LEGACY_MCP_TOOL_WARNINGS[name];
  if (!warning) {
    return response;
  }
  return {
    ...response,
    content: [...response.content, { type: 'text', text: warning }],
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

function scoreKeywordMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function classifyQuickCapture(text: string): QuickCaptureClassification {
  const normalized = text.trim().toLowerCase();
  const decisionPatterns = [
    /\b(decide|decision|decided|prefer|preferred|policy|convention|standard|standardize|adopt|chosen|choose|settled on)\b/,
    /\b(use|default to|go with|route through|switch to|migrate to|move to)\b/,
    /^(use|prefer|adopt|standardize|route|switch|migrate)\b/,
  ];
  const trapPatterns = [
    /\b(trap|warning|beware|avoid|never|don't|do not|risk|risky|gotcha|workaround)\b/,
    /\b(bug|broken|breaks|failure|fails|failing|flaky|blocked|missing|crash|regression|timeout|deadlock|race condition|leak)\b/,
    /\b(error|incident|problem|issue|hang|stuck|retry)\b/,
  ];

  const decisionScore = scoreKeywordMatches(normalized, decisionPatterns);
  const trapScore = scoreKeywordMatches(normalized, trapPatterns);

  if (decisionScore > 0 && trapScore > 0 && Math.abs(decisionScore - trapScore) <= 1) {
    return {
      target: 'note',
      reason: 'ambiguous_keywords',
      decisionScore,
      trapScore,
    };
  }

  if (trapScore >= 2 && trapScore >= decisionScore + 1) {
    return {
      target: 'trap',
      reason: 'trap_keywords',
      decisionScore,
      trapScore,
    };
  }

  if (decisionScore >= 2 && decisionScore >= trapScore + 1) {
    return {
      target: 'decision',
      reason: 'decision_keywords',
      decisionScore,
      trapScore,
    };
  }

  return {
    target: 'note',
    reason: decisionScore === trapScore && decisionScore > 0 ? 'ambiguous_keywords' : 'low_confidence',
    decisionScore,
    trapScore,
  };
}

function formatQuickCaptureNoteText(text: string, context?: string): string {
  if (!context) {
    return text;
  }
  return `${text}\n\nContext: ${context}`;
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
          const params = message.params === undefined ? {} : requireObjectParams(message.params, id ?? null);
          const catalog = typeof params.catalog === 'string' ? params.catalog : undefined;
          const include = typeof params.include === 'string' ? params.include : undefined;
          const tier = typeof params.tier === 'string' ? params.tier as McpToolTier : undefined;
          let tools;
          if (catalog === 'all' || include === 'all' || params.advanced === true) {
            tools = ALL_TOOLS;
          } else if (tier) {
            tools = ALL_TOOLS.filter((t) => (t as { annotations?: { tier?: string } }).annotations?.tier === tier);
          } else {
            tools = DEFAULT_PUBLISHED_TOOLS;
          }
          this.sendResult(id ?? null, { tools });
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
  // Briefing profile always uses its own ultra-compact renderer
  if (result.profile === 'briefing') {
    return renderContextBriefing(result);
  }
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

function getCrossProjectArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = args[key];
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return undefined;
}

function blockCrossProjectExecution(entity: 'claim' | 'plan' | 'session', args: Record<string, unknown>): McpToolResponse | undefined {
  const targetProject = getCrossProjectArg(args, 'targetProject', 'target_project', 'crossProject', 'cross_project');
  if (!targetProject) {
    return undefined;
  }

  try {
    assertCrossProjectBoundary(entity, targetProject);
    return undefined;
  } catch (error: unknown) {
    return createToolErrorResponse('validation_error', error instanceof Error ? error.message : String(error));
  }
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
      if (isLegacyMcpToolFacadeDisabled(name)) {
        return { response: createLegacyMcpToolDisabledResponse() };
      }
      return {
        response: appendLegacyMcpToolWarning(toolResponse(handleMcpReadToolCall(name, args, { cwd })), name),
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
      const crossProjectTarget = getCrossProjectArg(args, 'crossProject', 'cross_project');
      if (crossProjectTarget) {
        try {
          const opIdentity = buildOperationalIdentity(identity.agent_name, cwd, {
            agentId: identity.agent_id,
            sessionId: connectionSessionId,
          });
          const signal = writeCrossProjectSignal(
            resolveCrossProjectWritableTarget(crossProjectTarget, 'runtime_note', cwd),
            'runtime_note',
            {
              schema_version: 2,
              id: generateId('rtn'),
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
            },
            cwd,
          );
          return {
            response: toolResponse({
              content: [{ type: 'text', text: `✔ Cross-project runtime note signaled to '${signal.target_project.name}' [${signal.id}]` }],
              signal_id: signal.id,
              entity_type: signal.entity_type,
              note_id: (signal.payload as { id: string }).id,
              target_project: signal.target_project.name,
              target_path: signal.target_project.path,
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

    if (name === 'bclaw_quick_capture') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }

      const text = String(args.text ?? '');
      const inputValidation = validateMcpInput(text);
      if (!inputValidation.ok) {
        return { response: createToolErrorResponse('validation_error', inputValidation.errors[0]?.message ?? 'Invalid input', inputValidation.errors) };
      }

      const context = typeof args.context === 'string' ? args.context.trim() : undefined;
      if (context) {
        const contextCheck = validateMcpField(context, 'context');
        if (!contextCheck.ok) {
          return { response: createToolErrorResponse('validation_error', contextCheck.message) };
        }
      }

      const identity = resolved.identity!;
      const classification = classifyQuickCapture(text);
      if (classification.target === 'note') {
        const result = createRuntimeNote(formatQuickCaptureNoteText(text, context), {
          agent: identity.agent_name,
          agentId: identity.agent_id,
          tag: ['quick-capture'],
          visibility: 'shared',
          cwd,
          sessionId: connectionSessionId,
          model: currentModel,
        }, false);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Quick capture saved as runtime note [${result.noteId}]` }],
            structuredContent: {
              classification: classification.target,
              classification_reason: classification.reason,
              decision_score: classification.decisionScore,
              trap_score: classification.trapScore,
              note_id: result.noteId,
              session_id: result.sessionId,
              context,
            },
          }),
          nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : result.sessionId,
        };
      }

      const capture = createCandidateFromInput(text, classification.target, {
        tag: ['quick-capture'],
        author: identity.agent_name,
        authorId: identity.agent_id,
        sessionId: connectionSessionId,
        source: 'mcp:quick-capture',
        path: context,
        cwd,
      }, false, false, true);

      const statusText = capture.writeThrough
        ? `✔ Quick capture promoted as ${classification.target} [${capture.promotedItemId}]`
        : `✔ Quick capture saved as ${classification.target} candidate [${capture.candidateId}]`;
      return {
        response: toolResponse({
          content: [{ type: 'text', text: statusText }],
          structuredContent: {
            classification: classification.target,
            classification_reason: classification.reason,
            decision_score: classification.decisionScore,
            trap_score: classification.trapScore,
            candidate_id: capture.candidateId,
            promoted_item_id: capture.promotedItemId,
            write_through: capture.writeThrough,
            promotion_blocked_reason: capture.promotionBlockedReason,
            contradiction_summary: capture.contradictionSummary,
            contradictions_detected: capture.contradictionsDetected?.map((item) => ({
              severity: item.severity,
              reason: item.reason,
              conflicts_with: item.conflicts_with,
            })),
            context,
          },
        }),
        nextConnectionSessionId: undefined,
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

      // Cross-project report: write candidate signal in a linked project inbox
      const targetProjectArg = getCrossProjectArg(args, 'targetProject', 'target_project');
      if (targetProjectArg) {
        try {
          const targetLink = resolveCrossProjectWritableTarget(targetProjectArg, 'candidate', cwd);
          const candId = generateCandidateIdWithLabel(cwd);
          const candidate: any = {
            id: candId.id, short_label: candId.short_label, type, text: candidateText,
            created_at: nowISO(),
            author: identity.agent, author_id: identity.agent_id,
            project_id: identity.project_id, host_id: identity.host_id, session_id: identity.session_id,
            source: `cross-project:${loadConfig(cwd).project_name ?? 'unknown'}`,
            tags: [...candidateTags, 'cross-project-report'],
            status: 'pending' as const,
            severity: type === 'trap' ? ((args.severity as 'low' | 'medium' | 'high' | undefined) ?? 'medium') : undefined,
            plan_id: candidatePlanId, scope: candidateScope,
            model: currentModel,
            star_count: 0, starred_by: [], usage_count: 0, usage_events: [],
          };
          const signal = writeCrossProjectSignal(targetLink, 'candidate', candidate, cwd);
          appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: signal.id, item_type: 'candidate' }, cwd);
          return {
            response: toolResponse({
              content: [{ type: 'text', text: `✔ Cross-project candidate signal [${signal.id}] sent to ${targetLink.projectName}` }],
              signal_id: signal.id,
              candidate_id: candId.id,
              target_project: targetLink.projectName,
              target_path: targetLink.absolutePath,
              write_through: false,
            }),
            nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
          };
        } catch (error: unknown) {
          return { response: createToolErrorResponse('validation_error', error instanceof Error ? error.message : String(error)) };
        }
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
      if (isLegacyMcpToolFacadeDisabled(name)) {
        return { response: createLegacyMcpToolDisabledResponse() };
      }
      const crossProjectError = blockCrossProjectExecution('claim', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
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
      const rawHandoffMode = args.handoffMode as string | undefined;
      if (rawHandoffMode && rawHandoffMode !== 'self-commit' && rawHandoffMode !== 'integrator') {
        return { response: toolResponse({ content: [{ type: 'text', text: `Invalid handoffMode: "${rawHandoffMode}". Must be "self-commit" or "integrator".` }], isError: true }) };
      }
      const handoffMode = (rawHandoffMode as 'self-commit' | 'integrator' | undefined) ?? 'self-commit';
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
        handoff_mode: handoffMode,
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
      // Stale-branch detection: warn if behind master
      let staleBranchWarn = '';
      try {
        const { execSync: execSyncSB } = await import('node:child_process');
        const currentBranch = execSyncSB('git branch --show-current', { cwd: claimCwd, encoding: 'utf-8' }).trim();
        if (currentBranch && currentBranch !== 'master' && currentBranch !== 'main') {
          for (const mainBranch of ['master', 'main']) {
            try {
              const behind = execSyncSB(`git rev-list --count ${currentBranch}..${mainBranch}`, { cwd: claimCwd, encoding: 'utf-8' }).trim();
              const count = parseInt(behind, 10);
              if (count > 0) {
                staleBranchWarn = `\n⚠ Branch is ${count} commit(s) behind ${mainBranch}. Consider rebasing before editing.`;
              }
              break;
            } catch { /* branch doesn't exist, try next */ }
          }
        }
      } catch { /* git not available */ }

      const worktreeNote = worktreePath ? `\n  Worktree: ${worktreePath}` : '';
      const expiryNote = claimExpiresAt ? `\n  Expires: ${claimExpiresAt.slice(0, 16).replace('T', ' ')} UTC` : '';
      const handoffNote = handoffMode ? `\n  Handoff: ${handoffMode} (another agent will review and merge)` : '';
      const claimText = `✔ Claimed scope [${claimId}]${worktreeNote}${expiryNote}${handoffNote}${noPlanWarn}${worktreeWarn}${branchWarn}${staleBranchWarn}${policyWarn}${postClaimText ? `\n${postClaimText}` : ''}`;

      return {
        response: appendLegacyMcpToolWarning(toolResponse({
          content: [{ type: 'text', text: claimText }],
          claim_id: claimId,
          session_id: identity.session_id,
          worktree_path: worktreePath,
          triggered_items: postClaimItems,
        }), name),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
      };
    }

    if (name === 'bclaw_release_claim') {
      const crossProjectError = blockCrossProjectExecution('claim', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
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
      if (isLegacyMcpToolFacadeDisabled(name)) {
        return { response: createLegacyMcpToolDisabledResponse() };
      }
      const crossProjectError = blockCrossProjectExecution('session', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      // For identity_error on session start, let startSession handle auto-registration
      // instead of returning an immediate error (implements "don't require pre-registration to start").
      if (resolved.error && resolved.error.kind !== 'identity_error') {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const result = startSession({
        agent: resolved.identity?.agent_name ?? (typeof args.agent === 'string' ? args.agent : undefined),
        agentId: resolved.identity?.agent_id ?? (typeof args.agentId === 'string' ? args.agentId : undefined),
        context: args.context as string | undefined,
        maintenanceMode: args.maintenanceMode === 'fast' ? 'fast' : 'full',
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
      // Claim adoption: if BRAINCLAW_CLAIM_ID is set (spawned by dispatcher),
      // adopt the claim by writing session_id into it. This links claim→session.
      let adoptedClaimId: string | undefined;
      const envClaimId = process.env.BRAINCLAW_CLAIM_ID;
      if (envClaimId && result.session_id) {
        try {
          const adoptResult = adoptClaimSession(envClaimId, result.session_id, cwd);
          if (adoptResult.adopted) {
            adoptedClaimId = envClaimId;
          }
        } catch { /* best-effort — claim may not exist or be already adopted */ }
      }

      const sessionStartMsgParts = ['✔ Session started'];
      if (result.auto_registered) {
        sessionStartMsgParts.push(`\n⚠️ Agent '${result.agent}' was auto-registered (first use). Run \`brainclaw register-agent ${result.agent}\` to set capabilities and trust level.`);
      }
      if (adoptedClaimId) sessionStartMsgParts.push(`\n🔗 Adopted claim ${adoptedClaimId} — use bclaw_read_inbox with claimId to see your assignment.`);
      if (staleInstructionsWarn) sessionStartMsgParts.push(staleInstructionsWarn);
      if (sessionUpdateNotice) sessionStartMsgParts.push(sessionUpdateNotice);
      if (postSessionStartText) sessionStartMsgParts.push(postSessionStartText);
      if (result.memory_pressure) {
        sessionStartMsgParts.push(`\n⚠️ Memory pressure detected: ${result.memory_pressure.done_plans} done plans, ${result.memory_pressure.closed_handoffs} closed handoffs (${result.memory_pressure.eligible_items} eligible for compaction). Consider running bclaw_compact to archive old items and create durable summaries.`);
      }
      // Inbox notification
      const agentNameForInbox = resolved.identity?.agent_name ?? result.agent;
      if (agentNameForInbox) {
        const actionableCount = countActionable(agentNameForInbox, cwd);
        if (actionableCount > 0) {
          sessionStartMsgParts.push(`\n📬 You have ${actionableCount} actionable message(s) in your inbox. Use bclaw_read_inbox to check.`);
        }
      }
      const sessionStartMsg = sessionStartMsgParts.join('\n');

      const contentParts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: sessionStartMsg }];
      const inboxPending = agentNameForInbox ? countActionable(agentNameForInbox, cwd) : 0;
      const structured: Record<string, unknown> = {
        session_id: result.session_id,
        agent: result.agent,
        context_target: result.context_target,
        inbox_pending: inboxPending,
        ...(result.auto_registered ? { auto_registered: true } : {}),
        ...(result.memory_pressure ? { memory_pressure: result.memory_pressure } : {}),
      };

      if (args.includeContext) {
        const contextAgent = resolved.identity?.agent_name ?? result.agent;
        const previousSession = loadAllSessions(cwd)
          .find((session) => session.agent === contextAgent && session.session_id !== result.session_id);
        const ctxResult = buildContext({
          target: args.context as string | undefined,
          agent: contextAgent,
          profile: args.contextProfile as 'dev' | 'dense' | 'openclaw' | 'ops' | 'research' | 'compact' | 'copilot' | 'quick' | 'briefing' | undefined,
          cwd,
          sinceSession: previousSession?.session_id,
        });
        const format = normaliseFormat(args.contextFormat);
        const ctxText = renderContextForMcp(ctxResult, format, {});
        contentParts.push({ type: 'text', text: ctxText || 'No relevant memory found.' });
        structured.context = ctxResult;
      }

      if (args.includeBoard) {
        const board = buildCoordinationSnapshot({
          agent: resolved.identity?.agent_name ?? result.agent,
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
        if (board.active_sequence) {
          boardLines.push(`Active sequence: ${board.active_sequence.name} (${board.active_sequence.status})`);
          for (const item of board.active_sequence.items.slice(0, 5)) {
            const lane = item.lane ? ` lane=${item.lane}` : '';
            boardLines.push(`- #${item.rank} ${item.planId}${lane}`);
          }
        }
        boardLines.push(`Open handoffs: ${board.open_handoffs.length}`);
        for (const handoff of board.open_handoffs.slice(0, 5)) {
          boardLines.push(`- [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}`);
        }
        if (board.inbox_pending > 0) {
          boardLines.push(`📬 Inbox: ${board.inbox_pending} pending message(s)`);
        }
        contentParts.push({ type: 'text', text: boardLines.join('\n') });
        structured.board = board;
      }

      return {
        response: appendLegacyMcpToolWarning(toolResponse({
          content: contentParts,
          ...structured,
        }), name),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : result.session_id,
      };
    }

    if (name === 'bclaw_session_end') {
      const crossProjectError = blockCrossProjectExecution('session', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
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
        autoRelease: args.autoRelease as boolean | undefined,
        reflectHandoff: args.reflectHandoff as boolean | undefined,
        dispatchReview: args.dispatchReview as boolean | undefined,
        reviewer: args.reviewer as string | undefined,
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
          ...(result.handoff ? { handoff: result.handoff } : {}),
          ...(result.reflection_prompt ? { reflection_prompt: result.reflection_prompt } : {}),
        }),
        nextConnectionSessionId: undefined,
      };
    }

    if (name === 'bclaw_compact') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }

      const archiveIds = args.archiveIds as string[] | undefined;
      const isPhase2 = archiveIds && archiveIds.length > 0;

      if (isPhase2) {
        // Phase 2: apply compaction — archive specified items and create new memories
        const result = applyCompaction({
          archiveIds,
          newItems: args.newItems as Array<{ type: 'constraint' | 'decision' | 'trap'; text: string; tags?: string[]; severity?: string }> | undefined,
          author: resolved.identity?.agent_name,
          authorId: resolved.identity?.agent_id,
          cwd,
        });

        const lines: string[] = [];
        lines.push(`✔ Compacted ${result.archived_count} item(s).`);
        if (result.created_count > 0) {
          lines.push(`Created ${result.created_count} new memory item(s): ${result.created_ids.join(', ')}`);
        }
        lines.push(`Backup: ${result.backup_path}`);

        return {
          response: toolResponse({
            content: [{ type: 'text', text: lines.join('\n') }],
            ...result,
          }),
        };
      }

      // Phase 1: assess pressure and return compaction template
      const assessment = assessMemoryPressure(cwd);
      const maxItems = (args.maxItems as number | undefined) ?? 20;
      const selected = assessment.eligible_items.slice(0, maxItems);
      const template = selected.length > 0 ? buildCompactionTemplate(selected) : undefined;

      const lines: string[] = [];
      lines.push(`Memory pressure: ${assessment.pressure ? 'YES' : 'no'} (${assessment.done_plans} done plans, ${assessment.closed_handoffs} closed handoffs)`);
      lines.push(`Thresholds: plans >= ${assessment.thresholds.plans}, handoffs >= ${assessment.thresholds.handoffs}`);
      lines.push(`Eligible items: ${assessment.eligible_items.length}`);

      if (template) {
        lines.push('');
        lines.push(template);
      } else {
        lines.push('No items eligible for compaction.');
      }

      return {
        response: toolResponse({
          content: [{ type: 'text', text: lines.join('\n') }],
          pressure: assessment.pressure,
          done_plans: assessment.done_plans,
          closed_handoffs: assessment.closed_handoffs,
          eligible_count: assessment.eligible_items.length,
          eligible_ids: selected.map(i => i.id),
        }),
      };
    }

    if (name === 'bclaw_dispatch') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      try {
        const result = await dispatch({
          agents: args.agents as string[] | undefined,
          lanes: args.lanes as string[] | undefined,
          maxAssignments: args.maxAssignments as number | undefined,
          dryRun: args.dryRun as boolean | undefined,
          dispatcherAgent: resolved.identity!.agent_name,
          dispatcherAgentId: resolved.identity!.agent_id,
          sessionId: connectionSessionId,
          autoExecute: args.autoExecute as boolean | undefined,
        }, cwd);

        if (!result) {
          return { response: createToolErrorResponse('operation_error', 'No active sequence found. Create a sequence first.') };
        }

        const { analysis, result: dispatchResult } = result;
        const lines: string[] = [];

        if (args.dryRun) {
          lines.push('Dispatch dry run (no messages sent):');
        } else {
          lines.push('Dispatch cycle complete:');
        }

        lines.push(`  Sequence: ${analysis.sequence.name}`);
        lines.push(`  Ready: ${analysis.ready.length} | Active: ${analysis.active.length} | Blocked: ${analysis.blocked.length} | Done: ${analysis.done.length}`);

        if (dispatchResult.messages_sent.length > 0) {
          lines.push('');
          lines.push(args.dryRun ? '  Would assign:' : '  Assigned:');
          for (const msg of dispatchResult.messages_sent) {
            const lane = msg.lane ? ` (lane: ${msg.lane})` : '';
            lines.push(`    ${msg.agent}: ${msg.plan_id}${lane} [inbox]`);
          }
        }

        // Surface bash commands prominently — this is what the coordinator should run
        if (dispatchResult.commands.length > 0) {
          lines.push('');
          lines.push('Run these commands to launch the assigned agents:');
          lines.push('');
          for (const cmd of dispatchResult.commands) {
            const lane = cmd.lane ? ` [lane: ${cmd.lane}]` : '';
            lines.push(`# ${cmd.agent}${lane}`);
            lines.push(cmd.command);
            lines.push('');
          }
        }

        if (dispatchResult.skipped.length > 0) {
          lines.push('');
          lines.push('  Skipped:');
          for (const skip of dispatchResult.skipped) {
            lines.push(`    - ${skip.plan_id}: ${skip.reason}`);
          }
        }

        appendAuditEntry({
          actor: resolved.identity!.agent_name,
          actor_id: resolved.identity!.agent_id,
          action: 'create',
          item_type: 'dispatch',
          scope: `${dispatchResult.messages_sent.length} assignments`,
        }, cwd);

        return {
          response: toolResponse({
            content: [{ type: 'text', text: lines.join('\n') }],
            ...dispatchResult,
            sequence_id: analysis.sequence.id,
            dry_run: !!args.dryRun,
          }),
        };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_assignment_update') {
      // Contributor trust: lowest dispatchable level. The agent-owner guard
      // below ensures only the assigned agent can update its own assignment.
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      try {
        const assignmentId = typeof args.assignment_id === 'string' ? args.assignment_id : undefined;
        const status = typeof args.status === 'string' ? args.status : undefined;
        if (!assignmentId) return { response: createToolErrorResponse('input_error', 'assignment_id is required') };
        if (!status) return { response: createToolErrorResponse('input_error', 'status is required') };
        const message = args.message as string | undefined;
        const errorMessage = args.error_message as string | undefined;
        const blocker = args.blocker as string | undefined;
        const actionRequiredInput = args.action_required as Record<string, unknown> | undefined;
        const artifacts = Array.isArray(args.artifacts) ? args.artifacts as Array<{ type: string; ref: string; description?: string }> : undefined;

        // Warn if no active session (audit trail will be incomplete)
        const effectiveSessionId = connectionSessionId ?? 'unknown';

        const { loadAssignment, transitionAssignment: transitionAsgn, recordProgress: recordProg } = await import('../core/assignments.js');

        const assignment = loadAssignment(assignmentId, cwd);
        if (!assignment) {
          return { response: createToolErrorResponse('not_found', `Assignment not found: ${assignmentId}`) };
        }

        // Agent guard: only the assigned agent can update
        const callerAgent = resolved.identity!.agent_name;
        if (assignment.agent !== callerAgent) {
          return { response: createToolErrorResponse('trust_error', `Agent ${callerAgent} cannot update assignment owned by ${assignment.agent}`) };
        }

        if (status === 'progress') {
          const updated = recordProg(assignmentId, {
            message,
            artifacts,
            actor: callerAgent,
            actor_id: resolved.identity!.agent_id,
            session_id: effectiveSessionId,
          }, cwd);
          return {
            response: {
              content: [{ type: 'text', text: `Assignment ${assignmentId} heartbeat recorded` }],
              structuredContent: { assignment_id: assignmentId, status: updated.status, last_heartbeat_at: updated.last_heartbeat_at },
            },
          };
        }

        // Map status to FSM transition
        const statusReason = status === 'failed' ? errorMessage
          : status === 'blocked' ? blocker
          : message;

        const result = transitionAsgn(assignmentId, status as import('../core/schema.js').AssignmentStatus, {
          session_id: effectiveSessionId,
          status_reason: statusReason,
          artifacts,
          error_message: errorMessage,
          actor: callerAgent,
          actor_id: resolved.identity!.agent_id,
        }, cwd);

        // When accepted: auto-acknowledge the inbox message (replaces bclaw_ack_message)
        if (status === 'accepted' && assignment.message_id) {
          try {
            const { ackMessage } = await import('../core/messaging.js');
            ackMessage(assignment.message_id, callerAgent, cwd);
          } catch { /* best-effort: don't fail the update if ack fails */ }
        }

        let createdActionId: string | undefined;
        if (status === 'blocked' && actionRequiredInput) {
          const kind = String(actionRequiredInput.kind ?? '').trim();
          const title = String(actionRequiredInput.title ?? '').trim();
          const prompt = String(actionRequiredInput.prompt ?? '').trim();
          if (!['approval', 'user_input', 'clarification', 'plan_approval'].includes(kind) || !title || !prompt) {
            return { response: createToolErrorResponse('validation_error', 'action_required must include kind, title, and prompt when status=blocked') };
          }
          const { createActionRequired } = await import('../core/actions.js');
          const { findLatestAgentRunForAssignment } = await import('../core/agentruns.js');
          const latestRun = findLatestAgentRunForAssignment(assignmentId, cwd);
          const action = createActionRequired({
            assignment_id: assignmentId,
            run_id: latestRun?.id,
            claim_id: assignment.claim_id,
            message_id: assignment.message_id,
            plan_id: assignment.plan_id,
            sequence_id: assignment.sequence_id,
            agent: callerAgent,
            agent_id: resolved.identity!.agent_id,
            session_id: effectiveSessionId,
            kind: kind as import('../core/schema.js').ActionRequiredKind,
            scope: assignment.scope,
            title,
            prompt,
            options: Array.isArray(actionRequiredInput.options) ? actionRequiredInput.options.map(String) : [],
            response_schema: (actionRequiredInput.response_schema && typeof actionRequiredInput.response_schema === 'object')
              ? actionRequiredInput.response_schema as Record<string, unknown>
              : undefined,
            tags: Array.isArray(actionRequiredInput.tags) ? actionRequiredInput.tags.map(String) : ['action-required'],
          }, cwd);
          createdActionId = action.id;
        }

        return {
          response: {
            content: [{ type: 'text', text: `Assignment ${assignmentId} updated: ${result.previous_status} → ${status}` }],
            structuredContent: {
              assignment_id: assignmentId,
              status,
              previous_status: result.previous_status,
              ...(result.assignment.accepted_at && { accepted_at: result.assignment.accepted_at }),
              ...(result.assignment.started_at && { started_at: result.assignment.started_at }),
              ...(result.assignment.completed_at && { completed_at: result.assignment.completed_at }),
              last_heartbeat_at: result.assignment.last_heartbeat_at,
              ...(createdActionId ? { action_id: createdActionId } : {}),
            },
          },
        };
      } catch (err) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_dispatch_review') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      try {
        const result = dispatchReview({
          handoffId: args.handoffId as string | undefined,
          reviewer: args.reviewer as string | undefined,
          dryRun: args.dryRun as boolean | undefined,
          dispatcherAgent: resolved.identity!.agent_name,
          dispatcherAgentId: resolved.identity!.agent_id,
          sessionId: connectionSessionId,
        }, cwd);

        const lines: string[] = [];
        if (args.dryRun) {
          lines.push('🔍 Review dispatch dry run:');
        } else {
          lines.push('✔ Review dispatch complete:');
        }

        if (result.reviews_sent.length > 0) {
          for (const r of result.reviews_sent) {
            lines.push(`  → ${r.reviewer} reviewing ${r.handoff_id}${r.plan_id ? ` (${r.plan_id})` : ''} [inbox]`);
          }
        } else {
          lines.push('  No handoffs ready for review.');
        }

        if (result.skipped.length > 0) {
          lines.push('  Skipped:');
          for (const s of result.skipped) {
            lines.push(`    - ${s.handoff_id}: ${s.reason}`);
          }
        }

        appendAuditEntry({
          actor: resolved.identity!.agent_name,
          actor_id: resolved.identity!.agent_id,
          action: 'create',
          item_type: 'review',
          scope: `${result.reviews_sent.length} reviews`,
        }, cwd);

        return {
          response: toolResponse({
            content: [{ type: 'text', text: lines.join('\n') }],
            ...result,
          }),
        };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_assignment_action') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      try {
        const actionId = typeof args.action_id === 'string' ? args.action_id : undefined;
        const outcome = typeof args.outcome === 'string' ? args.outcome : undefined;
        if (!actionId) return { response: createToolErrorResponse('input_error', 'action_id is required') };
        if (!outcome || !['resolved', 'rejected', 'cancelled'].includes(outcome)) {
          return { response: createToolErrorResponse('validation_error', 'outcome must be one of: resolved, rejected, cancelled') };
        }

        const { resolveActionRequired, loadActionRequired } = await import('../core/actions.js');

        // Guard: an agent cannot resolve its own action (defeats approval workflow)
        const pendingAction = loadActionRequired(actionId, cwd);
        if (pendingAction && pendingAction.agent === resolved.identity!.agent_name) {
          return { response: createToolErrorResponse('trust_error', `Agent '${resolved.identity!.agent_name}' cannot resolve its own action. A supervisor or different agent must respond.`) };
        }

        const action = resolveActionRequired(actionId, {
          outcome: outcome as 'resolved' | 'rejected' | 'cancelled',
          text: typeof args.text === 'string' ? args.text : undefined,
          payload: args.payload && typeof args.payload === 'object' ? args.payload as Record<string, unknown> : undefined,
          responded_by: resolved.identity!.agent_name,
          responded_by_id: resolved.identity!.agent_id,
          session_id: connectionSessionId ?? 'unknown',
        }, cwd);

        return {
          response: {
            content: [{ type: 'text', text: `Action ${actionId} ${action.status}` }],
            structuredContent: {
              action_id: action.id,
              assignment_id: action.assignment_id,
              run_id: action.run_id,
              status: action.status,
              resolved_at: action.resolved_at,
              response: action.response,
            },
          },
        };
      } catch (err) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_send_message') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const to = String(args.to ?? '').trim();
      if (!to) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: to') };
      }
      const msgType = String(args.type ?? '').trim();
      if (!['assign', 'review', 'rfc', 'info', 'reply'].includes(msgType)) {
        return { response: createToolErrorResponse('validation_error', 'type must be one of: assign, review, rfc, info, reply') };
      }
      const msgText = String(args.text ?? '').trim();
      if (!msgText) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
      }
      const textCheck = validateMcpField(msgText, 'text');
      if (!textCheck.ok) {
        return { response: createToolErrorResponse('validation_error', textCheck.message) };
      }
      // Auto-generate thread_id for new rfc/review threads
      let threadId = args.thread_id as string | undefined;
      if (!threadId && (msgType === 'rfc' || msgType === 'review')) {
        threadId = `thread_${crypto.randomBytes(4).toString('hex')}`;
      }
      try {
        const result = sendMessage({
          from: resolved.identity!.agent_name,
          to,
          type: msgType as import('../core/schema.js').MessageType,
          text: msgText,
          ref: args.ref as string | undefined,
          payload: args.payload as Record<string, unknown> | undefined,
          scope: args.scope as string | undefined,
          requires_ack: args.requires_ack as boolean | undefined,
          thread_id: threadId,
          tags: (args.tags as string[]) ?? [],
          author_id: resolved.identity!.agent_id,
          session_id: connectionSessionId,
        }, cwd);
        appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'create', item_id: result.id, item_type: 'message', scope: to }, cwd);
        const threadInfo = threadId ? ` thread:${threadId}` : '';
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Message sent: [${result.shortLabel}] ${msgType} → ${to}${threadInfo}` }],
            message_id: result.id,
            thread_id: threadId,
          }),
        };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_ack_message') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const msgId = String(args.id ?? '').trim();
      if (!msgId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      try {
        const result = ackMessage(msgId, resolved.identity!.agent_name, cwd);
        appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: result.id, item_type: 'message' }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Message acknowledged: [${result.id}]` }],
            message_id: result.id,
            status: result.status,
          }),
        };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_create_plan') {
      const crossProjectError = blockCrossProjectExecution('plan', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
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

    if (name === 'bclaw_create_sequence') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const sequenceName = String(args.name ?? '').trim();
      if (!sequenceName) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: name') };
      }
      try {
        const result = createSequence({
          name: sequenceName,
          description: args.description as string | undefined,
          status: args.status as SequenceStatus | undefined,
          owner: args.owner as string | undefined,
          items: Array.isArray(args.items) ? args.items as SequenceItemInput[] : [],
          tags: Array.isArray(args.tags) ? args.tags as string[] : [],
          author: resolved.identity!.agent_name,
          authorId: resolved.identity!.agent_id,
          model: currentModel,
        }, cwd);
        appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'create', item_id: result.id, item_type: 'sequence' }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Sequence added: [${result.id}] ${sequenceName}` }],
            sequence_id: result.id,
          }),
        };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
      }
    }

    if (name === 'bclaw_update_sequence') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const sequenceId = String(args.id ?? '').trim();
      if (!sequenceId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      try {
        const result = updateSequence({
          id: sequenceId,
          name: args.name as string | undefined,
          description: args.description as string | undefined,
          status: args.status as SequenceStatus | undefined,
          owner: args.owner as string | undefined,
          items: Array.isArray(args.items) ? args.items as SequenceItemInput[] : undefined,
          tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
        }, cwd);
        appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: result.id, item_type: 'sequence' }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Sequence updated: [${result.id}] ${result.name}` }],
            sequence_id: result.id,
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

    if (name === 'bclaw_update_plan') {
      const crossProjectError = blockCrossProjectExecution('plan', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
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
      const crossProjectError = blockCrossProjectExecution('plan', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
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
      const crossProjectError = blockCrossProjectExecution('plan', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
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
      applyHandoffUpdates(handoff, {
        status: args.status as 'open' | 'accepted' | 'closed' | undefined,
        to: typeof args.to === 'string' ? String(args.to) : undefined,
        narrative: typeof args.narrative === 'string' ? String(args.narrative) : undefined,
        files_touched: Array.isArray(args.files_touched) ? args.files_touched as string[] : undefined,
        pre_conditions: Array.isArray(args.pre_conditions) ? args.pre_conditions as string[] : undefined,
        post_conditions: Array.isArray(args.post_conditions) ? args.post_conditions as string[] : undefined,
        tests_to_verify: Array.isArray(args.tests_to_verify) ? args.tests_to_verify as string[] : undefined,
        linked_plans: Array.isArray(args.linked_plans) ? args.linked_plans as string[] : undefined,
        reviewer: typeof args.reviewer === 'string' ? String(args.reviewer) : undefined,
        review_verdict: args.review_verdict as 'approve' | 'request_changes' | undefined,
        reviewed_by: typeof args.reviewed_by === 'string' ? String(args.reviewed_by) : undefined,
        review_summary: typeof args.review_summary === 'string' ? String(args.review_summary) : undefined,
        blocking_issues: Array.isArray(args.blocking_issues) ? args.blocking_issues as string[] : undefined,
        suggestions: Array.isArray(args.suggestions) ? args.suggestions as string[] : undefined,
      });
      saveState(state, cwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'update', item_id: handoffId, item_type: 'handoff' }, cwd);
      const targetProjectArg = getCrossProjectArg(args, 'targetProject', 'target_project');
      if (targetProjectArg) {
        try {
          const targetLink = resolveCrossProjectWritableTarget(targetProjectArg, 'handoff', cwd);
          const signal = writeCrossProjectSignal(targetLink, 'handoff', handoff, cwd);
          return {
            response: toolResponse({
              content: [{ type: 'text', text: `✔ Handoff updated locally and signaled to ${targetLink.projectName} [${signal.id}]` }],
              signal_id: signal.id,
              entity_type: signal.entity_type,
              handoff_id: handoffId,
              status: handoff.status,
              to: handoff.to,
              review: handoff.review,
              target_project: targetLink.projectName,
              target_path: targetLink.absolutePath,
              schema_version: SCHEMA_VERSION,
            }),
          };
        } catch (error: unknown) {
          return { response: createToolErrorResponse('validation_error', error instanceof Error ? error.message : String(error)) };
        }
      }
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Handoff updated: [${handoffId}] ${handoff.from} → ${handoff.to} (${handoff.status})` }],
          handoff_id: handoffId,
          status: handoff.status,
          to: handoff.to,
          review: handoff.review,
          schema_version: SCHEMA_VERSION,
        }),
      };
    }

    if (name === 'bclaw_work') {
      const startMs = Date.now();
      const parseResult = WorkRequestSchema.safeParse(args);
      if (!parseResult.success) {
        return { response: createToolErrorResponse('validation_error', parseResult.error.message) };
      }
      const workReq = parseResult.data;
      const warnings: string[] = [];

      // Step 1: implicit session start (handles auto-registration internally)
      let sessionResult: ReturnType<typeof startSession>;
      try {
        sessionResult = startSession({
          agent: typeof args.agent === 'string' ? args.agent : undefined,
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
          context: workReq.contextTarget,
          cwd,
        });
      } catch (sessionErr: unknown) {
        return { response: createToolErrorResponse('session_error', sessionErr instanceof Error ? sessionErr.message : String(sessionErr)) };
      }
      if (sessionResult.auto_registered) {
        warnings.push(`Agent '${sessionResult.agent}' was auto-registered (first use). Run \`brainclaw register-agent ${sessionResult.agent}\` to set capabilities and trust level.`);
      }

      // Step 2: build context for requested scope
      let contextResult: ReturnType<typeof buildContext> | undefined;
      try {
        contextResult = buildContext({
          target: workReq.contextTarget ?? workReq.scope,
          agent: sessionResult.agent,
          cwd,
        });
      } catch { /* non-fatal — context failure should not block work */ }

      // Step 3: claim if intent=execute and scope provided
      let claimId: string | undefined;
      let claimStatus: FacadeResponse['claim_status'] = 'none';
      if (workReq.intent === 'execute' && workReq.scope) {
        const existingClaims = listClaims(cwd).filter(
          (c) => c.status === 'active' && c.agent === sessionResult.agent && c.scope === workReq.scope,
        );
        if (existingClaims.length > 0) {
          claimId = existingClaims[0].id;
          claimStatus = 'existing';
        } else {
          claimId = generateClaimId();
          saveClaim({
            id: claimId,
            agent: sessionResult.agent,
            agent_id: sessionResult.agent_id,
            user: process.env.USER || process.env.USERNAME || undefined,
            project_id: undefined,
            host_id: undefined,
            session_id: sessionResult.session_id,
            scope: workReq.scope,
            description: workReq.task ?? workReq.scope,
            created_at: nowISO(),
            status: 'active',
            plan_id: workReq.planId,
            model: currentModel,
          }, cwd);
          appendAuditEntry({ actor: sessionResult.agent, actor_id: sessionResult.agent_id, action: 'claim', item_id: claimId, item_type: 'claim', scope: workReq.scope, session_id: sessionResult.session_id }, cwd);
          claimStatus = 'created';

          // Policy check post-claim
          const policyResult = checkPolicy({ scope: workReq.scope, agent: sessionResult.agent, agentId: sessionResult.agent_id, cwd });
          for (const w of policyResult.warnings.filter((pw) => pw.kind !== 'no_claim')) {
            const idLabel = w.id ? ` (${w.id})` : '';
            warnings.push(`[${w.kind}]${idLabel} ${w.message}`);
          }
        }
      }

      const facadeResponse: FacadeResponse = {
        status: 'ok',
        intent: workReq.intent,
        result: contextResult ?? null,
        artifacts: [],
        side_effects: claimId ? [{ action: claimStatus === 'created' ? 'create' : 'reuse', entity: 'claim', id: claimId }] : [],
        claim_status: claimStatus,
        session_id: sessionResult.session_id,
        warnings,
        duration_ms: Date.now() - startMs,
      };

      const summaryParts: string[] = [`✔ bclaw_work [${workReq.intent}] session=${sessionResult.session_id}`];
      if (claimId) summaryParts.push(`claim=${claimId} (${claimStatus})`);
      if (warnings.length > 0) summaryParts.push(warnings.map((w) => `⚠ ${w}`).join('\n'));

      return {
        response: toolResponse({
          content: [{ type: 'text', text: summaryParts.join('\n') }],
          structuredContent: facadeResponse as unknown as Record<string, unknown>,
        }),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : sessionResult.session_id,
      };
    }

    if (name === 'bclaw_coordinate') {
      const startMs = Date.now();
      const parseResult = CoordinateRequestSchema.safeParse(args);
      if (!parseResult.success) {
        return { response: createToolErrorResponse('validation_error', parseResult.error.message) };
      }
      const req = parseResult.data;
      const warnings: string[] = [];
      const artifacts: Array<{ type: string; id: string; path?: string }> = [];
      const side_effects: Array<{ action: string; entity: string; id: string }> = [];
      const senderAgent = typeof args.agent === 'string' && args.agent.trim()
        ? args.agent.trim()
        : 'bclaw_coordinate';
      const senderAgentId = typeof args.agentId === 'string' && args.agentId.trim()
        ? args.agentId.trim()
        : undefined;
      const commandHints: Array<{ agent: string; command: string; shell: string }> = [];
      type PreparedInvoke = { entry: CoordinateDeliveryEntry; invoke: ReturnType<typeof buildInvokeCommand>; worktreePath?: string };
      const preparedInvokes: PreparedInvoke[] = [];

      /** Run E2E execution phase on prepared delivery entries. Returns overall execution status. */
      const runCoordinateExecution = async (
        prepared: PreparedInvoke[],
        opts: { autoExecute: boolean; senderAgent: string; senderAgentId?: string; cwd: string; warnings: string[] },
      ): Promise<'delivered_and_started' | 'command_ready_manual' | 'inbox_only'> => {
        let overall: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only' = 'inbox_only';
        for (const { entry, invoke, worktreePath } of prepared) {
          const execResult = await attemptExecution(invoke, {
            agent: entry.agent,
            autoExecute: opts.autoExecute,
            worktreePath,
            claimId: entry.claim_id,
            dispatcherAgent: opts.senderAgent,
            dispatcherAgentId: opts.senderAgentId,
            cwd: opts.cwd,
          });
          entry.execution_status = execResult.execution_status;
          if (execResult.pid) entry.pid = execResult.pid;
          if (execResult.execution_status === 'delivered_and_started') {
            entry.channel = 'spawned_cli';
            overall = 'delivered_and_started';
          } else if (execResult.execution_status === 'command_ready_manual' && overall !== 'delivered_and_started') {
            overall = 'command_ready_manual';
          }
          if (execResult.error) opts.warnings.push(execResult.error);
          if (entry.assignment_id && entry.claim_id) {
            try {
              const run = createAgentRun({
                assignment_id: entry.assignment_id,
                claim_id: entry.claim_id,
                message_id: entry.message_id,
                agent: entry.agent,
                transport: execResult.execution_status === 'delivered_and_started'
                  ? 'cli_spawn'
                  : execResult.execution_status === 'command_ready_manual'
                    ? 'manual_command'
                    : 'inbox_only',
                scope: worktreePath ?? entry.scope ?? entry.ref ?? entry.assignment_id,
                description: `Coordinate execution attempt for ${entry.scope ?? entry.ref ?? entry.assignment_id}`,
                worktree_path: worktreePath,
                command: execResult.command,
                shell: execResult.shell,
                pid: execResult.pid,
                status_reason: execResult.error,
                tags: ['coordinate-run', `message:${entry.message_type}`],
              }, opts.cwd);

              if (execResult.execution_status === 'delivered_and_started') {
                transitionAgentRun(run.id, 'launching', {
                  actor: opts.senderAgent,
                  actor_id: opts.senderAgentId,
                  pid: execResult.pid,
                  status_reason: 'CLI spawn launched by coordinator',
                }, opts.cwd);
                transitionAgentRun(run.id, 'running', {
                  actor: opts.senderAgent,
                  actor_id: opts.senderAgentId,
                  pid: execResult.pid,
                  status_reason: 'CLI process started',
                }, opts.cwd);
              } else if (execResult.execution_status === 'command_ready_manual') {
                transitionAgentRun(run.id, 'waiting_input', {
                  actor: opts.senderAgent,
                  actor_id: opts.senderAgentId,
                  status_reason: execResult.error ?? 'Awaiting manual command execution',
                }, opts.cwd);
              } else {
                transitionAgentRun(run.id, 'waiting_input', {
                  actor: opts.senderAgent,
                  actor_id: opts.senderAgentId,
                  status_reason: 'Awaiting inbox pickup by assigned agent',
                }, opts.cwd);
              }
            } catch (runErr) {
              opts.warnings.push(`AgentRun creation failed for ${entry.assignment_id}: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
            }
          }
        }
        return overall;
      };

      /** Build a coordinate brief: delegates to shared generateDispatchBrief(). */
      const buildCoordinateBrief = (agentName: string, task: string, options?: { claimId?: string; scope?: string; worktreePath?: string; assignmentId?: string }): string => {
        return generateDispatchBrief({
          task,
          agent: agentName,
          claimId: options?.claimId,
          scope: options?.scope,
          worktreePath: options?.worktreePath,
          assignmentId: options?.assignmentId,
        });
      };
      type CoordinateDeliveryEntry = {
        agent: string;
        message_id: string;
        channel: 'inbox' | 'spawned_cli';
        message_type: 'assign' | 'rfc';
        requires_ack: boolean;
        ref?: string;
        scope?: string;
        thread_id?: string;
        claim_id?: string;
        assignment_id?: string;
        released_claim_id?: string;
        command?: string;
        shell?: string;
        execution_status?: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
        pid?: number;
      };
      const toMessageSummary = (deliveryPlan: CoordinateDeliveryEntry[]) => deliveryPlan.map((entry) => ({
        agent: entry.agent,
        message_id: entry.message_id,
        channel: entry.channel,
        ref: entry.ref,
        ...(entry.thread_id ? { thread_id: entry.thread_id } : {}),
      }));
      const queueCoordinateMessage = (input: {
        agent: string;
        text: string;
        messageType: 'assign' | 'rfc';
        ref?: string;
        scope?: string;
        requiresAck?: boolean;
        threadId?: string;
        claimId?: string;
        assignmentId?: string;
        releasedClaimId?: string;
        tags?: string[];
        payload?: Record<string, unknown>;
        commandMode?: 'worker' | 'consult';
      }): { entry: CoordinateDeliveryEntry; invoke: ReturnType<typeof buildInvokeCommand> } => {
        const msgResult = sendMessage({
          from: senderAgent,
          to: input.agent,
          type: input.messageType,
          text: input.text,
          ref: input.ref,
          payload: input.payload,
          scope: input.scope,
          requires_ack: input.requiresAck,
          thread_id: input.threadId,
          claim_id: input.claimId,
          assignment_id: input.assignmentId,
          tags: input.tags ?? [],
          author_id: senderAgentId,
          session_id: connectionSessionId,
        }, cwd);
        artifacts.push({ type: 'message', id: msgResult.id });
        side_effects.push({ action: 'create', entity: 'message', id: msgResult.id });

        const invoke = buildInvokeCommand(input.agent, input.text, {
          mode: input.commandMode ?? 'worker',
        });
        // Build env prefix for claim routing (cross-platform)
        const claimEnvPrefix = input.claimId
          ? (process.platform === 'win32' ? `set BRAINCLAW_CLAIM_ID=${input.claimId} && ` : `BRAINCLAW_CLAIM_ID=${input.claimId} `)
          : '';
        const resolvedShell = process.platform === 'win32' ? 'cmd' : (invoke?.shell ? 'bash' : 'sh');
        const commandHint = invoke
          ? {
              agent: input.agent,
              command: `${claimEnvPrefix}${invoke.bashCommand}`,
              shell: resolvedShell,
            }
          : undefined;
        if (commandHint) commandHints.push(commandHint);

        return {
          entry: {
            agent: input.agent,
            message_id: msgResult.id,
            channel: 'inbox',
            message_type: input.messageType,
            requires_ack: input.requiresAck ?? false,
            ref: input.ref,
            scope: input.scope,
            thread_id: input.threadId,
            claim_id: input.claimId,
            assignment_id: input.assignmentId,
            released_claim_id: input.releasedClaimId,
            command: commandHint?.command,
            shell: commandHint?.shell,
          },
          invoke,
        };
      };

      // Resolve target agents: explicit list or all spawnable
      const resolvedAgents: string[] = (req.targetAgents && req.targetAgents.length > 0)
        ? req.targetAgents
        : getSpawnableAgents().map((a) => a.name);

      let result: unknown = { selected_targets: resolvedAgents };

      if (req.intent === 'assign') {
        const delivery_plan: CoordinateDeliveryEntry[] = [];
        for (const agentName of resolvedAgents) {
          const profile = getCapabilityProfile(agentName);
          if (!profile) {
            warnings.push(`Unknown agent profile: ${agentName}`);
            continue;
          }
          // Ensure target agent is registered before creating claims/messages
          ensureAgentRegisteredForDispatch(agentName, cwd);
          const assignScope = req.scope ?? req.task;

          // Guard: warn if there is already a non-archived assign message for this agent+scope
          if (hasActiveAssignment(agentName, assignScope, cwd)) {
            warnings.push(JSON.stringify({
              warning: 'plan_already_assigned',
              plan_id: assignScope,
              existing_agent: agentName,
            }));
          }

          // Guard: warn if there is already an active claim on the same scope
          const conflictingClaims = listClaims(cwd).filter(
            (c) => c.status === 'active' && c.scope === assignScope,
          );
          if (conflictingClaims.length > 0) {
            const existing = conflictingClaims[0];
            warnings.push(JSON.stringify({
              warning: 'scope_already_claimed',
              scope: assignScope,
              existing_agent: existing.agent,
              existing_claim_id: existing.id,
            }));
          }

          const claimResult = createCoordinatorClaim({
            agent: agentName,
            scope: assignScope,
            description: req.task,
            dispatcherAgent: senderAgent,
            sessionId: connectionSessionId,
            cwd,
          });
          const claimId = claimResult.claimId;
          if (claimResult.worktreeWarning) {
            warnings.push(claimResult.worktreeWarning);
          }
          artifacts.push({ type: 'claim', id: claimId });
          side_effects.push({
            action: claimResult.reusedExisting ? 'reuse' : 'create',
            entity: 'claim',
            id: claimId,
          });
          let assignmentId: string | undefined;
          try {
            const preId = generateAssignmentId(cwd);
            const assignment = createAssignment({
              id: preId.id,
              short_label: preId.short_label,
              claim_id: claimId,
              agent: agentName,
              dispatcher_agent: senderAgent,
              dispatcher_session_id: connectionSessionId,
              scope: assignScope,
              description: req.task,
              tags: ['coordinate', 'assign'],
            }, cwd);
            assignmentId = assignment.id;
            artifacts.push({ type: 'assignment', id: assignment.id });
          } catch (err) {
            warnings.push(`Assignment creation failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
          }
          const assignBrief = buildCoordinateBrief(agentName, req.task, {
            claimId,
            scope: assignScope,
            worktreePath: claimResult.worktreePath,
            assignmentId,
          });
          const queued = queueCoordinateMessage({
            agent: agentName,
            text: assignBrief,
            messageType: 'assign',
            ref: assignScope,
            scope: assignScope,
            requiresAck: true,
            claimId,
            assignmentId,
            tags: ['coordinate', 'assign'],
            payload: {
              intent: req.intent,
              scope: assignScope,
              claim_id: claimId,
              ...(assignmentId ? { assignment_id: assignmentId } : {}),
              worktree_path: claimResult.worktreePath,
              constraints: req.constraints,
            },
            commandMode: 'worker',
          });
          if (assignmentId) {
            try {
              attachAssignmentMessageToClaim(claimId, queued.entry.message_id, cwd);
              linkClaimToAssignment(claimId, assignmentId, cwd);
              transitionAssignment(assignmentId, 'offered', { actor: senderAgent }, cwd);
              patchAssignmentMessageId(assignmentId, queued.entry.message_id, cwd);
              queued.entry.assignment_id = assignmentId;
            } catch (err) {
              warnings.push(`Assignment linkage failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          delivery_plan.push(queued.entry);
          preparedInvokes.push({ entry: queued.entry, invoke: queued.invoke, worktreePath: claimResult.worktreePath });
        }

        // E2E execution phase: attempt to spawn assigned agents
        const overallExecStatus = await runCoordinateExecution(preparedInvokes, {
          autoExecute: req.autoExecute !== false,
          senderAgent, senderAgentId, cwd, warnings,
        });

        result = {
          selected_targets: resolvedAgents,
          delivery_plan,
          messages_sent: toMessageSummary(delivery_plan),
          commands: commandHints,
          execution_status: overallExecStatus,
        };

      } else if (req.intent === 'consult') {
        const consultThreadId = req.threadId ?? `thread_${crypto.randomBytes(4).toString('hex')}`;
        const contacted: string[] = [];
        const delivery_plan: CoordinateDeliveryEntry[] = [];
        for (const agentName of resolvedAgents) {
          const profile = getCapabilityProfile(agentName);
          if (!profile) {
            warnings.push(`Unknown agent profile: ${agentName}`);
            continue;
          }
          delivery_plan.push(queueCoordinateMessage({
            agent: agentName,
            text: req.task,
            messageType: 'rfc',
            scope: req.scope,
            threadId: consultThreadId,
            tags: ['coordinate', 'consult'],
            payload: {
              intent: req.intent,
              scope: req.scope,
              constraints: req.constraints,
            },
            commandMode: 'consult',
          }).entry);
          contacted.push(agentName);
        }
        result = {
          selected_targets: resolvedAgents,
          contacted,
          thread_id: consultThreadId,
          delivery_plan,
          messages_sent: toMessageSummary(delivery_plan),
          commands: commandHints,
        };

      } else if (req.intent === 'review') {
        const candId = generateCandidateIdWithLabel(cwd);
        saveCandidate({
          id: candId.id,
          short_label: candId.short_label,
          type: 'handoff',
          text: req.task,
          created_at: nowISO(),
          author: senderAgent,
          author_id: senderAgentId,
          tags: ['review'],
          status: 'pending',
          star_count: 0,
          starred_by: [],
          usage_count: 0,
          usage_events: [],
          ...(req.scope ? { related_paths: [req.scope] } : {}),
        }, cwd);
        artifacts.push({ type: 'candidate', id: candId.id });
        side_effects.push({ action: 'create', entity: 'candidate', id: candId.id });
        result = { candidate_id: candId.id, selected_targets: resolvedAgents };

      } else if (req.intent === 'reroute') {
        const activeClaims = listClaims(cwd).filter(
          (c) => c.status === 'active' && (req.scope ? c.scope === req.scope : true),
        );
        if (activeClaims.length === 0) {
          return { response: createToolErrorResponse('not_found', `No active claim found for scope: ${req.scope ?? '(any)'}`) };
        }
        const oldClaim = activeClaims[0];
        saveClaim({ ...oldClaim, status: 'released' as const, released_at: nowISO() }, cwd);
        appendAuditEntry({ actor: oldClaim.agent, action: 'release_claim', item_id: oldClaim.id, item_type: 'claim', scope: oldClaim.scope }, cwd);
        side_effects.push({ action: 'release', entity: 'claim', id: oldClaim.id });

        const newAgentName = resolvedAgents.find((a) => a !== oldClaim.agent) ?? resolvedAgents[0];
        let newClaimId: string | undefined;
        if (newAgentName) {
          const profile = getCapabilityProfile(newAgentName);
          if (profile) {
            ensureAgentRegisteredForDispatch(newAgentName, cwd);
            const rerouteClaimResult = createCoordinatorClaim({
              agent: newAgentName,
              scope: oldClaim.scope,
              description: req.task,
              dispatcherAgent: senderAgent,
              sessionId: connectionSessionId,
              cwd,
            });
            newClaimId = rerouteClaimResult.claimId;
            if (rerouteClaimResult.worktreeWarning) {
              warnings.push(rerouteClaimResult.worktreeWarning);
            }
            artifacts.push({ type: 'claim', id: newClaimId });
            side_effects.push({
              action: rerouteClaimResult.reusedExisting ? 'reuse' : 'create',
              entity: 'claim',
              id: newClaimId,
            });
            let rerouteAssignmentId: string | undefined;
            try {
              const preId = generateAssignmentId(cwd);
              const assignment = createAssignment({
                id: preId.id,
                short_label: preId.short_label,
                claim_id: newClaimId,
                agent: newAgentName,
                dispatcher_agent: senderAgent,
                dispatcher_session_id: connectionSessionId,
                scope: oldClaim.scope,
                description: req.task,
                tags: ['coordinate', 'assign', 'reroute'],
              }, cwd);
              rerouteAssignmentId = assignment.id;
              artifacts.push({ type: 'assignment', id: assignment.id });
            } catch (err) {
              warnings.push(`Assignment creation failed for ${newAgentName}: ${err instanceof Error ? err.message : String(err)}`);
            }
            const rerouteBrief = buildCoordinateBrief(newAgentName, req.task, {
              claimId: newClaimId,
              scope: oldClaim.scope,
              worktreePath: rerouteClaimResult.worktreePath,
              assignmentId: rerouteAssignmentId,
            });
            const delivery_plan: CoordinateDeliveryEntry[] = [];
            const reroutePrepared: PreparedInvoke[] = [];
            const queued = queueCoordinateMessage({
              agent: newAgentName,
              text: rerouteBrief,
              messageType: 'assign',
              ref: oldClaim.scope,
              scope: oldClaim.scope,
              requiresAck: true,
              claimId: newClaimId,
              assignmentId: rerouteAssignmentId,
              releasedClaimId: oldClaim.id,
              tags: ['coordinate', 'assign', 'reroute'],
              payload: {
                intent: req.intent,
                scope: oldClaim.scope,
                claim_id: newClaimId,
                ...(rerouteAssignmentId ? { assignment_id: rerouteAssignmentId } : {}),
                worktree_path: rerouteClaimResult.worktreePath,
                released_claim_id: oldClaim.id,
                previous_agent: oldClaim.agent,
                constraints: req.constraints,
              },
              commandMode: 'worker',
            });
            if (rerouteAssignmentId) {
              try {
                attachAssignmentMessageToClaim(newClaimId, queued.entry.message_id, cwd);
                linkClaimToAssignment(newClaimId, rerouteAssignmentId, cwd);
                transitionAssignment(rerouteAssignmentId, 'offered', { actor: senderAgent }, cwd);
                patchAssignmentMessageId(rerouteAssignmentId, queued.entry.message_id, cwd);
                queued.entry.assignment_id = rerouteAssignmentId;
              } catch (err) {
                warnings.push(`Assignment linkage failed for ${newAgentName}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            delivery_plan.push(queued.entry);
            reroutePrepared.push({ entry: queued.entry, invoke: queued.invoke, worktreePath: rerouteClaimResult.worktreePath });

            const rerouteExecStatus = await runCoordinateExecution(reroutePrepared, {
              autoExecute: req.autoExecute !== false,
              senderAgent, senderAgentId, cwd, warnings,
            });

            result = {
              released_claim: oldClaim.id,
              old_agent: oldClaim.agent,
              new_agent: newAgentName,
              new_claim_id: newClaimId,
              selected_targets: resolvedAgents,
              delivery_plan,
              messages_sent: toMessageSummary(delivery_plan),
              commands: commandHints,
              execution_status: rerouteExecStatus,
            };
          } else {
            warnings.push(`Unknown agent profile: ${newAgentName}`);
          }
        }
        if (!('released_claim' in (result as Record<string, unknown>))) {
          result = {
            released_claim: oldClaim.id,
            old_agent: oldClaim.agent,
            new_agent: newAgentName,
            new_claim_id: newClaimId,
            selected_targets: resolvedAgents,
            delivery_plan: [],
            messages_sent: [],
            commands: commandHints,
          };
        }

      } else if (req.intent === 'summarize') {
        const threadId = req.threadId ?? req.scope;
        if (!threadId) {
          return { response: createToolErrorResponse('validation_error', 'summarize intent requires threadId or scope') };
        }
        const messages = getThread(threadId, cwd, { truncateText: 500 });
        const summary = messages.length === 0
          ? 'No messages found in thread.'
          : messages.map((m, i) => `[${i + 1}] ${m.from} → ${m.to}: ${m.text}`).join('\n');
        result = { thread_id: threadId, message_count: messages.length, summary };
      }

      // Extract execution_status from result if present (assign/reroute set it)
      const resultExecStatus = (result && typeof result === 'object' && 'execution_status' in result)
        ? (result as Record<string, unknown>).execution_status as FacadeResponse['execution_status']
        : undefined;
      const facadeResponse: FacadeResponse = {
        status: 'ok',
        intent: req.intent,
        result,
        artifacts,
        side_effects,
        warnings,
        duration_ms: Date.now() - startMs,
        ...(resultExecStatus ? { execution_status: resultExecStatus } : {}),
      };

      const summaryParts: string[] = [`✔ bclaw_coordinate [${req.intent}] targets=${resolvedAgents.length}`];
      if (resultExecStatus) summaryParts.push(`execution: ${resultExecStatus}`);
      if (warnings.length > 0) summaryParts.push(warnings.map((w) => `⚠ ${w}`).join('\n'));

      return {
        response: toolResponse({
          content: [{ type: 'text', text: summaryParts.join('\n') }],
          structuredContent: facadeResponse as unknown as Record<string, unknown>,
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
