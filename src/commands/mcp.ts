import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { resolveCrossProjectWritableTarget, writeCrossProjectSignal } from '../core/cross-project.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate, renderContextBriefing } from '../core/context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { checkBrainclawInstallableUpdate, getInstalledBrainclawVersion, readDiskBrainclawVersion, renderBrainclawInstallableUpdateNotice } from '../core/brainclaw-version.js';
import { loadConfig } from '../core/config.js';
import { loadState, persistState, saveState } from '../core/state.js';
import { generateIdWithLabel } from '../core/ids.js';
import { memoryExists } from '../core/io.js';
import { generateCandidateIdWithLabel, loadCandidate, saveCandidate } from '../core/candidates.js';
import {
  createEntity,
  getEntity,
  listEntities,
  removeEntity,
  transitionEntity,
  updateEntity,
  type EntityFilter,
} from '../core/entity-operations.js';
import { ENTITY_REGISTRY, type EntityName } from '../core/entity-registry.js';
import { generateClaimId, listClaims, loadClaim, saveClaim, createCoordinatorClaim, adoptClaimSession, attachAssignmentMessageToClaim, linkClaimToAssignment, releaseClaimWithCascade } from '../core/claims.js';
import { createSequence, updateSequence, deleteSequence } from '../core/sequence.js';
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
  findAgentIdentityById,
  findAgentIdentityByName,
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
import type { CandidateType, MemoryVisibility, PlanStatus, PlanStepStatus, PlanType, Priority, SequenceItemInput, SequenceStatus } from '../core/schema.js';
import { createPlan, addStep as addStepOp, completeStep as completeStepOp, updateStep as updateStepOp, deleteStep as deleteStepOp, deletePlan as deletePlanOp, updatePlan as updatePlanOp } from '../core/operations/plan.js';
import { sendMessage, ackMessage, countPending, countActionable, getThread, hasActiveAssignment } from '../core/messaging.js';
import { analyzeSequence, dispatch, dispatchReview, generateDispatchBrief } from '../core/dispatcher.js';
import { deleteMemoryItem, updateMemoryItem, type MemoryItemType } from '../core/operations/memory-mutation.js';
import { compact as gcCompact, assessMemoryPressure, buildCompactionTemplate, applyCompaction } from '../core/gc-semantic.js';
import { WorkRequestSchema, CoordinateRequestSchema, type FacadeResponse } from '../core/facade-schema.js';
import { getSpawnableAgents, getCapabilityProfile, buildInvokeCommand, resolveBriefMode, validateAgentForDispatch } from '../core/agent-capability.js';
import { attemptExecution } from '../core/execution.js';
import { createAgentRun, transitionAgentRun } from '../core/agentruns.js';
import {
  createAssignment,
  generateAssignmentId,
  patchAssignmentMessageId,
  transitionAssignment,
  bumpActiveAssignmentHeartbeat,
  getActiveAssignmentForAgent,
} from '../core/assignments.js';
import { harvestCandidates } from './harvest.js';

export type ContextFormat = 'markdown' | 'json' | 'template';
export type McpProtocolVersion = '2024-11-05' | '2025-11-25';
export type McpConnectionState = 'pre_init' | 'awaiting_initialized' | 'ready' | 'closed';
export type JsonRpcId = string | number | null;

export const SCHEMA_VERSION = '1.0.0';
export const MCP_PROTOCOL_VERSIONS: McpProtocolVersion[] = ['2025-11-25', '2024-11-05'];
export const MCP_SERVER_NOT_INITIALIZED = -32002;
const MCP_RUNTIME_REPAIR_COMMAND = 'brainclaw doctor --repair';

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
    name: 'bclaw_bootstrap',
    description: 'Derive brownfield bootstrap signals, adaptive interview prompts for CLI or IDE chat agents, and an import proposal from repository docs, manifests, native agent files, and git history.',
    annotations: { tier: 'standard', category: 'context' , headlessApproval: 'prompt' },
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
    name: 'bclaw_release_notes',
    description: 'Return the agent-first release notes for the latest installable Brainclaw version from the configured update source. Returns structured highlights, breaking risk, and action recommendation when available.',
    annotations: { tier: 'standard', category: 'context' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    // ── Canonical context read (Phase 3 slice 3c) ──────────────────────
    // Unified dispatcher over the four legacy context reads.
    // Promoted to standard tier at the v1.0 cut.
    name: 'bclaw_context',
    description: 'Unified context read. Dispatches by kind: memory (project memory for a path), execution (local execution env), board (full agent board), board_summary (compact counts), delta (memory changes since a reference session).',
    annotations: { tier: 'facade', category: 'context', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['memory', 'execution', 'board', 'board_summary', 'delta'],
          description: 'memory = project memory context; execution = local env/tooling; board = full agent board; board_summary = lightweight counts; delta = memory changes since `since`.',
        },
        since: {
          type: 'string',
          description: 'For kind=delta: a session_id (sess_...) used as the reference point. Future: also accept ISO timestamp or handoff_id.',
        },
        path: { type: 'string', description: 'kind=memory: file path or glob to filter memory by.' },
        agent: { type: 'string', description: 'Agent name (memory/board kinds).' },
        host: { type: 'string', description: 'Host identifier (memory kind).' },
        allHosts: { type: 'boolean', description: 'Include machine-local runtime from all hosts (memory kind).' },
        profile: { type: 'string', description: 'Memory profile: dev, dense, compact, copilot, quick, briefing, openclaw, ops, research.' },
        includePending: { type: 'boolean', description: 'Include pending candidates (memory kind).' },
        maxItems: { type: 'number', description: 'Max ranked items (memory kind).' },
        maxChars: { type: 'number', description: 'Approximate character budget (memory kind).' },
        digest: { type: 'boolean', description: 'Include deterministic digest (memory kind).' },
        bootstrap: { type: 'boolean', description: 'Enable brownfield bootstrap fallback (memory kind).' },
        refreshBootstrap: { type: 'boolean', description: 'Force fresh bootstrap scan (memory kind).' },
        format: { type: 'string', description: 'Output format (memory kind): markdown, json, template.' },
        explain: { type: 'boolean', description: 'Include ranking reasons (memory kind, markdown format).' },
        compactTemplate: { type: 'boolean', description: 'Use compact template (memory kind, format=template).' },
        includeAgentTooling: { type: 'boolean', description: 'Include agent tooling signals (execution kind).' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'bclaw_search',
    description: 'Full-text search across all memory items (decisions, constraints, traps, candidates, handoffs, plans, sequences) using BM25 scoring.',
    annotations: { tier: 'standard', category: 'memory' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string.' },
        type: { type: 'string', description: 'Filter by section: decisions, constraints, traps, handoffs, candidates, plans, sequences.' },
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
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Filter by agent/author name.' },
      },
    },
  },
  {
    name: 'bclaw_list_sequences',
    description: 'List coordination sequences with optional filters on status and id.',
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'auto' },
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
    name: 'bclaw_assignment_events',
    description: 'List correlated runtime events for assignments and runs with filters on assignment, run, claim, session, agent, or event type.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    name: 'bclaw_list_agents',
    description: 'List registered agent identities and optionally include bounded reputation summaries.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
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
    name: 'bclaw_get_capabilities',
    description: 'List all registered project capabilities with full metadata.',
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'session' , headlessApproval: 'prompt' },
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
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'governance' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Thread ID to retrieve.' },
      },
      required: ['thread_id'],
    },
  },
] as const;

