import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { renderBootstrapSummary, runBootstrapProfile } from '../core/bootstrap.js';
import { buildAgentToolingContext, renderAgentToolingSummary } from '../core/agent-context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { buildExecutionContext, renderExecutionContextSummary } from '../core/execution-context.js';
import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { saveCandidate, generateCandidateId } from '../core/candidates.js';
import { loadClaim, saveClaim, generateClaimId } from '../core/claims.js';
import { createRuntimeNote } from './runtime-note.js';
import { acceptCandidate } from './accept.js';
import { rejectCandidate } from './reject.js';
import { startSession } from './session-start.js';
import { endSession } from './session-end.js';
import { agentCanWriteDirect, getAgentTrustLevel } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO } from '../core/ids.js';
import { search } from '../core/search.js';
import { buildOperationalIdentity } from '../core/identity.js';
import type { CandidateType, MemoryVisibility } from '../core/schema.js';

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
] as const;

const MCP_WRITE_TOOLS = [
  {
    name: 'bclaw_write_note',
    description: 'Add a runtime note. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Note content.' },
        agent: { type: 'string', description: 'Agent name.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        visibility: { type: 'string', description: 'Visibility: shared, machine, private.' },
        ttl: { type: 'string', description: 'Optional TTL: 30m, 2h, 7d.' },
        autoReflect: { type: 'boolean', description: 'Attempt to reflect the runtime note into durable memory immediately.' },
      },
      required: ['text', 'agent'],
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
        tags: { type: 'array', items: { type: 'string' } },
        severity: { type: 'string', description: 'Severity for traps: low, medium, high.' },
      },
      required: ['text', 'type', 'agent'],
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
      },
      required: ['id'],
    },
  },
  {
    name: 'bclaw_reject',
    description: 'Reject a pending candidate. Requires contributor trust level or above.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Candidate ID to reject.' },
        reason: { type: 'string', description: 'Reason for rejection.' },
        by: { type: 'string', description: 'Reviewer identity.' },
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
        planId: { type: 'string', description: 'Optional linked plan item ID.' },
      },
      required: ['scope', 'description', 'agent'],
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
    description: 'Start a session and capture initial context.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name.' },
        context: { type: 'string', description: 'Context target path.' },
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
        summary: { type: 'string', description: 'Session summary text.' },
        autoReflect: { type: 'boolean', description: 'Auto-reflect session notes as candidates.' },
      },
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

