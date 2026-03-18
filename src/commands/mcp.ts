import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { resolveCrossProjectTarget, writeCrossProjectNote } from '../core/cross-project.js';
import { renderBootstrapSummary, runBootstrapProfile } from '../core/bootstrap.js';
import { buildAgentToolingContext, renderAgentToolingSummary } from '../core/agent-context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { buildExecutionContext, renderExecutionContextSummary } from '../core/execution-context.js';
import { loadState, saveState } from '../core/state.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { generateMarkdown } from '../core/markdown.js';
import { saveCandidate, generateCandidateIdWithLabel } from '../core/candidates.js';
import { loadClaim, saveClaim, generateClaimId } from '../core/claims.js';
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
} from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO, generateIdWithLabel, generateId } from '../core/ids.js';
import { search } from '../core/search.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { validateMcpInput, validateMcpField } from '../core/input-validation.js';
import { buildEstimationReport } from './estimation-report.js';
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
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import type { CandidateType, MemoryVisibility, PlanItem, PlanStep, PlanStatus, Priority } from '../core/schema.js';

export type ContextFormat = 'markdown' | 'json' | 'template';
export type McpProtocolVersion = '2024-11-05' | '2025-11-25';
export type McpConnectionState = 'pre_init' | 'awaiting_initialized' | 'ready' | 'closed';
export type JsonRpcId = string | number | null;

export const SCHEMA_VERSION = '0.3.0';
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
    description: 'Derive brownfield bootstrap signals from repository docs, manifests, and git history.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional path or scope to tailor the bootstrap.' },
        refresh: { type: 'boolean', description: 'Force a fresh bootstrap scan.' },
      },
    },
  },
  {
    name: 'bclaw_get_execution_context',
    description: 'Inspect the local execution environment and optionally agent tooling signals.',
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
] as const;