const MCP_WRITE_TOOLS = [
  {
    name: 'bclaw_dispatch',
    description: 'Unified dispatch entry for sequence-lane parallelization. `intent` discriminator: analysis (sequence lane status, read-only), execute (default — analyze + generate briefs + send), review (routes an EXISTING reviewable handoff to a reviewer — NOT for opening new reviews; use bclaw_coordinate(intent=review, open_loop=true) for that). Consolidates bclaw_dispatch_analysis / bclaw_dispatch / bclaw_dispatch_review.',
    annotations: { tier: 'facade', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['analysis', 'execute', 'review'], description: 'Dispatch intent. Default: execute.' },
        // intent=execute args
        agents: { type: 'array', items: { type: 'string' }, description: 'Only dispatch to these agents. Default: all available.' },
        lanes: { type: 'array', items: { type: 'string' }, description: 'Only dispatch items in these lanes. Also used by intent=analysis.' },
        maxAssignments: { type: 'number', description: 'Max assignments to make (default: all ready). intent=execute only.' },
        dryRun: { type: 'boolean', description: 'Preview without sending. Accepted by all intents.' },
        autoExecute: { type: 'boolean', description: 'Attempt to spawn agents after delivery (default: true). intent=execute only.' },
        // intent=review args (forwarded to bclaw_dispatch_review)
        handoffId: { type: 'string', description: 'intent=review: specific handoff ID. Default: auto-detect reviewable handoffs.' },
        reviewer: { type: 'string', description: 'intent=review: specific reviewer agent. Default: any available non-author.' },
        openLoop: { type: 'boolean', description: 'intent=review: open a review_loop alongside the inbox message (default true).' },
        reviewMode: { type: 'string', enum: ['asymmetric', 'symmetric'], description: 'intent=review: loop mode when openLoop=true.' },
        // Common
        agent: { type: 'string', description: 'Dispatcher agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
    },
  },
  {
    name: 'bclaw_send_message',
    description: 'Send a message to another agent\'s inbox. Used for work assignment (type: assign), review requests (type: review), RFC discussions (type: rfc), notifications (type: info), and threaded replies (type: reply). Requires contributor trust.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    annotations: { tier: 'facade', category: 'session' , headlessApproval: 'prompt' },
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
    annotations: { tier: 'standard', category: 'memory' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'memory' , headlessApproval: 'auto' },
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
    name: 'bclaw_claim',
    description: 'Claim a work scope (advisory lock). Automatically creates an isolated git worktree for this claim. Requires contributor trust level or above.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'session' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'session' , headlessApproval: 'auto' },
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
    name: 'bclaw_create_sequence',
    description: 'Create a coordination sequence shared by agents.',
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'prompt' },
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
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'prompt' },
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
    name: 'bclaw_add_step',
    description: 'Add a sub-step to a plan item. Requires contributor trust level or above.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    name: 'bclaw_update_step',
    description: 'Update a plan sub-step (status, text, assignee). Supports all step statuses: todo, in_progress, testing, done, blocked. Requires contributor trust level or above.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan item ID.' },
        stepId: { type: 'string', description: 'Step ID to update.' },
        status: { type: 'string', description: 'New status: todo, in_progress, testing, done, blocked.' },
        text: { type: 'string', description: 'New step text.' },
        assignee: { type: 'string', description: 'New assignee (empty string to unassign).' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['planId', 'stepId'],
    },
  },
  {
    name: 'bclaw_delete_step',
    description: 'Remove a sub-step from a plan. Requires contributor trust level or above.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan item ID.' },
        stepId: { type: 'string', description: 'Step ID to delete.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['planId', 'stepId'],
    },
  },
  {
    name: 'bclaw_delete_plan',
    description: 'Delete a plan item by ID. Requires trusted or curator trust level.',
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plan item ID to delete.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_delete_sequence',
    description: 'Delete a sequence by ID. Requires trusted or curator trust level.',
    annotations: { tier: 'advanced', category: 'coordination' , headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sequence ID to delete.' },
        agent: { type: 'string', description: 'Agent name.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_delete_memory',
    description: 'Delete a memory item (constraint, decision, or trap) by ID. Requires trusted or curator trust level.',
    annotations: { tier: 'advanced', category: 'memory' , headlessApproval: 'prompt' },
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
    annotations: { tier: 'advanced', category: 'memory' , headlessApproval: 'prompt' },
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
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'prompt' },
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
    annotations: { tier: 'advanced', category: 'discovery' , headlessApproval: 'prompt' },
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
    name: 'bclaw_correct_handoff',
    description: 'Write a correction handoff that supersedes an earlier, incorrect one (P6.1 tombstone). The original handoff is left immutable — federation and history still carry both records. The new handoff copies non-overridden fields from the original and sets `supersedes` back at it; the original gets `superseded_by` pointing at the new record.',
    annotations: { tier: 'standard', category: 'coordination', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        originalId: { type: 'string', description: 'ID of the handoff to correct.' },
        text: { type: 'string', description: 'Optional replacement narrative (markdown / free text). Defaults to the original narrative with an appended correction note.' },
        narrative: { type: 'string', description: 'Optional override of the narrative sub-field.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional replacement tags. Defaults to original tags.' },
        reason: { type: 'string', description: 'Short rationale for the correction, appended to the narrative.' },
        agent: { type: 'string', description: 'Author of the correction.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: ['originalId'],
    },
  },
  {
    name: 'bclaw_update_handoff',
    description: 'Update the status, recipient, contract, or review state of an open handoff. Requires contributor trust level or above. Use targetProject to push the resulting handoff state to a linked project.',
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
    annotations: { tier: 'advanced', category: 'memory' , headlessApproval: 'prompt' },
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
    annotations: { tier: 'facade', category: 'session' , headlessApproval: 'auto' },
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
        compact: { type: 'boolean', description: 'Return a compact payload (default true). Set to false to include the full context result. Compact mode avoids exceeding MCP token limits on projects with large memory.', default: true },
      },
      required: ['intent'],
    },
  },
  {
    name: 'bclaw_coordinate',
    description: 'Multi-agent coordination facade: assign tasks to agents (with claims), consult agents (no claim), create a review candidate, reroute an active claim to another agent, or summarize a thread. Returns a FacadeResponse with selected_targets, delivery_plan, artifacts, and side_effects.',
    annotations: { tier: 'facade', category: 'coordination' , headlessApproval: 'auto' },
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
        open_loop: { type: 'boolean', description: 'For intent=review only: also open a review Loop on top of the candidate (author + reviewer slots, advance to `findings`, dispatch turns). Default false — existing review callers are unaffected. See docs/concepts/loop-engine.md §Automation.' },
        review_mode: { type: 'string', enum: ['asymmetric', 'symmetric'], description: 'Optional review Loop mode when open_loop=true. `asymmetric` (default) keeps the classical author→reviewer handoff; `symmetric` lets each reviewer turn also apply fixes directly, halving round-trips for spec/doc reviews. Ignored when open_loop is false.' },
        agent: { type: 'string', description: 'Caller agent name.' },
        agentId: { type: 'string', description: 'Caller registered agent id.' },
      },
      required: ['intent', 'task'],
    },
  },
  {
    name: 'bclaw_loop',
    description: 'Loop engine facade: open/turn/complete_turn/advance/add_artifact/pause/resume/close/get/list multi-turn work loops (review, ideation, implementation, research, debug). Returns a FacadeResponse with the loop thread, the newly-appended event, and a next_expected hint describing the natural next intent. Experimental — schema may evolve; gate production callers behind MCP versioning (pln#392).',
    annotations: { tier: 'facade', category: 'loops', headlessApproval: 'auto', experimental: true },
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['open', 'get', 'list', 'turn', 'complete_turn', 'advance', 'add_artifact', 'pause', 'resume', 'close'],
          description: 'Loop lifecycle intent. See docs/concepts/loop-engine.md for semantics.',
        },
        loop_id: { type: 'string', description: 'Target loop id (lop_…). Required for every intent except open and list.' },
        kind: { type: 'string', enum: ['review', 'ideation', 'implementation', 'research', 'debug'], description: 'Loop kind for open / list filter.' },
        title: { type: 'string', description: 'Human-readable title (open).' },
        goal: { type: 'string', description: 'Optional goal statement (open).' },
        phases: { type: 'array', items: { type: 'object' }, description: 'Optional phase list override (open). Each item is { name, advance_when? }.' },
        slots: { type: 'array', items: { type: 'object' }, description: 'Optional initial slot specs (open). Each item carries at least { role }.' },
        linked: { type: 'object', description: 'Optional top-level plan/sequence refs (open).' },
        stop_condition: { type: 'object', description: 'Optional stop_condition override (open). Composite any/all supported.' },
        mode: { type: 'string', enum: ['asymmetric', 'symmetric'], description: 'Review mode selector for open (review kind only).' },
        status: { type: 'string', description: 'Filter value for list, or target final_status for close.' },
        include_events: { type: 'boolean', description: 'get: include the event journal in the response.' },
        limit: { type: 'number', description: 'list: max loops returned.' },
        offset: { type: 'number', description: 'list: pagination offset.' },
        slot_id: { type: 'string', description: 'Slot id for turn / complete_turn.' },
        role: { type: 'string', description: 'Slot role for turn (resolves the first non-done slot with that role).' },
        input: { type: 'string', description: 'turn: free-form input passed to the slot.' },
        assignment_id: { type: 'string', description: 'turn: assignment id produced by the dispatcher to be recorded on the slot.' },
        dispatch: { type: 'boolean', description: 'turn: whether the caller has already dispatched the downstream work (recorded for auditability; no spawn happens here).' },
        outcome: { type: 'string', enum: ['done', 'failed', 'cancelled'], description: 'complete_turn outcome (default done).' },
        failure_reason: { type: 'string', description: 'complete_turn: optional failure/cancel reason.' },
        artifact: { type: 'object', description: 'complete_turn / add_artifact payload: { phase, type, body?, produced_by?, ref? }.' },
        to_phase: { type: 'string', description: 'advance: explicit target phase (otherwise the next phase).' },
        force: { type: 'boolean', description: 'advance: allow going backwards (increments iteration_count).' },
        reason: { type: 'string', description: 'advance / pause / close: optional reason string.' },
        expected_version: { type: 'number', description: 'Accepted for RFC compatibility on mutating intents, but not enforced until lock/CAS wiring lands.' },
        client_request_id: { type: 'string', description: 'Accepted for RFC compatibility on mutating intents, but not enforced until lock/idempotency wiring lands.' },
        agent: { type: 'string', description: 'Caller agent name.' },
        agentId: { type: 'string', description: 'Caller registered agent id (enforced for slot-bound auth in complete_turn).' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'bclaw_assignment_update',
    description: 'Report assignment lifecycle status. Part of the Agent SDK runtime protocol. Workers call this to report: accepted (acknowledging receipt), started (work begun), progress (heartbeat), completed (done with artifacts), failed (error), or blocked (external blocker). The assignment_id is provided in the dispatch brief.',
    annotations: { tier: 'standard', category: 'coordination', headlessApproval: 'auto' },
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
    annotations: { tier: 'standard', category: 'coordination' , headlessApproval: 'auto' },
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
  {
    name: 'bclaw_harvest_candidates',
    description: 'Harvest candidates from worktree inboxes into the main project store. Use this as the coordinator-side bridge for agents running under --sandbox workspace-write (e.g. Codex), which cannot write to the main store via MCP and instead write to their worktree .brainclaw/coordination/inbox/. Requires trusted trust level.',
    annotations: { tier: 'standard', category: 'coordination', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        worktreePaths: { type: 'array', items: { type: 'string' }, description: 'Explicit worktree paths to scan. Defaults to all active worktrees under ~/.brainclaw/worktrees/<project-hash>/.' },
        dryRun: { type: 'boolean', description: 'When true, report what would be harvested without writing anything.' },
        agent: { type: 'string', description: 'Coordinator agent name for runtime event attribution.' },
        agentId: { type: 'string', description: 'Registered agent id.' },
      },
      required: [],
    },
  },
  // ── Canonical CRUD verbs (Phase 3 / v1.0 grammar) ──────────────────
  // Promoted to `standard` tier at the v1.0 cut.
  {
    name: 'bclaw_find',
    description: 'Canonical list query over a brainclaw entity. Default read filter excludes records with provenance.kind="legacy" and auto_reflect records below 0.6 confidence — override via filter.includeLegacy / filter.minAutoReflectConfidence.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name: plan | decision | constraint | trap | handoff | runtime_note | candidate | claim | action | assignment | agent_run. Others not yet wired.' },
        filter: { type: 'object', description: 'Filter keys: status, tag, author, plan_id, limit, offset, includeLegacy (bool, default false), minAutoReflectConfidence (0-1, default 0.6).' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'bclaw_get',
    description: 'Fetch a single brainclaw entity by id or short_label.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'auto' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id (e.g. dec_ab12cd) or short_label (e.g. dec#42).' },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'bclaw_create',
    description: 'Create a new brainclaw entity. Data fields are entity-specific; see src/core/schema.ts.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        data: { type: 'object', description: 'Create payload (e.g. { text, author, tags }).' },
      },
      required: ['entity', 'data'],
    },
  },
  {
    name: 'bclaw_update',
    description: 'Partial update of mutable fields. Fields not in EntityRegistry.updatable are rejected — use bclaw_transition for status changes.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id.' },
        patch: { type: 'object', description: 'Fields to update (subset of EntityRegistry.updatable).' },
      },
      required: ['entity', 'id', 'patch'],
    },
  },
  {
    name: 'bclaw_remove',
    description: 'Remove a brainclaw entity. Archives by default; pass purge:true to hard-delete where supported.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id.' },
        purge: { type: 'boolean', description: 'Hard-delete instead of archive. Default false.' },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'bclaw_transition',
    description: 'Transition an entity to a new status. Validated against EntityRegistry.transitions. Returns the triggered side-effect tags.',
    annotations: { tier: 'standard', category: 'memory', headlessApproval: 'prompt' },
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name.' },
        id: { type: 'string', description: 'Entity id.' },
        to: { type: 'string', description: 'Target status.' },
        reason: { type: 'string', description: 'Optional free-text reason, audited alongside the transition.' },
      },
      required: ['entity', 'id', 'to'],
    },
  },
] as const;