function ensureTrust(agentName: string, level: 'contributor' | 'trusted' | 'curator', cwd?: string): McpToolErrorShape | undefined {
  try {
    const trust = getAgentTrustLevel(agentName, cwd);
    const order = ['observer', 'contributor', 'trusted', 'curator'];
    if (order.indexOf(trust) < order.indexOf(level)) {
      return {
        kind: 'trust_error',
        message: `Insufficient trust: agent '${agentName}' has level '${trust}', '${level}' required.`,
      };
    }
    return undefined;
  } catch {
    if (level === 'trusted' || level === 'curator') {
      return {
        kind: 'trust_error',
        message: `Agent '${agentName}' not registered. '${level}' trust required.`,
      };
    }
    return undefined;
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
    lines.push(`Runtime notes: ${board.runtime_notes.length}`);
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

  throw new Error(`Unknown read tool: ${name}`);
}

export function executeMcpToolCall(payload: McpToolExecutionPayload): McpToolExecutionOutcome {
  const { name, args, cwd, connectionSessionId } = payload;

  try {
    if (MCP_READ_TOOLS.some((tool) => tool.name === name)) {
      return {
        response: toolResponse(handleMcpReadToolCall(name, args, { cwd })),
      };
    }

    if (name === 'bclaw_write_note') {
      const agent = String(args.agent ?? '').trim();
      if (!agent) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: agent') };
      }
      const trustError = ensureTrust(agent, 'contributor', cwd);
      if (trustError) {
        return { response: createToolErrorResponse(trustError.kind, trustError.message, trustError.details) };
      }
      const result = createRuntimeNote(String(args.text ?? ''), {
        agent,
        tag: (args.tags as string[] | undefined) ?? [],
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
      const agent = String(args.agent ?? '').trim();
      if (!agent) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: agent') };
      }
      const trustError = ensureTrust(agent, 'contributor', cwd);
      if (trustError) {
        return { response: createToolErrorResponse(trustError.kind, trustError.message, trustError.details) };
      }
      const identity = buildOperationalIdentity(agent, cwd, { sessionId: connectionSessionId });
      const candId = generateCandidateId();
      const type = String(args.type ?? 'decision') as CandidateType;
      const writeThrough = agentCanWriteDirect(identity.agent_id ?? agent, cwd);
      const candidate = {
        id: candId,
        type,
        text: String(args.text ?? ''),
        created_at: nowISO(),
        author: identity.agent,
        author_id: identity.agent_id,
        project_id: identity.project_id,
        host_id: identity.host_id,
        session_id: identity.session_id,
        tags: (args.tags as string[] | undefined) ?? [],
        status: 'pending' as const,
        severity: type === 'trap' ? ((args.severity as 'low' | 'medium' | 'high' | undefined) ?? 'medium') : undefined,
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      };
      if (writeThrough) {
        saveCandidate(candidate, cwd);
        const accepted = acceptCandidate(candId, agent, cwd);
        appendAuditEntry({ actor: agent, action: 'promote_direct', item_id: candId, item_type: type }, cwd);
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ Direct write [${candId}] (trusted agent)` }],
            candidate_id: candId,
            promoted_item_id: accepted.promoted_item_id,
            write_through: true,
          }),
          nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
        };
      }
      saveCandidate(candidate, cwd);
      appendAuditEntry({ actor: agent, action: 'create', item_id: candId, item_type: type }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Candidate created [${candId}] (pending review)` }],
          candidate_id: candId,
          write_through: false,
        }),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : identity.session_id,
      };
    }

    if (name === 'bclaw_accept') {
      const by = String(args.by ?? args.agent ?? '').trim();
      if (!by) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: by') };
      }
      const trustError = ensureTrust(by, 'trusted', cwd);
      if (trustError) {
        return { response: createToolErrorResponse(trustError.kind, trustError.message, trustError.details) };
      }
      const candId = String(args.id ?? '').trim();
      if (!candId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      const accepted = acceptCandidate(candId, by, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Accepted [${candId}]` }],
          candidate_id: candId,
          promoted_item_id: accepted.promoted_item_id,
        }),
      };
    }

    if (name === 'bclaw_reject') {
      const by = String(args.by ?? args.agent ?? '').trim();
      if (!by) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: by') };
      }
      const trustError = ensureTrust(by, 'contributor', cwd);
      if (trustError) {
        return { response: createToolErrorResponse(trustError.kind, trustError.message, trustError.details) };
      }
      const candId = String(args.id ?? '').trim();
      if (!candId) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      }
      rejectCandidate(candId, args.reason as string | undefined, by, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Rejected [${candId}]` }],
          candidate_id: candId,
        }),
      };
    }

    if (name === 'bclaw_claim') {
      const agent = String(args.agent ?? '').trim();
      if (!agent) {
        return { response: createToolErrorResponse('validation_error', 'Missing required argument: agent') };
      }
      const trustError = ensureTrust(agent, 'contributor', cwd);
      if (trustError) {
        return { response: createToolErrorResponse(trustError.kind, trustError.message, trustError.details) };
      }
      const identity = buildOperationalIdentity(agent, cwd, { sessionId: connectionSessionId });
      const claimId = generateClaimId();
      saveClaim({
        id: claimId,
        agent: identity.agent,
        agent_id: identity.agent_id,
        project_id: identity.project_id,
        host_id: identity.host_id,
        session_id: identity.session_id,
        scope: String(args.scope ?? ''),
        description: String(args.description ?? ''),
        created_at: nowISO(),
        status: 'active',
        plan_id: args.planId as string | undefined,
      }, cwd);
      appendAuditEntry({ actor: agent, action: 'claim', item_id: claimId, item_type: 'claim' }, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Claimed scope [${claimId}]` }],
          claim_id: claimId,
          session_id: identity.session_id,
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
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Released claim [${claimId}]` }],
          claim_id: claimId,
        }),
      };
    }

    if (name === 'bclaw_session_start') {
      const result = startSession({
        agent: args.agent as string | undefined,
        context: args.context as string | undefined,
        cwd,
      });
      return {
        response: toolResponse({
          content: [{ type: 'text', text: '✔ Session started' }],
          session_id: result.session_id,
          agent: result.agent,
          context_target: result.context_target,
        }),
        nextConnectionSessionId: explicitSessionIdFromEnv() ? undefined : result.session_id,
      };
    }

    if (name === 'bclaw_session_end') {
      const result = endSession({
        session: args.session as string | undefined,
        agent: args.agent as string | undefined,
        summary: args.summary as string | undefined,
        autoReflect: args.autoReflect as boolean | undefined,
        cwd,
      });
      return {
        response: toolResponse({
          content: [{ type: 'text', text: '✔ Session ended' }],
          session_id: result.session_id,
          notes_in_session: result.notes_in_session,
          candidates_created: result.candidates_created,
          context_diff: result.context_diff,
        }),
        nextConnectionSessionId: undefined,
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