const MCP_WRITE_TOOLS = [
  {
    name: 'bclaw_setup',
    description: 'Interactive onboarding wizard — global agent install + multi-repo brainclaw init. Use the resume pattern: call without step to start, then pass step+choice to advance through each stage.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'Current step to resume: "project_roots", "repo_selection", or "agent_selection". Omit to start from the beginning.' },
        choice: { type: 'string', description: 'User choice for the current step (e.g. path list, "all", "detected", or comma-separated numbers).' },
        roots: { type: 'string', description: 'Comma-separated root paths (required from step "repo_selection" onward to re-scan).' },
        repo_selection: { type: 'string', description: 'Repo selection choice from previous step (required for "agent_selection" step).' },
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
        severity: { type: 'string', description: 'Severity for traps: low, medium, high.' },
        planId: { type: 'string', description: 'Optional plan item ID this decision or trap relates to.' },
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

  enqueue(requestId: JsonRpcId, payload: McpToolExecutionPayload): void {
    this.queue.push({
      requestId,
      payload,
      controller: new AbortController(),
      cancelled: false,
    });
    this.drain();
  }

  cancel(requestId: JsonRpcId): 'active' | 'queued' | 'missing' {
    if (this.active && this.active.requestId === requestId) {
      this.active.cancelled = true;
      this.active.controller.abort();
      return 'active';
    }

    const index = this.queue.findIndex((task) => task.requestId === requestId);
    if (index >= 0) {
      const [task] = this.queue.splice(index, 1);
      task.cancelled = true;
      task.controller.abort();
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
      this.drain();
      return;
    }
    this.active = next;
    void this.runTask(next);
  }

  private async runTask(task: TaskRecord): Promise<void> {
    try {
      const outcome = await this.executeTool(task.payload, task.controller.signal);
      if (!task.cancelled) {
        this.onResult(task.requestId, outcome);
      }
    } catch (error: unknown) {
      if (!task.cancelled) {
        this.onInternalError(task.requestId, error);
      }
    } finally {
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

  private readonly send: (message: Record<string, unknown>) => void;
  private readonly taskRunner: McpTaskRunner;

  constructor(options: McpConnectionOptions) {
    this.cwd = options.cwd;
    this.send = options.send;
    this.taskRunner = new McpTaskRunner({
      executeTool: options.executeTool ?? createWorkerToolExecutor(),
      onResult: (requestId, outcome) => {
        this.connectionSessionId = outcome.nextConnectionSessionId;
        this.sendResult(requestId, outcome.response);
      },
      onInternalError: (requestId, error) => {
        this.sendError(requestId, -32603, error instanceof Error ? error.message : 'Internal error');
      },
    });
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

export function runMcp(): void {
  const cwd = process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Project memory not initialized. Run `brainclaw init` first.');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const connection = new McpServerConnection({
    cwd,
    send: (message) => {
      process.stdout.write(JSON.stringify(message) + '\n');
    },
  });

  rl.on('line', (line) => {
    connection.handleLine(line);
  });

  rl.on('close', () => {
    connection.close();
  });
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

export function handleMcpReadToolCall(
  name: string,
  args: Record<string, unknown> = {},
  context: McpReadToolContext = {},
): McpToolResponse {
  const cwd = context.cwd ?? process.cwd();

  if (name === 'bclaw_get_context') {
    const result = buildContext({
      target: args.path as string | undefined,
      project: args.project as string | undefined,
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
    const format = normaliseFormat(args.format);
    const content = renderContextForMcp(result, format, {
      explain: args.explain as boolean | undefined,
      compactTemplate: args.compactTemplate as boolean | undefined,
    });
    return {
      content: [{ type: 'text', text: content || 'No relevant memory found.' }],
      structuredContent: { ...result },
    };
  }

  if (name === 'bclaw_bootstrap') {
    const result = runBootstrapProfile({
      target: args.target as string | undefined,
      refresh: args.refresh as boolean | undefined,
      cwd,
    });
    return {
      content: [{ type: 'text', text: renderBootstrapSummary(result) }],
      structuredContent: {
        summary: result.profile.summary,
        target: result.profile.target,
        repo_fingerprint: result.profile.repo_fingerprint,
        sources_scanned: result.profile.sources_scanned,
        seed_count: result.profile.seed_count,
        seeds: result.seeds,
        reused_profile: result.reusedProfile,
      },
    };
  }

  if (name === 'bclaw_get_execution_context') {
    const executionContext = buildExecutionContext({ cwd });
    const agentTooling = args.includeAgentTooling ? buildAgentToolingContext({ cwd }) : undefined;
    const text = [
      renderExecutionContextSummary(executionContext, true),
      ...(agentTooling ? ['', renderAgentToolingSummary(agentTooling)] : []),
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        execution_context: executionContext,
        ...(agentTooling ? { agent_tooling: agentTooling } : {}),
      },
    };
  }

  if (name === 'bclaw_read_handoff') {
    const state = loadState(cwd);
    const handoff = state.open_handoffs.find((entry) => entry.id === args.id);
    let text = `Handoff not found: ${String(args.id)}`;
    if (handoff) {
      text = `From: ${handoff.from}\nTo: ${handoff.to}\nTask: ${handoff.text}\n\n`;
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
      lines.push(`- [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}`);
    }
    lines.push(`Resolved instructions: ${board.resolved_instructions.length}`);
    for (const instruction of board.resolved_instructions.slice(0, 10)) {
      lines.push(`- [${instruction.id}] <${instruction.layer}${instruction.scope ? `:${instruction.scope}` : ''}> ${instruction.text}`);
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
    const results = search({
      query,
      section: (args.section ?? args.type) as string | undefined,
      since: args.since as string | undefined,
      maxResults: typeof args.limit === 'number' ? args.limit : 10,
      cwd,
    });
    const lines = results.map((result) => `[${result.id}] (${result.section}) score=${result.score.toFixed(2)}: ${result.text.slice(0, 120)}`);
    return {
      content: [{ type: 'text', text: results.length > 0 ? lines.join('\n') : 'No results found.' }],
      structuredContent: { results, total: results.length },
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

    if (name === 'bclaw_setup') {
      const step = args.step as string | undefined;
      const choice = (args.choice as string | undefined) ?? '';
      const rootsArg = args.roots as string | undefined;
      const repoSelectionArg = args.repo_selection as string | undefined;
      const env = process.env;

      if (!checkGitPresence()) {
        return { response: toolResponse({ content: [{ type: 'text', text: 'Git is not installed or not found in PATH. Install git from https://git-scm.com before running brainclaw setup.' }], structuredContent: { error: 'git_not_found' } }, true) };
      }

      if (!step) {
        const existingState = readSetupState(env);
        const alreadyRun = existingState ? `Setup was previously run on ${new Date(existingState.completed_at).toLocaleDateString()}. You can re-run it.` : undefined;
        return { response: toolResponse({ content: [{ type: 'text', text: [alreadyRun, "Where are the user's project directories? Please ask the user to provide one or more root paths where their git repositories are located (e.g. ~/Projects, C:\\Users\\user\\code)."].filter(Boolean).join('\n\n') }], structuredContent: { pending_question: 'project_roots', prompt: 'Please ask the user: "Where are your projects? Enter one or more root directories (comma-separated):"', ...(alreadyRun ? { already_run: alreadyRun } : {}) } }) };
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
      const candidate = {
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
        plan_id: candidatePlanId,
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      };
      const planPrompt = (type === 'decision' || type === 'trap') && !candidatePlanId
        ? `\n💡 Does this ${type} relate to an active plan item? If so, re-run with planId: 'pln_xxx' to link it.`
        : '';
      if (writeThrough) {
        saveCandidate(candidate, cwd);
        const accepted = acceptCandidate(candId.id, resolvedIdentity.agent_name, cwd, resolvedIdentity.agent_id);
        appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'promote_direct', item_id: candId.id, item_type: type }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Direct write [${candId.short_label}] (trusted agent)${planPrompt}` }],
            candidate_id: candId.id,
            promoted_item_id: accepted.promoted_item_id,
            write_through: true,
          }),
          nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
        };
      }
      saveCandidate(candidate, cwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'create', item_id: candId.id, item_type: type }, cwd);
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
      saveClaim({
        id: claimId,
        agent: identity.agent,
        agent_id: identity.agent_id,
        project_id: identity.project_id,
        host_id: identity.host_id,
        session_id: identity.session_id,
        scope: claimScope,
        description: claimDescription,
        created_at: nowISO(),
        status: 'active',
        plan_id: args.planId as string | undefined,
      }, claimCwd);
      appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'claim', item_id: claimId, item_type: 'claim' }, claimCwd);
      const postClaimItems = getTriggeredItems('trigger:post-claim', claimCwd);
      const postClaimText = renderTriggeredItems(postClaimItems);
      const noPlanWarn = !(args.planId as string | undefined)
        ? '\n⚠ No plan item linked to this claim. Run bclaw_create_plan first and pass planId to track this work formally.'
        : '';
      const claimText = `✔ Claimed scope [${claimId}]${noPlanWarn}${postClaimText ? `\n${postClaimText}` : ''}`;

      return {
        response: toolResponse({
          content: [{ type: 'text', text: claimText }],
          claim_id: claimId,
          session_id: identity.session_id,
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
          saveState(releaseState, cwd);
          writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(releaseState, cwd));
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
        cwd,
      });
      const preSessionEndItems = getTriggeredItems('trigger:pre-session-end', cwd);
      const preSessionEndText = renderTriggeredItems(preSessionEndItems);
      const sessionEndMsg = preSessionEndText
        ? `✔ Session ended\n${preSessionEndText}`
        : '✔ Session ended';

      return {
        response: toolResponse({
          content: [{ type: 'text', text: sessionEndMsg }],
          session_id: result.session_id,
          notes_in_session: result.notes_in_session,
          candidates_created: result.candidates_created,
          context_diff: result.context_diff,
          triggered_items: preSessionEndItems,
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
      const state = loadState(cwd);
      const { id, short_label } = generateIdWithLabel('plan_items');
      const timestamp = nowISO();
      const entry: PlanItem = {
        id,
        short_label,
        text: planText,
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
      saveState(state, cwd);
      writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));
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
      const state = loadState(cwd);
      const plan = state.plan_items.find((item) => item.id === planId || item.short_label === planId);
      if (!plan) {
        return { response: createToolErrorResponse('not_found', `Plan item '${planId}' not found`) };
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
      saveState(state, cwd);
      writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));
      appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: plan.id, item_type: 'plan' }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Plan item updated: [${plan.id}] ${plan.text}` }],
          plan_id: plan.id,
          status: plan.status,
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
      const state = loadState(cwd);
      const plan = state.plan_items.find((p) => p.id === stepPlanId || p.short_label === stepPlanId);
      if (!plan) return { response: createToolErrorResponse('not_found', `Plan '${stepPlanId}' not found`) };
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
      saveState(state, cwd);
      writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));
      const total = plan.steps.length;
      const done = plan.steps.filter((s) => s.status === 'done').length;
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Step added: [${step.id}] ${stepText} (${done}/${total} done)` }],
          step_id: step.id,
          plan_id: plan.id,
          progress: { done, total },
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
      const state = loadState(cwd);
      const plan = state.plan_items.find((p) => p.id === csPlanId || p.short_label === csPlanId);
      if (!plan) return { response: createToolErrorResponse('not_found', `Plan '${csPlanId}' not found`) };
      const step = (plan.steps ?? []).find((s) => s.id === csStepId);
      if (!step) return { response: createToolErrorResponse('not_found', `Step '${csStepId}' not found in plan '${csPlanId}'`) };
      step.status = 'done';
      step.updated_at = nowISO();
      plan.updated_at = nowISO();
      saveState(state, cwd);
      writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));
      const total = plan.steps!.length;
      const done = plan.steps!.filter((s) => s.status === 'done').length;
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Step completed: [${step.id}] ${step.text} (${done}/${total} done)` }],
          step_id: step.id,
          plan_id: plan.id,
          progress: { done, total },
          all_done: done === total,
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