/**
 * Combined catalog of every brainclaw MCP tool descriptor (read + write).
 * Exposed so tests can iterate inputSchemas (e.g. mcp-input-schema-strict.test.ts
 * runs ajv strict over each entry to prevent Copilot/Cursor-incompatible drift —
 * see trp#180 + pln#494).
 */
export const ALL_TOOLS = [...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS];

/**
 * Canonical list of all brainclaw MCP tool names, derived from ALL_TOOLS.
 * Source-of-truth consumed by agent integration writers (agent-files.ts)
 * to emit per-tool approval entries for each agent surface: Cline
 * `autoApprove`, Roo `alwaysAllow`, Codex `approval_mode`, etc. When a new
 * tool is registered in MCP_READ_TOOLS or MCP_WRITE_TOOLS it automatically
 * propagates here — no manual catalog sync required.
 */
export const MCP_TOOL_NAMES: string[] = ALL_TOOLS.map((tool) => tool.name);

/**
 * Subset of MCP_TOOL_NAMES for tools that are safe for headless auto-approval.
 * Excludes dispatch, architectural gates (accept/reject), plan creation, setup,
 * switch, bootstrap, memory deletes, and other operations that warrant human review.
 * Consumed by agent-files writers (Cline autoApprove, Roo alwaysAllow, Codex approval_mode).
 */
export const MCP_HEADLESS_AUTO_TOOL_NAMES: string[] = ALL_TOOLS
  .filter((tool) => (tool as { annotations?: { headlessApproval?: string } }).annotations?.headlessApproval === 'auto')
  .map((tool) => tool.name);

type McpToolTier = 'facade' | 'standard' | 'advanced';

/**
 * Tools removed from the MCP surface at the v1.0 cut (Phase 3 slice 3i).
 * Handlers remain in place defensively, but these names are hidden from
 * every `tools/list` response — including `catalog: "all"`. Callers
 * should migrate to the canonical grammar (see
 * `docs/mcp-schema-changelog.md` 1.0.0 block for the full replacement
 * map).
 */
export const REMOVED_IN_V1_TOOLS: ReadonlySet<string> = new Set([
  'bclaw_list_plans',
  'bclaw_list_candidates',
  'bclaw_list_claims',
  'bclaw_list_actions',
  'bclaw_list_assignments',
  'bclaw_list_runs',
  'bclaw_read_handoff',
  'bclaw_create_plan',
  'bclaw_update_plan',
  'bclaw_create_candidate',
  'bclaw_accept',
  'bclaw_reject',
  'bclaw_get_execution_context',
  'bclaw_get_agent_board',
  'bclaw_get_agent_board_summary',
  'bclaw_dispatch_analysis',
  'bclaw_dispatch_review',
  'bclaw_update_handoff',
  'bclaw_get_context',
]);

const LEGACY_READ_TOOL_HANDLERS = new Set<string>([
  'bclaw_get_context',
  'bclaw_get_execution_context',
  'bclaw_get_agent_board',
  'bclaw_get_agent_board_summary',
  'bclaw_list_plans',
  'bclaw_list_candidates',
  'bclaw_list_claims',
  'bclaw_list_actions',
  'bclaw_list_assignments',
  'bclaw_list_runs',
  'bclaw_read_handoff',
]);

/** All tools minus the v1.0 removal set. Used by every tools/list branch and governance guards. */
export const PUBLISHED_TOOLS = ALL_TOOLS.filter((tool) => !REMOVED_IN_V1_TOOLS.has(tool.name));

/**
 * Canonical facade order — drives what a fresh agent sees first in tools/list.
 *
 * Mental model for the default agent (doing its own work, not orchestrating):
 *   1. bclaw_work     — entry point: session + context + claim in one call.
 *   2. bclaw_context  — explicit memory read when bclaw_work isn't enough.
 *   3. bclaw_coordinate / bclaw_dispatch / bclaw_loop — ESCALATION path for
 *      agents that need to assign work, dispatch other agents, or drive
 *      multi-turn loops. Optional for most sessions.
 *   4. bclaw_setup    — one-time interactive onboarding.
 *
 * The typical working loop is: bclaw_work → canonical grammar
 * (bclaw_find/get/create/update/remove/transition) → bclaw_release_claim.
 * Coordination facades are not the default path.
 * (pln#397 + Codex audit P2, refined after user feedback on orchestration bias.)
 */
export const FACADE_ORDER = [
  'bclaw_work',
  'bclaw_context',
  'bclaw_coordinate',
  'bclaw_dispatch',
  'bclaw_loop',
  'bclaw_setup',
] as const;

function tierRank(tool: { annotations?: { tier?: string } }): number {
  const tier = tool.annotations?.tier;
  if (tier === 'facade') return 0;
  if (tier === 'standard') return 1;
  return 2; // advanced or missing
}

function facadePositionalRank(name: string): number {
  const idx = (FACADE_ORDER as readonly string[]).indexOf(name);
  return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
}

/**
 * Tools with tier facade or standard — returned by default. Advanced tools
 * require catalog=all. Sort rules (pln#397 Codex P2):
 *   1. tier: facade first, then standard.
 *   2. inside facades: FACADE_ORDER puts work/coordinate/context/dispatch/loop/setup
 *      at the head — the sequence a new agent should learn in.
 *   3. inside standards: original declaration order (stable-sort fallback via index).
 */
export const DEFAULT_PUBLISHED_TOOLS = PUBLISHED_TOOLS
  .filter((tool) => {
    const tier = (tool as { annotations?: { tier?: string } }).annotations?.tier;
    return tier === 'facade' || tier === 'standard';
  })
  .map((tool, index) => ({ tool, index }))
  .sort((a, b) => {
    const tierDiff = tierRank(a.tool) - tierRank(b.tool);
    if (tierDiff !== 0) return tierDiff;
    if (tierRank(a.tool) === 0) {
      const pos = facadePositionalRank(a.tool.name) - facadePositionalRank(b.tool.name);
      if (pos !== 0) return pos;
    }
    return a.index - b.index;
  })
  .map(({ tool }) => tool);

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
  // Facade-era primitives. Kept discoverable for callers that need the
  // granular tools alongside the facades; warning points at the facade
  // replacement when applicable.
  bclaw_session_start: 'Deprecated: use bclaw_work(intent: execute) which handles session start automatically.',
  bclaw_claim: 'Deprecated: use bclaw_work(intent: execute, scope: ...) which creates claims automatically.',
  bclaw_check_policy: 'Deprecated: policy checks are now implicit; use bclaw_work which surfaces them at claim time.',

  // Every tool replaced by the canonical grammar at v1.0 is now
  // listed in REMOVED_IN_V1_TOOLS and no longer returned by
  // tools/list. Direct `tools/call` by name still works as a
  // migration escape hatch — the warning wrapper surfaces below,
  // driven by the canonical-grammar redirect map.
};

/**
 * Redirects emitted when a direct `tools/call` hits a tool that was
 * removed from the catalog at v1.0. The warning points at the
 * canonical replacement.
 */
const REMOVED_TOOL_REDIRECTS: Record<string, string> = {
  bclaw_list_plans: 'Removed in v1.0: use bclaw_find(entity: "plan", filter).',
  bclaw_list_candidates: 'Removed in v1.0: use bclaw_find(entity: "candidate", filter).',
  bclaw_list_claims: 'Removed in v1.0: use bclaw_find(entity: "claim", filter).',
  bclaw_list_actions: 'Removed in v1.0: use bclaw_find(entity: "action", filter).',
  bclaw_list_assignments: 'Removed in v1.0: use bclaw_find(entity: "assignment", filter).',
  bclaw_list_runs: 'Removed in v1.0: use bclaw_find(entity: "agent_run", filter).',
  bclaw_read_handoff: 'Removed in v1.0: use bclaw_get(entity: "handoff", id).',
  bclaw_create_plan: 'Removed in v1.0: use bclaw_create(entity: "plan", data).',
  bclaw_update_plan: 'Removed in v1.0: use bclaw_update(entity: "plan", id, patch) for fields, bclaw_transition(entity: "plan", id, to) for status changes.',
  bclaw_create_candidate: 'Removed in v1.0: use bclaw_create(entity: "candidate", data).',
  bclaw_accept: 'Removed in v1.0: use bclaw_transition(entity: "candidate", id, to: "accepted").',
  bclaw_reject: 'Removed in v1.0: use bclaw_transition(entity: "candidate", id, to: "rejected").',
  bclaw_get_execution_context: 'Removed in v1.0: use bclaw_context(kind: "execution").',
  bclaw_get_agent_board: 'Removed in v1.0: use bclaw_context(kind: "board").',
  bclaw_get_agent_board_summary: 'Removed in v1.0: use bclaw_context(kind: "board_summary").',
  bclaw_dispatch_analysis: 'Removed in v1.0: use bclaw_dispatch(intent: "analysis").',
  bclaw_dispatch_review: 'Removed in v1.0: use bclaw_dispatch(intent: "review", openLoop, reviewMode).',
  bclaw_update_handoff: 'Removed in v1.0 (P6.1 tombstone): use bclaw_correct_handoff(originalId, ...).',
  bclaw_get_context: 'Removed in v1.0: use bclaw_context(kind: "memory") or bclaw_work(intent: consult).',
};

// Inject removed-tool warnings into the legacy warning map so the
// executeMcpToolCall exit wrapper surfaces them on direct calls.
for (const [name, msg] of Object.entries(REMOVED_TOOL_REDIRECTS)) {
  LEGACY_MCP_TOOL_WARNINGS[name] = msg;
}

function isLegacyMcpToolFacadeDisabled(name: string): boolean {
  return process.env.BRAINCLAW_FACADE_ONLY === '1' && Object.hasOwn(LEGACY_MCP_TOOL_WARNINGS, name);
}

function createLegacyMcpToolDisabledResponse(): McpToolResponse {
  return createToolErrorResponse('disabled', 'This tool is disabled. Use bclaw_work or bclaw_coordinate instead.');
}

function createLegacyToolExecutionErrorResponse(error: unknown): McpToolResponse {
  if (error instanceof AgentIdentityResolutionError) {
    return createToolErrorResponse(error.kind, error.message, error.details);
  }
  if (error instanceof AgentTrustError) {
    return createToolErrorResponse(error.kind, error.message, error.details);
  }
  return createToolErrorResponse('validation_error', error instanceof Error ? error.message : String(error));
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

/**
 * Resolve the agent identity for canonical-grammar mutation verbs
 * (bclaw_create/update/remove/transition). Returns a best-effort identity so
 * that handlers can auto-fill required fields (e.g. plan.author) instead of
 * letting the create land on disk with a missing field — which would then be
 * silently GC'd by the state sync loop (see fix plan pln_5f44426c).
 *
 * Falls back to args.agent if resolution fails, and finally to 'unknown'.
 */
function resolveCanonicalAuthor(
  args: Record<string, unknown>,
  cwd?: string,
  connectionSessionId?: string,
): { agent_name: string; agent_id?: string } {
  const resolved = resolveMutationIdentity(
    args,
    { nameField: 'agent', idField: 'agentId' },
    cwd,
    connectionSessionId,
  );
  if ('identity' in resolved && resolved.identity) {
    return {
      agent_name: resolved.identity.agent_name,
      agent_id: resolved.identity.agent_id,
    };
  }
  const explicit = typeof args.agent === 'string' ? args.agent : undefined;
  return { agent_name: explicit ?? 'unknown' };
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
            tools = PUBLISHED_TOOLS;
          } else if (tier) {
            tools = PUBLISHED_TOOLS.filter((t) => (t as { annotations?: { tier?: string } }).annotations?.tier === tier);
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

  const missingWorkerPath = resolveMcpWorkerEntryPath();
  if (!fs.existsSync(missingWorkerPath)) {
    console.error(
      `Warning: MCP runtime corrupted (mcp-worker.js missing). Read-only handlers remain available in-process; ` +
      `handlers requiring the worker are disabled until you run "${MCP_RUNTIME_REPAIR_COMMAND}". Missing path: ${missingWorkerPath}`,
    );
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
    executeTool: createWorkerToolExecutor(),
  });

  transport.onMessage = (line: string) => connection.handleLine(line);
  transport.start();
}

function createWorkerToolExecutor(): McpToolExecutor {
  const missingWorkerPath = resolveMcpWorkerEntryPath();
  return (payload, signal) => new Promise<McpToolExecutionOutcome>((resolve, reject) => {
    if (!fs.existsSync(missingWorkerPath)) {
      void resolveMissingWorkerExecution(payload, signal, missingWorkerPath).then(resolve, reject);
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL('./mcp-worker.js', import.meta.url), {
        workerData: payload,
      });
    } catch (error: unknown) {
      if (isMissingWorkerFailure(error, missingWorkerPath)) {
        void resolveMissingWorkerExecution(payload, signal, missingWorkerPath).then(resolve, reject);
        return;
      }
      reject(error);
      return;
    }
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
      if (isMissingWorkerFailure(error, missingWorkerPath)) {
        settle(() => {
          void resolveMissingWorkerExecution(payload, signal, missingWorkerPath).then(resolve, reject);
        });
        return;
      }
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

function resolveMcpWorkerEntryPath(): string {
  return fileURLToPath(new URL('./mcp-worker.js', import.meta.url));
}

function isReadOnlyInProcessTool(name: string): boolean {
  return MCP_READ_TOOLS.some((tool) => tool.name === name) || LEGACY_READ_TOOL_HANDLERS.has(name);
}

function createMissingWorkerToolErrorResponse(handlerName: string, missingPath: string): McpToolResponse {
  return createToolErrorResponse(
    'runtime_corrupted',
    `MCP runtime corrupted (mcp-worker.js missing) — run "${MCP_RUNTIME_REPAIR_COMMAND}" to rebuild dist/. Handler: ${handlerName}. Missing path: ${missingPath}.`,
    {
      'handler-name': handlerName,
      'missing-path': missingPath,
      'repair-command': MCP_RUNTIME_REPAIR_COMMAND,
      handler_name: handlerName,
      missing_path: missingPath,
      repair_command: MCP_RUNTIME_REPAIR_COMMAND,
    },
  );
}

function normalizeMissingModuleSpecifier(specifier: string): string {
  const trimmed = specifier.trim();
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed).replace(/\\/g, '/').toLowerCase();
    } catch {
      // Fall through to string normalization.
    }
  }
  return trimmed.replace(/\\/g, '/').toLowerCase();
}

function extractMissingModuleSpecifiers(message: string): string[] {
  const specifiers: string[] = [];
  const quotedPattern = /Cannot find (?:module|package)\s+['"]([^'"]+)['"]/g;
  for (const match of message.matchAll(quotedPattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

export function isMissingWorkerFailure(error: unknown, missingPath: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown } | undefined)?.code === 'string'
    ? (error as { code: string }).code
    : undefined;

  if (code && code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') {
    return false;
  }

  const normalizedMissingPath = normalizeMissingModuleSpecifier(missingPath);
  const missingBasename = path.posix.basename(normalizedMissingPath);

  return extractMissingModuleSpecifiers(message).some((specifier) => {
    const normalizedSpecifier = normalizeMissingModuleSpecifier(specifier);
    return normalizedSpecifier === normalizedMissingPath
      || normalizedSpecifier === missingBasename
      || normalizedSpecifier.endsWith(`/${missingBasename}`);
  });
}

async function resolveMissingWorkerExecution(
  payload: McpToolExecutionPayload,
  signal: AbortSignal,
  missingPath: string,
): Promise<McpToolExecutionOutcome> {
  if (signal.aborted) {
    throw new Error('Task cancelled');
  }

  if (isReadOnlyInProcessTool(payload.name)) {
    return executeMcpToolCall(payload);
  }

  return {
    response: createMissingWorkerToolErrorResponse(payload.name, missingPath),
  };
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


async function _executeMcpToolCallInner(payload: McpToolExecutionPayload): Promise<McpToolExecutionOutcome> {
  const { name, args, cwd, connectionSessionId } = payload;

  try {
    if (isLegacyMcpToolFacadeDisabled(name)) {
      return { response: createLegacyMcpToolDisabledResponse() };
    }

    // Async read: bclaw_check_security (requires network call to Socket MCP)
    if (name === 'bclaw_check_security') {
      const { handleCheckSecurity } = await import('./check-security-mcp.js');
      return { response: toolResponse(await handleCheckSecurity(args, cwd)) };
    }

    if (MCP_READ_TOOLS.some((tool) => tool.name === name) || LEGACY_READ_TOOL_HANDLERS.has(name)) {
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

      try {
        const created = createPlan({
          text: planText,
          author: resolved.identity!.agent_name,
          type: args.type as PlanType | undefined,
          priority: args.priority as Priority | undefined,
          assignee: args.assignee as string | undefined,
          project: args.project as string | undefined,
          tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
          relatedPaths: Array.isArray(args.related_paths) ? args.related_paths as string[] : undefined,
          dependsOn: Array.isArray(args.depends_on) ? args.depends_on as string[] : undefined,
          estimatedEffort: typeof args.estimate === 'number'
            ? args.estimate
            : typeof args.estimated_effort === 'number'
              ? args.estimated_effort
              : undefined,
        }, cwd);
        appendAuditEntry({
          actor: resolved.identity!.agent_name,
          actor_id: resolved.identity!.agent_id,
          action: 'create',
          item_id: created.id,
          item_type: 'plan',
        }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Plan added: [${created.shortLabel}] ${created.text}` }],
            plan_id: created.id,
            short_label: created.shortLabel,
            text: created.text,
          }),
        };
      } catch (error: unknown) {
        return { response: createLegacyToolExecutionErrorResponse(error) };
      }
    }

    if (name === 'bclaw_create_candidate') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }

      const candidateText = String(args.text ?? '').trim();
      if (!candidateText) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
      }

      const candidateType = String(args.type ?? '').trim();
      if (!['constraint', 'decision', 'trap', 'handoff'].includes(candidateType)) {
        return { response: createToolErrorResponse('validation_error', 'type must be one of: constraint, decision, trap, handoff') };
      }

      try {
        const created = createEntity('candidate', {
          text: candidateText,
          type: candidateType,
          author: resolved.identity!.agent_name,
          tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
          source: 'agent',
          ...(typeof args.origin === 'string' ? { origin: String(args.origin) } : {}),
          ...(typeof args.severity === 'string' ? { severity: String(args.severity) } : {}),
          ...(typeof args.from === 'string' ? { from: String(args.from) } : {}),
          ...(typeof args.to === 'string' ? { to: String(args.to) } : {}),
          ...(typeof args.narrative === 'string' ? { narrative: String(args.narrative) } : {}),
          ...(Array.isArray(args.related_paths) ? { related_paths: args.related_paths as string[] } : {}),
          ...(typeof args.plan_id === 'string' ? { plan_id: String(args.plan_id) } : {}),
        }, cwd);
        appendAuditEntry({
          actor: resolved.identity!.agent_name,
          actor_id: resolved.identity!.agent_id,
          action: 'create',
          item_id: created.id,
          item_type: 'candidate',
        }, cwd);

        const targetProjectArg = getCrossProjectArg(args, 'targetProject', 'target_project');
        if (targetProjectArg) {
          const signal = writeCrossProjectSignal(
            resolveCrossProjectWritableTarget(targetProjectArg, 'candidate', cwd),
            'candidate',
            loadCandidate(created.id, cwd),
            cwd,
          );
          return {
            response: toolResponse({
              content: [{ type: 'text', text: `✔ Candidate created [${created.id}] and signaled to '${signal.target_project.name}' [${signal.id}]` }],
              candidate_id: created.id,
              short_label: created.short_label,
              signal_id: signal.id,
              entity_type: signal.entity_type,
              target_project: signal.target_project.name,
              target_path: signal.target_project.path,
            }),
          };
        }

        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Candidate created [${created.id}]` }],
            candidate_id: created.id,
            short_label: created.short_label,
          }),
        };
      } catch (error: unknown) {
        return { response: createLegacyToolExecutionErrorResponse(error) };
      }
    }

    if (name === 'bclaw_accept') {
      const resolved = ensureTrust(args, { nameField: 'by', idField: 'byId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      try {
        const id = String(args.id ?? '').trim();
        if (!id) {
          return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
        }
        const result = acceptCandidate(id, resolved.identity!.agent_name, cwd, resolved.identity!.agent_id);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Promoted to ${result.candidate_type} [${result.promoted_item_id}]` }],
            candidate_id: result.candidate_id,
            candidate_type: result.candidate_type,
            promoted_item_id: result.promoted_item_id,
            actor: result.actor,
          }),
        };
      } catch (error: unknown) {
        return { response: createLegacyToolExecutionErrorResponse(error) };
      }
    }

    if (name === 'bclaw_reject') {
      const resolved = ensureTrust(args, { nameField: 'by', idField: 'byId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      try {
        const id = String(args.id ?? '').trim();
        if (!id) {
          return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
        }
        const result = rejectCandidate(
          id,
          typeof args.reason === 'string' ? args.reason : undefined,
          resolved.identity!.agent_name,
          cwd,
          resolved.identity!.agent_id,
        );
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Candidate rejected [${result.candidate_id}]` }],
            candidate_id: result.candidate_id,
            actor: result.actor,
          }),
        };
      } catch (error: unknown) {
        return { response: createLegacyToolExecutionErrorResponse(error) };
      }
    }

    if (name === 'bclaw_claim') {
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
      try {
        loadClaim(claimId, cwd); // validate existence before delegating
      } catch {
        return { response: createToolErrorResponse('not_found', `Claim not found: ${claimId}`) };
      }
      const cascadeResult = releaseClaimWithCascade(claimId, {
        planStatus: args.planStatus as string | undefined,
        cwd,
      });
      const { planTransitioned, planWarning, planId: cascadePlanId, newPlanStatus: cascadeNewStatus } = cascadeResult;
      const summaryText = [
        `✔ Released claim [${claimId}]`,
        planTransitioned ? ` — plan ${cascadePlanId} → ${cascadeNewStatus}` : '',
        planWarning ? ` ⚠ ${planWarning}` : '',
      ].join('');
      return {
        response: toolResponse({
          content: [{ type: 'text', text: summaryText }],
          claim_id: claimId,
          ...(planTransitioned ? { plan_id: cascadePlanId, plan_status: cascadeNewStatus } : {}),
          ...(planWarning ? { plan_warning: planWarning, plan_id: cascadePlanId } : {}),
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

    if (name === 'bclaw_dispatch' && (args.intent === 'analysis' || args.intent === 'review')) {
      // Phase 3 slice 3d — intent dispatch. Routes analysis/review to the
      // equivalent legacy tool handler, preserving the execute path below.
      // See docs/concepts/mcp-governance.md.
      const dispatchIntent = args.intent as string;
      if (dispatchIntent === 'analysis') {
        try {
          return { response: toolResponse(handleMcpReadToolCall('bclaw_dispatch_analysis', args, { cwd })) };
        } catch (err: unknown) {
          return { response: createToolErrorResponse('operation_error', (err as Error).message) };
        }
      }
      // dispatchIntent === 'review' — delegate via dispatchReview directly.
      const resolvedReview = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolvedReview.error) {
        return { response: createToolErrorResponse(resolvedReview.error.kind, resolvedReview.error.message, resolvedReview.error.details) };
      }
      try {
        const result = dispatchReview({
          handoffId: args.handoffId as string | undefined,
          reviewer: args.reviewer as string | undefined,
          dryRun: args.dryRun as boolean | undefined,
          openLoop: args.openLoop as boolean | undefined,
          reviewMode: args.reviewMode as 'asymmetric' | 'symmetric' | undefined,
          dispatcherAgent: resolvedReview.identity!.agent_name,
          dispatcherAgentId: resolvedReview.identity!.agent_id,
          sessionId: connectionSessionId,
        }, cwd);
        const text = args.dryRun
          ? `🔍 Review dispatch dry run: ${result.reviews_sent.length} target(s).`
          : `✔ Review dispatch complete: ${result.reviews_sent.length} target(s).`;
        return {
          response: toolResponse({
            content: [{ type: 'text', text }],
            ...result,
          }),
        };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', (err as Error).message) };
      }
    }
    if (name === 'bclaw_dispatch' && args.intent !== undefined && args.intent !== 'execute') {
      return { response: createToolErrorResponse('validation_error', `bclaw_dispatch: unknown intent '${args.intent}'. Expected analysis | execute | review.`) };
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

    if (name === 'bclaw_update_step') {
      const crossProjectError = blockCrossProjectExecution('plan', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const usPlanId = String(args.planId ?? '').trim();
      const usStepId = String(args.stepId ?? '').trim();
      if (!usPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!usStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
      const validStatuses = ['todo', 'in_progress', 'testing', 'done', 'blocked'];
      if (args.status && !validStatuses.includes(String(args.status))) {
        return { response: createToolErrorResponse('validation_error', `Invalid status: ${args.status}. Valid: ${validStatuses.join(', ')}`) };
      }
      try {
        const result = updateStepOp({
          planId: usPlanId,
          stepId: usStepId,
          status: args.status as PlanStepStatus | undefined,
          text: args.text as string | undefined,
          assignee: args.assignee as string | undefined,
        }, cwd);
        const changes: string[] = [];
        if (args.status) changes.push(`status=${args.status}`);
        if (args.text) changes.push('text updated');
        if (args.assignee !== undefined) changes.push(`assignee=${args.assignee || 'unassigned'}`);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Step updated: [${result.stepId}] ${changes.join(', ')} (${result.doneSteps}/${result.totalSteps} done)` }],
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

    if (name === 'bclaw_delete_step') {
      const crossProjectError = blockCrossProjectExecution('plan', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const dsPlanId = String(args.planId ?? '').trim();
      const dsStepId = String(args.stepId ?? '').trim();
      if (!dsPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!dsStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
      try {
        const result = deleteStepOp({ planId: dsPlanId, stepId: dsStepId }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Step deleted: [${result.stepId}] (${result.doneSteps}/${result.totalSteps} remaining)` }],
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

    if (name === 'bclaw_delete_plan') {
      const crossProjectError = blockCrossProjectExecution('plan', args);
      if (crossProjectError) {
        return { response: crossProjectError };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const dpId = String(args.id ?? '').trim();
      if (!dpId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      try {
        const result = deletePlanOp(dpId, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Plan deleted: [${result.id}] ${result.text.slice(0, 80)}` }],
            plan_id: result.id,
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

    if (name === 'bclaw_delete_sequence') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const dsqId = String(args.id ?? '').trim();
      if (!dsqId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      try {
        const result = deleteSequence(dsqId, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Sequence deleted: [${result.id}] ${result.name}` }],
            sequence_id: result.id,
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

    if (name === 'bclaw_correct_handoff') {
      // Phase 3 slice 3e — P6.1 tombstone correction. Writes a new
      // handoff that supersedes the original. Both records stay on
      // disk (federation-safe); the original becomes pinned via
      // `superseded_by`.
      const originalId = String(args.originalId ?? '').trim();
      if (!originalId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: originalId') };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const resolvedIdentity = resolved.identity!;
      const state = loadState(cwd);
      const original = state.open_handoffs.find((h) => h.id === originalId);
      if (!original) {
        return { response: createToolErrorResponse('not_found', `Handoff not found: ${originalId}`) };
      }
      if (original.superseded_by) {
        return { response: createToolErrorResponse('validation_error', `Handoff ${originalId} was already superseded by ${original.superseded_by}. Correct the current tip instead.`) };
      }
      // Phase 3 slice 3e fixup (Sonnet review #3): refuse to supersede a
      // handoff in a terminal status per EntityRegistry. A closed handoff
      // is immutable history — corrections would logically dangle.
      if (original.status && ENTITY_REGISTRY.handoff.terminal.includes(original.status)) {
        return { response: createToolErrorResponse('validation_error', `Handoff ${originalId} is in terminal status '${original.status}'. Cannot supersede a closed handoff.`) };
      }
      const { id: newId, short_label } = generateIdWithLabel('open_handoffs', cwd);
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : undefined;
      const overrideText = typeof args.text === 'string' && args.text ? args.text : undefined;
      const correctionText = overrideText
        ?? `${original.text}\n\n---\n[correction] ${reason ?? 'superseded by later record'}`;
      const overrideNarrative = typeof args.narrative === 'string' && args.narrative ? args.narrative : original.narrative;
      const tags = Array.isArray(args.tags) ? (args.tags as string[]) : original.tags;
      const correction = {
        ...original,
        id: newId,
        short_label,
        text: correctionText,
        narrative: overrideNarrative,
        tags,
        created_at: nowISO(),
        author: resolvedIdentity.agent_name,
        author_id: resolvedIdentity.agent_id,
        session_id: connectionSessionId,
        review: undefined,
        supersedes: originalId,
      };
      delete (correction as Record<string, unknown>).superseded_by;
      original.superseded_by = newId;
      state.open_handoffs.push(correction as typeof original);
      persistState(state, cwd);
      appendAuditEntry({
        actor: resolvedIdentity.agent_name,
        actor_id: resolvedIdentity.agent_id,
        action: 'create',
        item_id: newId,
        item_type: 'handoff',
        scope: `supersedes:${originalId}`,
      }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ correction handoff [${short_label ?? newId}] supersedes ${originalId}` }],
          id: newId,
          short_label,
          supersedes: originalId,
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
      const useCompact = workReq.compact !== false; // default true
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

      // Step 2: build context for requested scope. When intent='resume',
      // auto-surface the memory delta since the previous session for the
      // same agent — matches session-start.ts:85 pattern. Phase 4
      // Sprint 1 Lane A step 5 (pln#390). Without this the resume intent
      // was functionally identical to consult, defeating its purpose.
      let contextResult: ReturnType<typeof buildContext> | undefined;
      try {
        let sinceSession: string | undefined;
        if (workReq.intent === 'resume') {
          const previousSession = loadAllSessions(cwd)
            .find((s) => s.agent === sessionResult.agent && s.session_id !== sessionResult.session_id);
          sinceSession = previousSession?.session_id;
        }
        contextResult = buildContext({
          target: workReq.contextTarget ?? workReq.scope,
          agent: sessionResult.agent,
          cwd,
          sinceSession,
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

      // Build the full context result, then compact it if requested.
      // Compact mode (default) strips the heavy ContextResult down to a
      // minimal summary that fits within MCP token limits (~25k chars).
      // The full payload remains available via bclaw_context(kind='memory').
      let resultPayload: unknown = contextResult ?? null;
      if (useCompact && contextResult) {
        const planItems = contextResult.selected
          .filter((item: { section: string }) => item.section === 'plan')
          .slice(0, 5)
          .map((item: { id: string; text: string; extra?: string; plan_id?: string }) => ({
            id: item.id,
            short_label: item.text.slice(0, 120),
            status: item.extra ?? 'unknown',
            plan_id: item.plan_id,
          }));

        const staleTop3 = (contextResult.stale_warnings ?? []).slice(0, 3).map(
          (w: { id: string; entity: string; text: string; age_days: number }) => ({
            id: w.id,
            entity: w.entity,
            text: w.text.slice(0, 80),
            age_days: w.age_days,
          }),
        );

        resultPayload = {
          context_schema: contextResult.context_schema,
          profile: contextResult.profile,
          memory_version: contextResult.memory_version,
          memory_density: contextResult.memory_density,
          plan_summary: planItems,
          stale_warnings: staleTop3,
          workflow_hints: (contextResult.workflow_hints ?? []).slice(0, 3),
          claim_conflicts: contextResult.claim_conflicts ?? [],
          open_work: contextResult.open_work ?? null,
          _compact: true,
          _full_context_hint: 'Use bclaw_context(kind="memory") for the full payload.',
        };
      }

      const facadeResponse: FacadeResponse = {
        status: 'ok',
        intent: workReq.intent,
        result: resultPayload,
        artifacts: [],
        side_effects: claimId ? [{ action: claimStatus === 'created' ? 'create' : 'reuse', entity: 'claim', id: claimId }] : [],
        claim_status: claimStatus,
        session_id: sessionResult.session_id,
        warnings,
        duration_ms: Date.now() - startMs,
      };

      const summaryParts: string[] = [`✔ bclaw_work [${workReq.intent}] session=${sessionResult.session_id}`];
      if (claimId) summaryParts.push(`claim=${claimId} (${claimStatus})`);
      if (useCompact) summaryParts.push('mode=compact (use bclaw_context for full payload)');
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
            assignmentId: entry.assignment_id,
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
            if (execResult.failure_kind === 'spawn_no_handshake') {
              try {
                const run = createAgentRun({
                  assignment_id: entry.assignment_id,
                  claim_id: entry.claim_id,
                  message_id: entry.message_id,
                  agent: entry.agent,
                  transport: 'cli_spawn',
                  status: 'launching',
                  scope: worktreePath ?? entry.scope ?? entry.ref ?? entry.assignment_id,
                  description: `Coordinate execution attempt for ${entry.scope ?? entry.ref ?? entry.assignment_id}`,
                  worktree_path: worktreePath,
                  command: execResult.command,
                  shell: execResult.shell,
                  pid: execResult.pid,
                  status_reason: 'CLI spawn launched by coordinator',
                  tags: ['coordinate-run', `message:${entry.message_type}`],
                }, opts.cwd);
                transitionAgentRun(run.id, 'failed', {
                  actor: opts.senderAgent,
                  actor_id: opts.senderAgentId,
                  pid: execResult.pid,
                  status_reason: execResult.error,
                  error_message: execResult.error,
                }, opts.cwd);
              } catch (runErr) {
                opts.warnings.push(`AgentRun creation failed for ${entry.assignment_id}: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
              }

              try {
                transitionAssignment(entry.assignment_id, 'failed', {
                  actor: opts.senderAgent,
                  actor_id: opts.senderAgentId,
                  error_message: execResult.error,
                  status_reason: execResult.error,
                  syncAgentRun: false,
                }, opts.cwd);
              } catch (assignmentErr) {
                opts.warnings.push(`Assignment failure transition failed for ${entry.assignment_id}: ${assignmentErr instanceof Error ? assignmentErr.message : String(assignmentErr)}`);
              }
              continue;
            }

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
        message_type: 'assign' | 'rfc' | 'review';
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
        messageType: 'assign' | 'rfc' | 'review';
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
      let facadeStatus: FacadeResponse['status'] = 'ok';

      if (req.intent === 'assign') {
        const delivery_plan: CoordinateDeliveryEntry[] = [];
        for (const agentName of resolvedAgents) {
          // trp#51: dispatch-time validation rejects unknown profiles,
          // non-spawnable agents, and missing invoke_binary. Caller gets a
          // specific error code instead of a silent skip, so automated
          // retry loops can react (e.g. fall back to a different agent).
          const check = validateAgentForDispatch(agentName, { requireSpawnable: true });
          if (!check.valid) {
            warnings.push(JSON.stringify({
              warning: 'agent_validation_failed',
              agent: agentName,
              code: check.code,
              reason: check.reason,
            }));
            continue;
          }
          const profile = check.profile!;
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
        // Cap the implicit fan-out so that omitting `targetAgents` on an
        // open_loop review doesn't mint a loop with a reviewer slot per
        // spawnable agent. The cap only applies to the implicit case —
        // callers who explicitly list targetAgents get the full list.
        const REVIEW_OPEN_LOOP_FANOUT_CAP = 3;
        const implicitFanout = !(req.targetAgents && req.targetAgents.length > 0);
        let loopReviewerAgents = resolvedAgents;
        const preReviewWarnings: string[] = [];
        if (req.open_loop === true && implicitFanout && resolvedAgents.length > REVIEW_OPEN_LOOP_FANOUT_CAP) {
          loopReviewerAgents = resolvedAgents.slice(0, REVIEW_OPEN_LOOP_FANOUT_CAP);
          preReviewWarnings.push(
            `open_loop: implicit reviewer fan-out capped at ${REVIEW_OPEN_LOOP_FANOUT_CAP} of ${resolvedAgents.length} spawnable agents; pass targetAgents to override`,
          );
        }

        type ReviewOutput = {
          candidateId: string;
          loopId?: string;
          artifacts: Array<{ type: string; id: string; path?: string }>;
          sideEffects: Array<{ action: string; entity: string; id: string }>;
          warnings: string[];
          partial: boolean;
          // pln#458 stp_daffa477: invokes prepared under the lock but spawned
          // outside it so runCoordinateExecution (async) doesn't block the
          // idempotency window.
          preparedReviews: PreparedInvoke[];
        };

        // Lazy-import the loops module once before defining performReview so
        // the synchronous withLoopLock work callback can use it without
        // re-importing inside the callback.
        const loopsModuleRef = await import('../core/loops/index.js');

        const performReview = (): ReviewOutput => {
          const out: ReviewOutput = {
            candidateId: '',
            artifacts: [],
            sideEffects: [],
            warnings: [...preReviewWarnings],
            partial: false,
            preparedReviews: [],
          };

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
          out.candidateId = candId.id;
          out.artifacts.push({ type: 'candidate', id: candId.id });
          out.sideEffects.push({ action: 'create', entity: 'candidate', id: candId.id });

          if (req.open_loop === true && loopReviewerAgents.length === 0) {
            out.warnings.push('open_loop: no reviewer targets resolved; skipped loop creation — candidate preserved');
            return out;
          }
          if (req.open_loop !== true) {
            return out;
          }

          try {
            const { openLoop, add_artifact, advance, turn } = loopsModuleRef;
            const senderIdentity = (
              (senderAgentId ? findAgentIdentityById(senderAgentId, cwd) : undefined)
              ?? findAgentIdentityByName(senderAgent, cwd)
              ?? ensureAgentRegisteredForDispatch(senderAgent, cwd)
            );
            const authorAgentId = senderIdentity?.agent_id ?? senderAgentId;
            const creatorActor = authorAgentId ?? senderAgent;
            const slots = [
              {
                role: 'author',
                agent: senderAgent,
                ...(authorAgentId ? { agent_id: authorAgentId } : {}),
              },
              ...loopReviewerAgents.map((agent) => {
                const reviewerIdentity = findAgentIdentityByName(agent, cwd) ?? ensureAgentRegisteredForDispatch(agent, cwd);
                return {
                  role: 'reviewer',
                  agent,
                  ...(reviewerIdentity?.agent_id ? { agent_id: reviewerIdentity.agent_id } : {}),
                };
              }),
            ];
            const loop = openLoop(
              {
                kind: 'review',
                title: req.task.slice(0, 120),
                created_by: creatorActor,
                slots,
                mode: req.review_mode ?? 'asymmetric',
              },
              cwd,
            );
            out.loopId = loop.id;
            out.artifacts.push({ type: 'loop', id: loop.id });
            out.sideEffects.push({ action: 'create', entity: 'loop', id: loop.id });

            add_artifact(
              {
                id: loop.id,
                actor: creatorActor,
                artifact: {
                  phase: 'change_summary',
                  type: 'change_summary',
                  ref: { kind: 'candidate', id: candId.id },
                },
              },
              cwd,
            );

            const advanced = advance(
              { id: loop.id, actor: creatorActor },
              cwd,
            );
            const reviewerSlots = advanced.loop.slots.filter((s) => s.role === 'reviewer');
            for (const slot of reviewerSlots) {
              turn(
                {
                  id: loop.id,
                  slot_id: slot.slot_id,
                  actor: creatorActor,
                  input: req.task,
                },
                cwd,
              );

              // pln#458 stp_daffa477: turn() is pure state mutation — it does
              // NOT spawn the reviewer. Without the linkage below, the loop
              // stays "assigned" forever and no work ever runs (symptom
              // observed on lop_0a0cb84a7bf8dd92). Build the same claim +
              // assignment + queued message chain as intent=assign so that
              // the downstream runCoordinateExecution actually spawns.
              try {
                const reviewScope = `review-loop:${loop.id}`;
                const reviewDescription =
                  `Review loop turn for ${loop.id} slot ${slot.slot_id} phase findings. `
                  + `Mode: ${advanced.loop.protocol?.review_mode ?? 'asymmetric'}. ${req.task}`;
                const claimResult = createCoordinatorClaim({
                  agent: slot.agent ?? '',
                  scope: reviewScope,
                  description: reviewDescription,
                  dispatcherAgent: senderAgent,
                  sessionId: connectionSessionId,
                  cwd,
                });
                if (claimResult.worktreeWarning) out.warnings.push(claimResult.worktreeWarning);
                out.artifacts.push({ type: 'claim', id: claimResult.claimId });
                out.sideEffects.push({
                  action: claimResult.reusedExisting ? 'reuse' : 'create',
                  entity: 'claim',
                  id: claimResult.claimId,
                });

                let reviewAssignmentId: string | undefined;
                try {
                  const preId = generateAssignmentId(cwd);
                  const assignment = createAssignment({
                    id: preId.id,
                    short_label: preId.short_label,
                    claim_id: claimResult.claimId,
                    agent: slot.agent ?? '',
                    dispatcher_agent: senderAgent,
                    dispatcher_session_id: connectionSessionId,
                    scope: reviewScope,
                    description: reviewDescription,
                    tags: ['coordinate', 'review', 'loop'],
                  }, cwd);
                  reviewAssignmentId = assignment.id;
                  out.artifacts.push({ type: 'assignment', id: assignment.id });
                } catch (asgErr) {
                  out.warnings.push(
                    `Review assignment creation failed for slot ${slot.slot_id}: ${asgErr instanceof Error ? asgErr.message : String(asgErr)}`,
                  );
                }

                const reviewBrief = buildCoordinateBrief(slot.agent ?? '', reviewDescription, {
                  claimId: claimResult.claimId,
                  scope: reviewScope,
                  worktreePath: claimResult.worktreePath,
                  assignmentId: reviewAssignmentId,
                });
                const queued = queueCoordinateMessage({
                  agent: slot.agent ?? '',
                  text: reviewBrief,
                  messageType: 'review',
                  ref: loop.id,
                  scope: reviewScope,
                  requiresAck: true,
                  claimId: claimResult.claimId,
                  assignmentId: reviewAssignmentId,
                  tags: ['coordinate', 'review', 'loop'],
                  payload: {
                    intent: 'review',
                    loop_id: loop.id,
                    slot_id: slot.slot_id,
                    phase: 'findings',
                    scope: reviewScope,
                    claim_id: claimResult.claimId,
                    ...(reviewAssignmentId ? { assignment_id: reviewAssignmentId } : {}),
                    worktree_path: claimResult.worktreePath,
                  },
                  commandMode: 'worker',
                });

                if (reviewAssignmentId) {
                  try {
                    attachAssignmentMessageToClaim(claimResult.claimId, queued.entry.message_id, cwd);
                    linkClaimToAssignment(claimResult.claimId, reviewAssignmentId, cwd);
                    transitionAssignment(reviewAssignmentId, 'offered', { actor: senderAgent }, cwd);
                    patchAssignmentMessageId(reviewAssignmentId, queued.entry.message_id, cwd);
                    queued.entry.assignment_id = reviewAssignmentId;
                  } catch (linkErr) {
                    out.warnings.push(
                      `Review assignment linkage failed for ${reviewAssignmentId}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`,
                    );
                  }
                }

                out.preparedReviews.push({
                  entry: queued.entry,
                  invoke: queued.invoke,
                  worktreePath: claimResult.worktreePath,
                });
              } catch (dispatchErr) {
                out.partial = true;
                out.warnings.push(
                  `open_loop: reviewer dispatch linkage failed for slot ${slot.slot_id} (${dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)}); loop remains open without spawn`,
                );
              }
            }
          } catch (loopErr: unknown) {
            out.partial = true;
            const loopErrMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
            out.warnings.push(`open_loop: failed to open review loop (${loopErrMsg}); candidate ${out.candidateId} still created`);
          }
          return out;
        };

        const useIdempotency = Boolean(req.client_request_id && senderAgentId && req.open_loop === true);
        let output: ReviewOutput;
        try {
          if (useIdempotency) {
            const { client_request_id: _crid, ...hashablePayload } = req;
            output = loopsModuleRef.withLoopLock<ReviewOutput>({
              cwd,
              intent: 'coordinate_review',
              agentId: senderAgentId!,
              scope: { kind: 'open_idempotency', clientRequestId: req.client_request_id! },
              clientRequestId: req.client_request_id!,
              requestPayload: hashablePayload,
              work: () => performReview(),
            });
          } else {
            output = performReview();
          }
        } catch (err: unknown) {
          if (err instanceof loopsModuleRef.IdempotencyKeyReusedError) {
            return {
              response: createToolErrorResponse(
                'idempotency_key_reused_with_different_body',
                err.message,
                { stored_hash: err.storedHash, submitted_hash: err.submittedHash },
              ),
            };
          }
          throw err;
        }

        artifacts.push(...output.artifacts);
        side_effects.push(...output.sideEffects);
        warnings.push(...output.warnings);
        if (output.partial) facadeStatus = 'partial';

        // pln#458 stp_daffa477: spawn reviewers OUTSIDE the idempotency lock
        // so the async spawn work doesn't widen the critical section. Skipped
        // when there's nothing to spawn (no open_loop, or no reviewer slots).
        let reviewExecStatus: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only' | undefined;
        if (output.preparedReviews.length > 0) {
          reviewExecStatus = await runCoordinateExecution(output.preparedReviews, {
            autoExecute: req.autoExecute !== false,
            senderAgent, senderAgentId, cwd, warnings,
          });
        }

        result = {
          candidate_id: output.candidateId,
          selected_targets: resolvedAgents,
          ...(output.loopId ? { loop_id: output.loopId } : {}),
          ...(reviewExecStatus ? { execution_status: reviewExecStatus } : {}),
        };

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

        // trp#61: supersede assignments attached to the old claim so they
        // don't linger in `created`/`offered`/etc. Prior behaviour only
        // released the claim, leaving the assignment FSM stuck and confusing
        // dispatch analysis / review.
        const { listAssignments: listAsgn } = await import('../core/assignments.js');
        const predecessors = listAsgn(cwd, { claim_id: oldClaim.id })
          .filter((a) => a.status !== 'completed' && a.status !== 'expired' && a.status !== 'rerouted');
        for (const predecessor of predecessors) {
          try {
            transitionAssignment(predecessor.id, 'rerouted', {
              actor: senderAgent,
              status_reason: `reroute: claim ${oldClaim.id} reassigned`,
            }, cwd);
            side_effects.push({ action: 'update', entity: 'assignment', id: predecessor.id });
          } catch (err) {
            warnings.push(`Failed to close predecessor assignment ${predecessor.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const newAgentName = resolvedAgents.find((a) => a !== oldClaim.agent) ?? resolvedAgents[0];
        let newClaimId: string | undefined;
        if (newAgentName) {
          // trp#51: validate target agent before creating a new claim.
          const check = validateAgentForDispatch(newAgentName, { requireSpawnable: true });
          if (!check.valid) {
            warnings.push(JSON.stringify({
              warning: 'agent_validation_failed',
              agent: newAgentName,
              code: check.code,
              reason: check.reason,
            }));
          }
          const profile = check.profile;
          if (check.valid && profile) {
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
        status: facadeStatus,
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

    if (name === 'bclaw_loop') {
      const { handleBclawLoop } = await import('./loops-handlers.js');
      const result = handleBclawLoop({ args: args as unknown, cwd });
      return {
        response: toolResponse({
          content: [{ type: 'text', text: result.summary }],
          structuredContent: result.response as unknown as Record<string, unknown>,
        }),
      };
    }

    if (name === 'bclaw_harvest_candidates') {
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const resolvedIdentity = resolved.identity!;
      const worktreePaths = Array.isArray(args.worktreePaths) ? (args.worktreePaths as string[]) : undefined;
      const dryRun = args.dryRun === true;
      const harvestResult = harvestCandidates({
        worktreePaths,
        dryRun,
        cwd,
        agent: resolvedIdentity.agent_name,
      });
      const dryTag = dryRun ? ' (dry-run)' : '';
      const summary = `✔ Harvest complete${dryTag}: ${harvestResult.harvested.length} imported, ${harvestResult.skipped.length} skipped, ${harvestResult.errors.length} error(s).`;
      return {
        response: toolResponse({
          content: [{ type: 'text', text: summary }],
          harvested: harvestResult.harvested.length,
          skipped: harvestResult.skipped.length,
          errors: harvestResult.errors,
          candidates: harvestResult.harvested.map((c) => ({ id: c.id, type: c.type })),
          dry_run: dryRun,
        }),
      };
    }

    // ── Canonical CRUD verbs (Phase 3 slice 3b) ──────────────────────
    //
    // Thin wrappers around src/core/entity-operations.ts. Behind
    // catalog:"all" while wiring stabilises; promoted to catalog:"default"
    // at the v1.0 cut (slice 3i).
    if (name === 'bclaw_find') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        // pln#460 follow-up — some MCP clients (notably Claude Code with a
        // tool schema that declares `filter: { type: 'object' }` without a
        // sub-property schema) stringify the filter object before shipping
        // it over stdio. Object.keys('{"status":"todo"}') returns ["0",
        // "1", …] as char indices, not ["status"]. We parse it back to an
        // object defensively before validation so the whole filter
        // facility doesn't break for those clients.
        let filter: EntityFilter;
        if (typeof args.filter === 'string') {
          try {
            const parsed = JSON.parse(args.filter);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return { response: createToolErrorResponse(
                'validation_error',
                `filter must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
              ) };
            }
            filter = parsed as EntityFilter;
          } catch (parseErr) {
            return { response: createToolErrorResponse(
              'validation_error',
              `filter is a string that is not valid JSON: ${(parseErr as Error).message}`,
            ) };
          }
        } else {
          filter = (args.filter ?? {}) as EntityFilter;
        }
        // pln#460 stp_c6125ee5 — fail loudly on unknown filter keys. Previously
        // a typo like filter={staus:'todo'} or a made-up key like
        // filter={banana:'split'} silently passed through applyFilter (which
        // only checks known keys), letting the caller believe the filter had
        // applied when it hadn't. Under the new contract, an unknown key is
        // a validation_error listing the keys actually honored.
        const KNOWN_FILTER_KEYS = new Set([
          'status', 'tag', 'author', 'plan_id', 'source', 'auto_generated',
          'limit', 'offset', 'includeLegacy', 'minAutoReflectConfidence',
        ]);
        const unknownKeys = Object.keys(filter).filter((k) => !KNOWN_FILTER_KEYS.has(k));
        if (unknownKeys.length > 0) {
          return {
            response: createToolErrorResponse(
              'validation_error',
              `Unknown filter key(s): ${unknownKeys.map((k) => `"${k}"`).join(', ')}. ` +
              `Accepted keys: ${[...KNOWN_FILTER_KEYS].sort().join(', ')}.`,
              { unknown_keys: unknownKeys, accepted_keys: [...KNOWN_FILTER_KEYS].sort() },
            ),
          };
        }
        const result = listEntities(entity, cwd, filter);
        // structuredContent is the canonical MCP return channel that clients
        // (VS Code extension, Codex, etc.) read for machine-parseable data.
        // Prior to this fix we spread `...result` at top-level of the
        // response body, which got dropped by the MCP protocol wrapper so
        // `result.items` arrived as undefined on the client — the root cause
        // of the VS Code Backlog section rendering empty.
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ ${result.total} ${entity} item(s)` }],
            structuredContent: { ...result },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_get') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        const id = String(args.id ?? '');
        const item = getEntity(entity, id, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ fetched ${entity} ${id}` }],
            structuredContent: { entity, item },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_create') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        const rawData = (args.data ?? {}) as Record<string, unknown>;

        // Auto-fill identity fields. Without this, a caller who omits author/agent
        // creates a schema-invalid record that is silently dropped on read and
        // GC'd from disk on the next mutation. Fallback chain:
        // resolved MCP identity → args.agent → 'unknown'.
        const { agent_name, agent_id } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        const data: Record<string, unknown> = { ...rawData };
        if (data.author === undefined) data.author = agent_name;
        if (data.agent === undefined) data.agent = agent_name;
        if (data.agent_id === undefined && agent_id) data.agent_id = agent_id;

        const result = createEntity(entity, data, cwd);
        appendAuditEntry(
          { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'create', item_id: result.id, item_type: entity },
          cwd,
        );
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ created ${entity} ${result.id}` }],
            structuredContent: { ...result },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_update') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        const id = String(args.id ?? '');
        const patch = (args.patch ?? {}) as Record<string, unknown>;
        const { agent_name, agent_id } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        const result = updateEntity(entity, id, patch, cwd);
        appendAuditEntry(
          { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'update', item_id: id, item_type: entity },
          cwd,
        );
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ updated ${entity} ${id}` }],
            structuredContent: { ...result },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_remove') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        const id = String(args.id ?? '');
        const purge = args.purge === true;
        const { agent_name, agent_id } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        const result = removeEntity(entity, id, cwd, purge);
        appendAuditEntry(
          { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'delete', item_id: id, item_type: entity, reason: purge ? 'purged' : 'archived' },
          cwd,
        );
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ removed ${entity} ${id}` }],
            structuredContent: { ...result },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_transition') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        const id = String(args.id ?? '');
        const to = String(args.to ?? '');
        const reason = args.reason as string | undefined;
        const { agent_name, agent_id } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        const result = transitionEntity(entity, id, to, cwd, reason);
        appendAuditEntry(
          { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'update', item_id: id, item_type: entity, reason: `transition ${result.from} → ${to}${reason ? ` (${reason})` : ''}` },
          cwd,
        );
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ ${entity} ${id}: ${result.from} → ${to}` }],
            structuredContent: { ...result },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    const removedRedirect = REMOVED_TOOL_REDIRECTS[name];
    if (removedRedirect) {
      return { response: createToolErrorResponse('tool_removed', removedRedirect) };
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

// ── MCP Ergonomics: implicit heartbeat + auto-session ────────────────────────

/**
 * Public entry point for MCP tool execution.
 *
 * Before delegating to the inner handler it performs two ergonomic tasks:
 *
 * 1. **Implicit heartbeat** — if `BRAINCLAW_CLAIM_ID` is set in the environment
 *    (worker was dispatched by the coordinator), bump `last_heartbeat_at` on the
 *    active assignment. Any tool call proves liveness; no explicit heartbeat is
 *    needed.
 *
 * 2. **Auto-session** — if `connectionSessionId` is absent AND
 *    `BRAINCLAW_CLAIM_ID` is set AND the claim has no adopted session yet,
 *    start a session implicitly and adopt the claim. The resulting session_id is
 *    returned as `nextConnectionSessionId` so the MCP connection picks it up for
 *    all subsequent calls.
 *
 * Both operations are best-effort: failures are silently swallowed so they never
 * break tool execution.
 */
export async function executeMcpToolCall(payload: McpToolExecutionPayload): Promise<McpToolExecutionOutcome> {
  const { cwd } = payload;
  const envClaimId = process.env.BRAINCLAW_CLAIM_ID?.trim() || undefined;

  // ── Auto-session ────────────────────────────────────────────────────────────
  let autoSessionId: string | undefined;
  let effectiveConnectionSessionId = payload.connectionSessionId;

  if (!effectiveConnectionSessionId && envClaimId) {
    try {
      const claim = loadClaim(envClaimId, cwd);
      if (claim.session_id) {
        // Claim already has a session (e.g. previous connection adopted it) — reuse it.
        // (Codex review cnd#565: reconnect without connectionSessionId should pick up
        // the existing claim.session_id instead of leaving it undefined.)
        effectiveConnectionSessionId = claim.session_id;
      } else {
        // First-ever connection for this claim — start a fresh session + adopt.
        const sessionResult = startSession({ cwd, maintenanceMode: 'fast' });
        autoSessionId = sessionResult.session_id;
        effectiveConnectionSessionId = autoSessionId;
        try { adoptClaimSession(envClaimId, autoSessionId, cwd); } catch { /* best-effort */ }
        // Link session_id to any active assignment for this claim so runtime events
        // no longer show session_id="unknown".
        try {
          const { listAssignments: listA, saveAssignment: saveA } = await import('../core/assignments.js');
          const active = listA(cwd, { claim_id: envClaimId }).filter(
            (a) => !['completed', 'expired', 'rerouted'].includes(a.status),
          );
          for (const a of active) {
            if (!a.session_id) {
              a.session_id = autoSessionId;
              saveA(a, cwd);
            }
          }
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort — claim may not exist in this worktree */ }
  }

  // ── Implicit heartbeat ──────────────────────────────────────────────────────
  if (envClaimId) {
    try {
      bumpActiveAssignmentHeartbeat(envClaimId, undefined, cwd);
    } catch { /* best-effort */ }
  }

  // ── Delegate to inner handler ───────────────────────────────────────────────
  const outcome = await _executeMcpToolCallInner({
    ...payload,
    connectionSessionId: effectiveConnectionSessionId,
  });

  // Apply legacy deprecation warning uniformly (Phase 3 slice 3g). Read tools
  // already get it at line 2560; write tools historically did not. This
  // wrapper ensures every call through a deprecated name surfaces the
  // pointer at the canonical replacement.
  const withLegacyWarning = {
    ...outcome,
    response: appendLegacyMcpToolWarning(outcome.response, payload.name),
  };

  if (autoSessionId && !withLegacyWarning.nextConnectionSessionId) {
    return { ...withLegacyWarning, nextConnectionSessionId: autoSessionId };
  }
  return withLegacyWarning;
}
