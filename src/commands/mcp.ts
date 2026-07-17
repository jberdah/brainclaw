import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { resolveCrossProjectLinks, resolveProjectCwd } from '../core/cross-project.js';
import { buildContext } from '../core/context.js';
import { ageStaleWarnings, ageWorkflowHints, loadServeRegistry } from '../core/hint-aging.js';
import { loadHygienePolicy } from '../core/hygiene-policy.js';
import { sweepAssignmentsAtReadPath, selectReadPathSweepCandidates } from '../core/assignment-sweeper.js';
import { loadAssignment } from '../core/assignments.js';
import { getInstalledBrainclawVersion, readDiskBrainclawVersion } from '../core/brainclaw-version.js';
import { collectLoadValidationWarnings, findLoadValidationWarning, loadState } from '../core/state.js';
import { memoryExists, MEMORY_DIR } from '../core/io.js';
import {
  getEntity,
  listEntities,
  boundListResult,
  DEFAULT_FIND_CHAR_BUDGET,
  GRAMMAR_FILTER_CONTRACT,
  type EntityFilter,
} from '../core/entity-operations.js';
import { handoffDiffPreviewNote } from '../core/handoff-snapshot.js';
import { type EntityName } from '../core/entity-registry.js';
import { generateClaimId, listClaims, loadClaim, saveClaim, adoptClaimSession } from '../core/claims.js';
import { assertCrossProjectBoundary, checkPolicy } from '../core/policy.js';
import { startSession } from './session-start.js';
import {
  AgentIdentityResolutionError,
  AgentTrustError,
  resolveCurrentModel,
} from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO } from '../core/ids.js';
import { loadAllSessions } from '../core/identity.js';
// Setup wizard / project-init / registry helpers now live in mcp-write-admin.ts (PR4).
// Canonical entity write handlers now live in mcp-write-entities.ts (PR4).
import { findOutermostBrainclawRoot, resolveEffectiveCwd, resolveEffectiveCwdInfo, resolveProjectRef } from '../core/store-resolution.js';
import { switchProject } from './switch.js';
import { assessBootstrapNeed, resolveEmptyMemoryRecommendation, type EmptyMemoryRecommendation } from '../core/setup-flow.js';
import { WorkRequestSchema, type FacadeResponse } from '../core/facade-schema.js';
import { codeMapWorkSection, codeMapRefreshNextActions } from '../core/code-map/work-section.js';
import { sweepDeadPidRunningAgentRunsAtRead } from '../core/agentrun-reconciler.js';
import { bumpActiveAssignmentHeartbeat } from '../core/assignments.js';
import {
  handleBclawAckMessage,
  handleBclawCoordinate,
  handleBclawDispatch,
  handleBclawLoop,
  handleBclawSendMessage,
} from './mcp-write-coordination.js';
import {
  ensureTrust,
  resolveMutationIdentity,
  explicitSessionIdFromEnv,
  projectInfoForCwd,
  scopeMetadataForTarget,
} from './mcp-write-support.js';

// ---------------------------------------------------------------------------
// Neutral boundaries extracted in pln#622 PR1. mcp.ts stays the assembly
// point: it imports the extracted modules for its own use and re-exports the
// full historical surface below so external importers are unaffected.
// ---------------------------------------------------------------------------
import {
  SCHEMA_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCP_SERVER_NOT_INITIALIZED,
  toolResponse,
  createToolErrorResponse,
  type McpProtocolVersion,
  type McpConnectionState,
  type JsonRpcId,
  type McpToolResponse,
  type McpToolExecutionPayload,
  type McpToolExecutionOutcome,
  type McpTaskRunnerOptions,
  type McpConnectionOptions,
  type ParsedMcpMessage,
  type McpInitializeResult,
  type McpToolExecutor,
} from './mcp-contract.js';
import {
  MCP_READ_TOOLS,
  PUBLISHED_TOOLS,
  DEFAULT_PUBLISHED_TOOLS,
  UNINITIALIZED_TOOL_NAMES,
  UNINITIALIZED_PUBLISHED_TOOLS,
  buildUninitializedStateMessage,
  LEGACY_READ_TOOL_HANDLERS,
  type McpToolTier,
} from './mcp-catalog.js';
// Claim/assignment write handlers extracted in pln#622 PR3b. The shared write
// helpers (ensureTrust, resolveExecutionWriteTarget, …) stay here and are
// passed by reference via McpWriteClaimsContext.
import {
  handleBclawClaim,
  handleBclawReleaseClaim,
  handleBclawSessionStart,
  handleBclawSessionEnd,
  handleBclawAssignmentUpdate,
  handleBclawAssignmentAction,
  handleBclawAddStep,
  handleBclawCompleteStep,
  handleBclawUpdateStep,
  handleBclawDeleteStep,
  type McpWriteClaimsContext,
} from './mcp-write-claims.js';
// Sequence write handlers extracted in pln#622 PR4.
import {
  handleBclawCreateSequence,
  handleBclawUpdateSequence,
  handleBclawDeleteSequence,
  type McpWriteSequencesContext,
} from './mcp-write-sequences.js';
// Memory write handlers extracted in pln#622 PR4.
import {
  handleBclawWriteNote,
  handleBclawQuickCapture,
  handleBclawCompact,
  handleBclawDeleteMemory,
  handleBclawUpdateMemory,
  handleBclawHarvestCandidates,
  type McpWriteMemoryContext,
} from './mcp-write-memory.js';
// Admin / provisioning write handlers extracted in pln#622 PR4.
import {
  handleBclawSetup,
  handleBclawInitProject,
  handleBclawAddCapability,
  handleBclawAddTool,
  type McpWriteAdminContext,
} from './mcp-write-admin.js';
// Entity write handlers extracted in pln#622 PR4.
import {
  handleBclawCreatePlan,
  handleBclawCreateCandidate,
  handleBclawAccept,
  handleBclawReject,
  handleBclawDeletePlan,
  handleBclawCorrectHandoff,
  handleBclawUpdateHandoff,
  handleBclawCreate,
  handleBclawUpdate,
  handleBclawRemove,
  handleBclawMove,
  handleBclawTransition,
  type McpWriteEntitiesContext,
} from './mcp-write-entities.js';

// Re-exports: the exact pre-PR1 public surface of this module.
export {
  SCHEMA_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCP_SERVER_NOT_INITIALIZED,
  createToolErrorResponse,
  normaliseFormat,
} from './mcp-contract.js';
export type {
  ContextFormat,
  McpProtocolVersion,
  McpConnectionState,
  JsonRpcId,
  McpToolResponse,
  McpReadToolContext,
  McpToolExecutionPayload,
  McpToolExecutionOutcome,
  McpTaskRunnerOptions,
  McpConnectionOptions,
  ParsedMcpMessage,
  McpInitializeResult,
  McpToolErrorShape,
  McpToolExecutor,
} from './mcp-contract.js';
export { renderContextForMcp } from './mcp-presentation.js';
// parseTtl moved with the claim write handlers (pln#622 PR3b); re-exported to
// preserve the historical public surface of this module.
export { parseTtl } from './mcp-write-claims.js';
export {
  MCP_READ_TOOLS,
  ALL_TOOLS,
  MCP_TOOL_NAMES,
  MCP_HEADLESS_AUTO_TOOL_NAMES,
  MCP_CANONICAL_GRAMMAR_TOOL_NAMES,
  REMOVED_IN_V1_TOOLS,
  PUBLISHED_TOOLS,
  FACADE_ORDER,
  DEFAULT_PUBLISHED_TOOLS,
  UNINITIALIZED_TOOL_NAMES,
  UNINITIALIZED_PUBLISHED_TOOLS,
  buildUninitializedStateMessage,
} from './mcp-catalog.js';
export {
  __resetConnectionPrincipalForTests,
} from './mcp-write-support.js';
export type { PinnedConnectionPrincipal, CanonicalAuthorAutoRepair, CanonicalAuthorResolution } from './mcp-write-support.js';

const MCP_RUNTIME_REPAIR_COMMAND = 'brainclaw doctor --repair';

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
  bclaw_list_agents: 'Removed in v1.0: use bclaw_find(entity: "agent", filter) — add filter.scope="global" for the dispatchable catalog, filter.includeReputation=true for reputation.',
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


// Bootstrap helpers moved to mcp-read-handlers.ts
// Quick-capture keyword classification moved to mcp-write-memory.ts (PR4).

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

function renderProvenanceFilterNote(result: {
  excluded_legacy?: number;
  excluded_low_confidence_auto_reflect?: number;
}): string | undefined {
  const parts: string[] = [];
  if ((result.excluded_legacy ?? 0) > 0) {
    parts.push(`${result.excluded_legacy} legacy item(s) excluded (pass filter.includeLegacy=true to include them)`);
  }
  if ((result.excluded_low_confidence_auto_reflect ?? 0) > 0) {
    parts.push(`${result.excluded_low_confidence_auto_reflect} low-confidence auto_reflect item(s) excluded (lower filter.minAutoReflectConfidence to include them)`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
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

export function createInitializeResult(
  protocolVersion: McpProtocolVersion,
  options?: { uninitialized?: boolean; cwd?: string },
): McpInitializeResult {
  const uninitialized = options?.uninitialized === true;
  return {
    protocolVersion,
    serverInfo: { name: 'brainclaw', version: SCHEMA_VERSION },
    // listChanged is only advertised in setup mode, where the catalog flips
    // to the full set once the project memory is initialized.
    capabilities: { tools: { listChanged: uninitialized } },
    ...(uninitialized
      ? { instructions: buildUninitializedStateMessage(options?.cwd ?? process.cwd()) }
      : {}),
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
  /** True while the project memory at cwd is absent — serves the minimal setup catalog. */
  uninitializedMode: boolean;

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
    this.uninitializedMode = options.uninitialized ?? false;
    this.bootVersion = getInstalledBrainclawVersion();
    this.taskRunner = new McpTaskRunner({
      executeTool: options.executeTool ?? createWorkerToolExecutor(),
      onResult: (requestId, outcome) => {
        if (outcome.nextConnectionSessionId !== undefined) {
          // null = explicit clear (session ended); string = refresh; undefined = no-op
          this.connectionSessionId = outcome.nextConnectionSessionId ?? undefined;
        }
        // Inject version mismatch advisory if stale
        const advisory = this.checkVersionMismatch();
        if (advisory && outcome.response.content.length > 0) {
          outcome.response.content = [
            { type: 'text', text: advisory },
            ...outcome.response.content,
          ];
        }
        const catalogUnlocked = this.reconcileUninitializedMode();
        if (catalogUnlocked && outcome.response.content.length > 0) {
          outcome.response.content = [
            ...outcome.response.content,
            { type: 'text', text: '✔ Project memory initialized — the full brainclaw tool catalog is now active. If your client does not refresh tools automatically, reload the MCP server session.' },
          ];
        }
        // Track usage: append response size to usage.jsonl
        if (outcome.toolName) {
          this.trackUsage(outcome.toolName, outcome.response);
        }
        this.sendResult(requestId, outcome.response);
        if (catalogUnlocked) {
          this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
      },
      onInternalError: (requestId, error) => {
        this.sendError(requestId, -32603, error instanceof Error ? error.message : 'Internal error');
      },
    });
  }

  /**
   * Lazy reconcile: if the server booted in setup mode but the project
   * memory now exists (initialized via bclaw_setup, bclaw_init_project,
   * or an out-of-band CLI init), unlock the full catalog.
   * Returns true exactly once — on the transition.
   */
  private reconcileUninitializedMode(): boolean {
    if (!this.uninitializedMode) {
      return false;
    }
    if (!memoryExists(this.cwd)) {
      return false;
    }
    this.uninitializedMode = false;
    return true;
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
        this.reconcileUninitializedMode();
        this.sendResult(id ?? null, createInitializeResult(protocolVersion, {
          uninitialized: this.uninitializedMode,
          cwd: this.cwd,
        }));
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
          this.reconcileUninitializedMode();
          if (this.uninitializedMode) {
            this.sendResult(id ?? null, {
              tools: UNINITIALIZED_PUBLISHED_TOOLS,
              uninitialized: true,
              state: buildUninitializedStateMessage(this.cwd),
            });
            return;
          }
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
        this.reconcileUninitializedMode();
        if (this.uninitializedMode && !UNINITIALIZED_TOOL_NAMES.has(name)) {
          this.sendResult(id ?? null, toolResponse({
            content: [{ type: 'text', text: buildUninitializedStateMessage(this.cwd) }],
            structuredContent: {
              error: 'uninitialized',
              cwd: this.cwd,
              available_tools: [...UNINITIALIZED_TOOL_NAMES],
              next_action: 'Call bclaw_setup to initialize this repo.',
            },
          }, true));
          return;
        }
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
      // Search for '\n' (0x0a) at the byte level so a multibyte UTF-8 sequence
      // that spans two chunks is never split mid-character.  Avoids O(n²)
      // string→buffer reconversion on every iteration.
      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex === -1) return;

      const lineBuffer = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);

      const line = lineBuffer.toString('utf-8').replace(/\r$/, '');
      if (line.trim()) {
        this.onMessage(line);
      }
    }
  }
}

export function runMcp(): void {
  const cwd = resolveEffectiveCwd();

  // No project memory yet: start in setup mode instead of refusing to boot,
  // so agents can initialize the repo via bclaw_setup without a CLI
  // shell-out + session reload.
  const uninitialized = !memoryExists(cwd);
  if (uninitialized) {
    console.error(buildUninitializedStateMessage(cwd));
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
    uninitialized,
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
        // Capture worker stdout so console.log in tool handlers cannot corrupt
        // the parent's JSON-RPC stream. Drain captured output to stderr.
        stdout: true,
      });
    } catch (error: unknown) {
      if (isMissingWorkerFailure(error, missingWorkerPath)) {
        void resolveMissingWorkerExecution(payload, signal, missingWorkerPath).then(resolve, reject);
        return;
      }
      reject(error);
      return;
    }
    // Redirect any worker stdout to the server's stderr (safe for diagnostics)
    worker.stdout?.pipe(process.stderr);
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
  // Include 'project' so that canonical write verbs that accept a project routing
  // arg (e.g. bclaw_claim project=...) are subject to the same signaling-only
  // boundary as the explicit cross-project keys.
  const targetProject = getCrossProjectArg(args, 'targetProject', 'target_project', 'crossProject', 'cross_project', 'project');
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

function matchesCrossProjectLink(ref: string, cwd: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;

  const linkRoots = new Set([path.resolve(cwd), path.resolve(resolveWorkspaceAnchor(cwd))]);
  for (const root of linkRoots) {
    for (const link of resolveCrossProjectLinks(root)) {
      if (
        link.projectName === trimmed
        || link.name === trimmed
        || link.path === trimmed
        || link.absolutePath === trimmed
        || path.basename(link.absolutePath) === trimmed
      ) {
        return true;
      }
    }
  }
  return false;
}

interface ExecutionWriteTarget {
  /** When set, the caller must return this error response instead of writing. */
  block?: McpToolResponse;
  /** Store cwd the execution write must target. */
  targetCwd: string;
  /** True when a session-scoped switch into the target project was performed. */
  autoSwitched: boolean;
  /** Resolved project echoed back to the caller for visibility. */
  resolvedProject?: { path: string; name?: string };
}

/**
 * Resolve the destination store for an execution-entity write (plan / claim and
 * their sub-objects: steps).
 *
 * The signaling-only boundary (cnd cross_project_signaling_vs_execution) forbids
 * driving execution entities into ANOTHER project — but that rule is about
 * FEDERATION (cross_project_links / other machines), not about workspace siblings
 * in the same monorepo. Switching into a sibling and creating a plan there is a
 * purely local operation, and the one the agent actually wants.
 *
 * So when `project=X` resolves to a workspace store-chain child (resolveProjectRef
 * hits — it only matches projects reachable WITHIN this workspace, never a
 * federated link), we AUTO-LOCALIZE: open a session + session-scoped switch into X
 * (sticky, per-agent — switchProject auto-creates the session if missing), then
 * write locally in X. Federated links and unknown names stay blocked.
 *
 * DGX dogfood 2026-06-27: without this an agent on the /srv monorepo cannot
 * `bclaw_create(entity=plan, project=<child>)` — it was rejected as cross-project —
 * so plans silently fell back to the default project instead.
 */
function resolveExecutionWriteTarget(
  entity: 'claim' | 'plan',
  args: Record<string, unknown>,
  cwd: string,
  connectionSessionId?: string,
): ExecutionWriteTarget {
  const targetProject = getCrossProjectArg(args, 'targetProject', 'target_project', 'crossProject', 'cross_project', 'project');
  if (!targetProject) {
    return { targetCwd: cwd, autoSwitched: false };
  }

  if (matchesCrossProjectLink(targetProject, cwd)) {
    const block = blockCrossProjectExecution(entity, args);
    return {
      block: block ?? createToolErrorResponse('validation_error', `Cross-project execution write blocked: ${targetProject}`),
      targetCwd: cwd,
      autoSwitched: false,
    };
  }

  // Workspace store-chain child (or the workspace root / the current project)?
  const wsHit = resolveProjectRef(targetProject, cwd);
  if (wsHit) {
    // Same-workspace → auto-localize. Switch the session into X (sticky,
    // session-scoped) so subsequent un-qualified writes follow, and persist the
    // session under the workspace anchor where resolveEffectiveCwd probes for it
    // — NOT the effective child cwd, or stickiness would be invisible on the next
    // call. The switch is best-effort: the write still localizes to wsHit below.
    let autoSwitched = false;
    try {
      const anchor = resolveWorkspaceAnchor(cwd);
      const sessionId = connectionSessionId ?? explicitSessionIdFromEnv();
      switchProject(targetProject, { cwd: anchor, sessionOnly: true, sessionId });
      autoSwitched = true;
    } catch {
      /* sticky switch is best-effort */
    }
    return { targetCwd: wsHit, autoSwitched, resolvedProject: projectInfoForCwd(wsHit) };
  }

  // Not a workspace child → federated link or unknown name. The signaling-only
  // boundary stands: execution entities never cross a federation boundary.
  const block = blockCrossProjectExecution(entity, args);
  return {
    block: block ?? createToolErrorResponse('validation_error', `Unknown project: ${targetProject}`),
    targetCwd: cwd,
    autoSwitched: false,
  };
}

/**
 * Workspace anchor for persisting a session switch — mirrors resolveEffectiveCwd's
 * anchor selection (BRAINCLAW_CWD when it is a real store, else the outermost
 * store walking up from cwd) so an auto-switch is found on the next resolution.
 */
function resolveWorkspaceAnchor(cwd: string): string {
  const env = process.env.BRAINCLAW_CWD?.trim();
  if (env) {
    const resolved = path.resolve(env);
    if (fs.existsSync(path.join(resolved, MEMORY_DIR, 'config.yaml'))) return resolved;
  }
  return findOutermostBrainclawRoot(cwd) ?? cwd;
}

// Read handlers moved to mcp-read-handlers.ts
import { handleMcpReadToolCall } from './mcp-read-handlers.js';
export { handleMcpReadToolCall };


async function _executeMcpToolCallInner(payload: McpToolExecutionPayload): Promise<McpToolExecutionOutcome> {
  const { name, args, cwd, connectionSessionId } = payload;
  const scopeInfo = payload.effectiveScope ?? {
    cwd,
    active_source: 'cwd' as const,
    resolved_project: projectInfoForCwd(cwd),
  };

  try {
    if (isLegacyMcpToolFacadeDisabled(name)) {
      return { response: createLegacyMcpToolDisabledResponse() };
    }

    // Async read: bclaw_check_security (requires network call to Socket MCP)
    if (name === 'bclaw_check_security') {
      const { handleCheckSecurity } = await import('./check-security-mcp.js');
      return { response: toolResponse(await handleCheckSecurity(args, cwd)) };
    }

    // Code Map tools (spec §9). These delegate to the async JsonlBackend, so
    // they are handled here rather than via the synchronous read-tool path.
    // status/find/brief are reads; refresh is a write (prompt approval).
    if (name === 'bclaw_code_status' || name === 'bclaw_code_find' || name === 'bclaw_code_brief' || name === 'bclaw_code_refresh') {
      const { JsonlBackend } = await import('../core/code-map/backend.js');
      const be = new JsonlBackend();
      if (name === 'bclaw_code_status') {
        const status = await be.status({ cwd, cascade: args.cascade === true });
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `Code Map: ${status.store_exists ? 'store present' : 'no store'} — freshness=${status.freshness_badge.status}` }],
            structuredContent: { ...status, freshness_badge: status.freshness_badge },
          }),
        };
      }
      if (name === 'bclaw_code_refresh') {
        const scope = args.scope === 'all' ? 'all' : 'changed';
        const result = await be.refresh({ scope, cwd, cascade: args.cascade === true });
        const cascadeNote = result.cascade ? ` cascade=${result.cascade.children_refreshed} child(ren)+root` : '';
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `Code Map refresh [${result.scope}]: ran=${result.ran} freshness=${result.freshness_badge.status}${cascadeNote}${result.lock_status ? ` (${result.lock_status})` : ''}` }],
            structuredContent: { ...result, freshness_badge: result.freshness_badge },
          }),
        };
      }
      if (name === 'bclaw_code_find') {
        const query = typeof args.query === 'string' ? args.query : '';
        if (!query.trim()) {
          return { response: createToolErrorResponse('validation_error', 'bclaw_code_find requires a non-empty query.') };
        }
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const result = await be.find({ query, limit, cwd });
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `Code Map find "${result.query}": ${result.matches.length} match(es), freshness=${result.freshness_badge.status}` }],
            structuredContent: { ...result, freshness_badge: result.freshness_badge },
          }),
        };
      }
      // bclaw_code_brief
      const target = typeof args.target === 'string' ? args.target : '';
      if (!target.trim()) {
        return { response: createToolErrorResponse('validation_error', 'bclaw_code_brief requires a non-empty target.') };
      }
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const result = await be.brief({ target, limit, cwd });
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `Code Map brief "${result.target}": ${result.suggested_files_to_read.length} file(s) to read, freshness=${result.freshness_badge.status}` }],
          structuredContent: { ...result, freshness_badge: result.freshness_badge },
        }),
      };
    }

    if (MCP_READ_TOOLS.some((tool) => tool.name === name) || LEGACY_READ_TOOL_HANDLERS.has(name)) {
      return {
        response: appendLegacyMcpToolWarning(toolResponse(handleMcpReadToolCall(name, args, { cwd, connectionSessionId, effectiveScope: scopeInfo })), name),
      };
    }

    // Resolve model once for all write operations
    const currentModel = resolveCurrentModel(cwd);

    // pln#622 PR3b — per-call context for the extracted claim/assignment write
    // handlers (mcp-write-claims.ts). The helper functions are shared with the
    // write domains that remain in this file, so they stay here and are passed
    // by reference.
    const writeClaimsCtx: McpWriteClaimsContext = {
      currentModel,
      ensureTrust,
      resolveMutationIdentity,
      blockCrossProjectExecution,
      resolveExecutionWriteTarget,
      projectInfoForCwd,
      explicitSessionIdFromEnv,
      appendLegacyMcpToolWarning,
      isLegacyMcpToolFacadeDisabled,
      createLegacyMcpToolDisabledResponse,
    };

    // pln#622 PR4 — per-call context for the extracted sequence write handlers.
    const writeSequencesCtx: McpWriteSequencesContext = { currentModel };

    // pln#622 PR4 — per-call context for the extracted memory write handlers.
    const writeMemoryCtx: McpWriteMemoryContext = { currentModel, explicitSessionIdFromEnv, getCrossProjectArg };

    // pln#622 PR4 — per-call context for the extracted admin write handlers.
    const writeAdminCtx: McpWriteAdminContext = { currentModel };

    // pln#622 PR4 — per-call context for the extracted entity write handlers.
    const writeEntitiesCtx: McpWriteEntitiesContext = {
      blockCrossProjectExecution,
      resolveExecutionWriteTarget,
      getCrossProjectArg,
      createLegacyToolExecutionErrorResponse,
      scopeInfo,
    };

    if (name === 'bclaw_setup') {
      return await handleBclawSetup(payload, writeAdminCtx);
    }

    if (name === 'bclaw_init_project') {
      return await handleBclawInitProject(payload, writeAdminCtx);
    }

    if (name === 'bclaw_write_note') {
      return handleBclawWriteNote(payload, writeMemoryCtx);
    }

    if (name === 'bclaw_quick_capture') {
      return handleBclawQuickCapture(payload, writeMemoryCtx);
    }

    if (name === 'bclaw_create_plan') {
      return handleBclawCreatePlan(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_create_candidate') {
      return handleBclawCreateCandidate(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_accept') {
      return handleBclawAccept(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_reject') {
      return handleBclawReject(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_claim') {
      return handleBclawClaim(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_release_claim') {
      return handleBclawReleaseClaim(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_session_start') {
      return handleBclawSessionStart(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_session_end') {
      return handleBclawSessionEnd(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_compact') {
      return handleBclawCompact(payload, writeMemoryCtx);
    }

    if (name === 'bclaw_dispatch') {
      return await handleBclawDispatch(args, { cwd, connectionSessionId });
    }

    if (name === 'bclaw_assignment_update') {
      return handleBclawAssignmentUpdate(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_assignment_action') {
      return handleBclawAssignmentAction(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_send_message') {
      return handleBclawSendMessage(args, { cwd, connectionSessionId });
    }

    if (name === 'bclaw_ack_message') {
      return handleBclawAckMessage(args, { cwd, connectionSessionId });
    }

    if (name === 'bclaw_create_sequence') {
      return handleBclawCreateSequence(payload, writeSequencesCtx);
    }

    if (name === 'bclaw_update_sequence') {
      return handleBclawUpdateSequence(payload, writeSequencesCtx);
    }

    if (name === 'bclaw_add_step') {
      return handleBclawAddStep(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_complete_step') {
      return handleBclawCompleteStep(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_update_step') {
      return handleBclawUpdateStep(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_delete_step') {
      return handleBclawDeleteStep(payload, writeClaimsCtx);
    }

    if (name === 'bclaw_delete_plan') {
      return handleBclawDeletePlan(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_delete_sequence') {
      return handleBclawDeleteSequence(payload, writeSequencesCtx);
    }

    if (name === 'bclaw_delete_memory') {
      return handleBclawDeleteMemory(payload, writeMemoryCtx);
    }

    if (name === 'bclaw_update_memory') {
      return handleBclawUpdateMemory(payload, writeMemoryCtx);
    }

    if (name === 'bclaw_add_capability') {
      return handleBclawAddCapability(payload, writeAdminCtx);
    }

    if (name === 'bclaw_add_tool') {
      return handleBclawAddTool(payload, writeAdminCtx);
    }

    if (name === 'bclaw_correct_handoff') {
      return handleBclawCorrectHandoff(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_update_handoff') {
      return handleBclawUpdateHandoff(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_work') {
      const startMs = Date.now();
      const parseResult = WorkRequestSchema.safeParse(args);
      if (!parseResult.success) {
        return { response: createToolErrorResponse('validation_error', parseResult.error.message) };
      }
      const workReq = parseResult.data;
      const targetCwd = resolveProjectCwd(workReq.project, cwd);
      const useCompact = workReq.compact !== false; // default true
      const warnings: string[] = [];

      // Step 1: implicit session start (handles auto-registration internally)
      let sessionResult: Awaited<ReturnType<typeof startSession>>;
      try {
        sessionResult = await startSession({
          agent: typeof args.agent === 'string' ? args.agent : undefined,
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
          context: workReq.contextTarget,
          cwd: targetCwd,
        });
      } catch (sessionErr: unknown) {
        return { response: createToolErrorResponse('session_error', sessionErr instanceof Error ? sessionErr.message : String(sessionErr)) };
      }
      if (sessionResult.auto_registered) {
        warnings.push(`Agent '${sessionResult.agent}' was auto-registered (first use). Run \`brainclaw register-agent ${sessionResult.agent}\` to set capabilities and trust level.`);
      }

      // Step 2: build context for requested scope. The "what's new" diff is
      // surfaced for ALL intents (pln#390 regression fix): intent='resume'
      // anchors it on the agent's previous session; every other intent gets
      // the per-agent event-log-cursor diff computed inside buildContext
      // (pln#542 — converged novelty mechanism, covers status transitions).
      let contextResult: ReturnType<typeof buildContext> | undefined;
      try {
        let sinceSession: string | undefined;
        if (workReq.intent === 'resume') {
          const previousSession = loadAllSessions(targetCwd)
            .find((s) => s.agent === sessionResult.agent && s.session_id !== sessionResult.session_id);
          sinceSession = previousSession?.session_id;
        }
        contextResult = buildContext({
          target: workReq.contextTarget ?? workReq.scope,
          agent: sessionResult.agent,
          cwd: targetCwd,
          sinceSession,
          // ~4 chars/token: relevance-ranked fill up to the caller's budget.
          maxChars: workReq.budget_tokens ? workReq.budget_tokens * 4 : undefined,
        });
      } catch { /* non-fatal — context failure should not block work */ }

      // Step 3: claim if intent=execute and scope provided
      let claimId: string | undefined;
      let claimStatus: FacadeResponse['claim_status'] = 'none';
      if (workReq.intent === 'execute' && workReq.scope) {
        const existingClaims = listClaims(targetCwd).filter(
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
          }, targetCwd);
          appendAuditEntry({ actor: sessionResult.agent, actor_id: sessionResult.agent_id, action: 'claim', item_id: claimId, item_type: 'claim', scope: workReq.scope, session_id: sessionResult.session_id }, targetCwd);
          claimStatus = 'created';

          // Policy check post-claim
          const policyResult = checkPolicy({ scope: workReq.scope, agent: sessionResult.agent, agentId: sessionResult.agent_id, cwd: targetCwd });
          for (const w of policyResult.warnings.filter((pw) => pw.kind !== 'no_claim')) {
            const idLabel = w.id ? ` (${w.id})` : '';
            warnings.push(`[${w.kind}]${idLabel} ${w.message}`);
          }
        }
      }

      // pln#602 — coordination hygiene at the read path. Cheap: works on
      // what buildContext already loaded (open_work + stale_warnings +
      // workflow_hints) so no additional store scan on the hot bclaw_work
      // path (pln#578 perf guardrail). Sweep converts stuck offered/accepted
      // assignments via the canonical grammar; aging folds warnings/hints
      // that have already been served K times into a single aggregate line.
      type StaleWarningList = NonNullable<NonNullable<typeof contextResult>['stale_warnings']>;
      let stalePostAging: StaleWarningList | undefined;
      let staleAggregate: string | undefined;
      let hintsPostAging: string[] | undefined;
      let hintsAggregate: string | undefined;
      if (contextResult) {
        try {
          const policy = loadHygienePolicy(targetCwd);
          if (!policy.disabled) {
            // Filter candidates from the projection (no extra reads) — only
            // assignments whose surfaced last_heartbeat_at is old enough to
            // possibly cross a family TTL. Zero read overhead when the open
            // work is fresh (the common case).
            const openAssignments = contextResult.open_work?.active_assignments ?? [];
            // Codex PR#48 finding 3 (pln#578 guardrail): select candidate ids
            // from the already-surfaced projection — created/terminal rows are
            // dropped BEFORE any full loadAssignment, so a healthy store costs
            // zero extra file reads. Selection logic is unit-tested in
            // selectReadPathSweepCandidates.
            const candidateIds = selectReadPathSweepCandidates(openAssignments, policy, Date.now());
            if (candidateIds.length > 0) {
              const full = candidateIds
                .map((id) => loadAssignment(id, targetCwd))
                .filter((a): a is NonNullable<typeof a> => a !== undefined);
              sweepAssignmentsAtReadPath(full, targetCwd, {
                actor: 'bclaw_work-readpath',
                policy,
              });
            }
            const registry = loadServeRegistry(targetCwd);
            const aged = ageStaleWarnings(contextResult.stale_warnings ?? [], targetCwd, { policy, registry });
            stalePostAging = aged.warnings;
            staleAggregate = aged.aggregate;
            const agedHints = ageWorkflowHints(contextResult.workflow_hints ?? [], targetCwd, { policy, registry });
            hintsPostAging = agedHints.hints;
            hintsAggregate = agedHints.aggregate;
          }
        } catch { /* non-fatal — hygiene must never break bclaw_work */ }
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

        const stalePool = stalePostAging ?? contextResult.stale_warnings ?? [];
        const staleTop3 = stalePool.slice(0, 3).map(
          (w: { id: string; entity: string; text: string; age_days: number }) => ({
            id: w.id,
            entity: w.entity,
            text: w.text.slice(0, 80),
            age_days: w.age_days,
          }),
        );

        // pln#390 regression fix: the compact projection used to silently
        // drop context_diff, defeating the diff-first contract. Keep a
        // trimmed view (summary + counts + top-5 items, text capped).
        const trimmedDiff = contextResult.context_diff
          ? {
              since: contextResult.context_diff.since,
              since_session: contextResult.context_diff.since_session,
              source: contextResult.context_diff.source,
              summary: contextResult.context_diff.summary,
              counts: contextResult.context_diff.counts,
              changed_items: (contextResult.context_diff.changed_items ?? [])
                .slice(0, 5)
                .map((item) => ({ ...item, text: item.text.slice(0, 120) })),
              ...(contextResult.context_diff.unseen_event_count !== undefined
                ? { unseen_event_count: contextResult.context_diff.unseen_event_count }
                : {}),
            }
          : undefined;

        const hintsPool = hintsPostAging ?? contextResult.workflow_hints ?? [];
        resultPayload = {
          context_schema: contextResult.context_schema,
          profile: contextResult.profile,
          memory_version: contextResult.memory_version,
          memory_density: contextResult.memory_density,
          context_diff: trimmedDiff ?? null,
          plan_summary: planItems,
          stale_warnings: staleTop3,
          ...(staleAggregate ? { stale_warnings_aggregate: staleAggregate } : {}),
          workflow_hints: hintsPool.slice(0, 3),
          ...(hintsAggregate ? { workflow_hints_aggregate: hintsAggregate } : {}),
          claim_conflicts: contextResult.claim_conflicts ?? [],
          open_work: contextResult.open_work ?? null,
          _compact: true,
          _full_context_hint: 'Use bclaw_context(kind="memory") for the full payload.',
        };
      }

      // pln#513 step 1 / pln#557 step 3 — bootstrap hint. The original probe
      // was a one-bit PROJECT.md stat(): false positive on a rich store
      // without PROJECT.md (recommended from-scratch bootstrap over 17k
      // events), eternal false negative on a fossil PROJECT.md. The composite
      // assessment (assessBootstrapNeed: presence × mtime-vs-activity ×
      // store density) adds a distinct 'refresh' verdict that maps to
      // bclaw_bootstrap(refresh: true) — coordinate with the pln#514 step 1
      // force-flag. 'bootstrap' keeps the shared empty-memory rule
      // (resolveEmptyMemoryRecommendation): repo with content → extract via
      // bclaw_bootstrap; greenfield → bootstrap loop. Both chainable.
      let bootstrapRecommended: boolean | undefined;
      let bootstrapVerdict: FacadeResponse['bootstrap_verdict'];
      let bootstrapRefreshReason: string | undefined;
      let nextAction: string | undefined;
      let emptyMemoryRec: EmptyMemoryRecommendation | undefined;
      let storeDensity: 'empty' | 'low' | 'rich' | undefined;
      try {
        const assessment = assessBootstrapNeed(targetCwd);
        bootstrapVerdict = assessment.verdict;
        bootstrapRecommended = assessment.verdict !== 'none';
        storeDensity = assessment.store_density;
        if (assessment.verdict === 'bootstrap') {
          emptyMemoryRec = resolveEmptyMemoryRecommendation(targetCwd);
          nextAction = emptyMemoryRec.mcp_next_action;
        } else if (assessment.verdict === 'refresh') {
          bootstrapRefreshReason = assessment.reasons[0];
          nextAction = 'bclaw_bootstrap(refresh: true)';
        }
      } catch {
        // Best-effort: never block bclaw_work on the probe.
      }

      // Self-teaching affordances (pln#542): each response carries the
      // recommended follow-up calls with exact shapes.
      const nextActions: NonNullable<FacadeResponse['next_actions']> = [];
      if (bootstrapVerdict === 'bootstrap' && emptyMemoryRec) {
        if (emptyMemoryRec.route === 'extract') {
          nextActions.push({ tool: 'bclaw_bootstrap', args: {}, when: `project vision is missing and the ${emptyMemoryRec.reason} — extract initial context, then chain ${emptyMemoryRec.chained_mcp_action} if the vision is still missing` });
        } else {
          nextActions.push({ tool: 'bclaw_coordinate', args: { intent: 'ideate', preset: 'bootstrap' }, when: `project vision is missing and the repo is greenfield — open a bootstrap loop before assuming context, then chain ${emptyMemoryRec.chained_mcp_action} once content exists` });
        }
      } else if (bootstrapVerdict === 'refresh') {
        nextActions.push({ tool: 'bclaw_bootstrap', args: { refresh: true }, when: bootstrapRefreshReason ?? 'PROJECT.md is missing or fossil relative to a mature store — refresh from existing memory, do not bootstrap from scratch' });
      }
      if (claimId) {
        nextActions.push({ tool: 'bclaw_release_claim', args: { id: claimId, planStatus: 'done' }, when: 'implementation complete and committed' });
      } else if (workReq.intent === 'consult' || workReq.intent === 'resume') {
        nextActions.push({ tool: 'bclaw_work', args: { intent: 'execute', scope: workReq.scope ?? '<scope>' }, when: 'ready to edit — claims the scope' });
      }
      // Solo-agent empty-store hint: the bootstrap recommendation covers
      // vision; agents arriving on a freshly-initialised store also need a
      // surface for *work* itself. Without this they reliably consult, see
      // nothing, and stop — bclaw_create(entity='plan') is the missing
      // affordance (2026-06-10 front-door audit). The store-density signal
      // bumps to 'low' as soon as session_start lands a single event, so
      // gate the hint directly on "no plans yet" — the actual condition
      // the agent is in.
      let noPlansYet = false;
      try {
        noPlansYet = loadState(targetCwd).plan_items.length === 0;
      } catch {
        // loadState may fail on a brand-new store with no project.md yet;
        // treat that as "no plans yet" — the next_action remains correct.
        noPlansYet = true;
      }
      if (noPlansYet && (storeDensity === 'empty' || storeDensity === 'low')) {
        nextActions.push({
          tool: 'bclaw_create',
          args: { entity: 'plan', input: { title: '<plan title>', steps: ['<first step>'] } },
          when: 'memory has no plans yet — once you know what you are doing, create a plan so progress is tracked',
        });
      }
      const diffTotal = contextResult?.context_diff?.counts.total ?? 0;
      if (useCompact && diffTotal > 0) {
        nextActions.push({ tool: 'bclaw_context', args: { kind: 'memory' }, when: 'to read the full changed items behind context_diff' });
      }
      nextActions.push({ tool: 'bclaw_quick_capture', args: { text: '<finding>', type: '<decision|trap|constraint|note>' }, when: 'capture decisions/traps as you work' });

      // Code Map opt-in section (spec §10). Single live seam: returns null
      // (and does no work) unless the project's Code Map manifest carries
      // code_map_enabled:true. Never refreshes; bounded ≤2500ms on an active
      // lock; surfaces a missing_index hint or stale results with the badge.
      let codeMapSection: Awaited<ReturnType<typeof codeMapWorkSection>> = null;
      try {
        codeMapSection = await codeMapWorkSection(targetCwd, {
          query: workReq.scope ?? workReq.contextTarget,
        });
      } catch {
        // Best-effort: Code Map must never break or block bclaw_work.
      }

      // Code Map onboarding/freshness nudge (pln#588): promote the actionable
      // refresh to a first-class next_action so a fresh or stale project's first
      // bclaw_work TELLS the agent to build/update the index — the passive
      // missing_index hint alone was easy to skip. Still never refreshes here.
      for (const action of codeMapRefreshNextActions(codeMapSection)) {
        nextActions.push(action);
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
        bootstrap_recommended: bootstrapRecommended,
        bootstrap_verdict: bootstrapVerdict,
        next_action: nextAction,
        next_actions: nextActions,
        ...(codeMapSection ? { code_map: codeMapSection as unknown as Record<string, unknown> } : {}),
      };

      const summaryParts: string[] = [`✔ bclaw_work [${workReq.intent}] session=${sessionResult.session_id}`];
      if (claimId) summaryParts.push(`claim=${claimId} (${claimStatus})`);
      if (contextResult?.context_diff && diffTotal > 0) {
        summaryParts.push(`Δ since last look: ${contextResult.context_diff.summary}`);
      }
      if (useCompact) summaryParts.push('mode=compact (use bclaw_context for full payload)');
      if (bootstrapVerdict === 'bootstrap' && emptyMemoryRec) {
        summaryParts.push(`💡 ${emptyMemoryRec.text}`);
      } else if (bootstrapVerdict === 'refresh') {
        summaryParts.push(`💡 ${bootstrapRefreshReason ?? 'PROJECT.md is missing or fossil relative to a mature store'} → bclaw_bootstrap(refresh: true)`);
      }
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
      return await handleBclawCoordinate(args, { cwd, connectionSessionId, currentModel });
    }

    if (name === 'bclaw_loop') {
      return await handleBclawLoop(args, { cwd, connectionSessionId });
    }

    if (name === 'bclaw_harvest_candidates') {
      return handleBclawHarvestCandidates(payload, writeMemoryCtx);
    }

    // ── Canonical CRUD verbs (Phase 3 slice 3b) ──────────────────────
    //
    // Thin wrappers around src/core/entity-operations.ts. Behind
    // catalog:"all" while wiring stabilises; promoted to catalog:"default"
    // at the v1.0 cut (slice 3i).
    if (name === 'bclaw_find') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        const targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
        const targetScope = scopeMetadataForTarget(args, targetCwd, scopeInfo);
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
        // trp#928 — the entity-scoping error is now first-class: the doc says
        // assignment_id/claim_id/message_id are entity='agent_run' only, but
        // before this the rejection message called them 'unknown', misleading
        // callers who'd cross-reference the description. Now the message names
        // the constraint AND the entity that DOES accept the key so the user
        // can fix the call without hunting through docs. (pln#599 docs-vs-facts.)
        // Derived from the single-source-of-truth GRAMMAR_FILTER_CONTRACT so the
        // handler's accepted keys and the governance fingerprint can never drift
        // (pln#625, Codex review of PR #82).
        const agentRunOnlyFilterKeys = new Set<string>(GRAMMAR_FILTER_CONTRACT.entityScoped.agent_run);
        const agentOnlyFilterKeys = new Set<string>(GRAMMAR_FILTER_CONTRACT.entityScoped.agent);
        const booleanFilterKeys = new Set<string>(GRAMMAR_FILTER_CONTRACT.booleanKeys);
        const KNOWN_FILTER_KEYS = new Set<string>([
          ...GRAMMAR_FILTER_CONTRACT.common,
          ...agentRunOnlyFilterKeys,
          ...agentOnlyFilterKeys,
        ]);
        const providedKeys = Object.keys(filter);
        const unknownKeys = providedKeys.filter((k) => !KNOWN_FILTER_KEYS.has(k));
        const misScopedKeys = providedKeys.filter((k) => agentRunOnlyFilterKeys.has(k) && entity !== 'agent_run');
        const agentMisScopedKeys = providedKeys.filter((k) => agentOnlyFilterKeys.has(k) && entity !== 'agent');
        const allowedScopes = GRAMMAR_FILTER_CONTRACT.constrainedValues.scope as readonly string[];
        const scopeValueInvalid = entity === 'agent' && filter.scope !== undefined
          && !allowedScopes.includes(filter.scope as string);
        // Codex review of #83 — a boolean-typed key (e.g. includeReputation) with a
        // non-boolean value must be rejected loudly, not silently coerced to a no-op.
        const nonBooleanKeys = providedKeys.filter((k) => booleanFilterKeys.has(k) && typeof filter[k] !== 'boolean');
        if (unknownKeys.length > 0 || misScopedKeys.length > 0 || agentMisScopedKeys.length > 0 || scopeValueInvalid || nonBooleanKeys.length > 0) {
          const parts: string[] = [];
          if (unknownKeys.length > 0) {
            parts.push(`Unknown filter key(s): ${unknownKeys.map((k) => `"${k}"`).join(', ')}. Accepted keys: ${[...KNOWN_FILTER_KEYS].sort().join(', ')}.`);
          }
          if (misScopedKeys.length > 0) {
            parts.push(
              `Filter key(s) ${misScopedKeys.map((k) => `"${k}"`).join(', ')} are only valid for entity="agent_run" `
              + `(this call used entity="${entity}"). `
              + `Retry with entity="agent_run", or drop the ${misScopedKeys.join('/')} filter.`,
            );
          }
          if (agentMisScopedKeys.length > 0) {
            parts.push(
              `Filter key(s) ${agentMisScopedKeys.map((k) => `"${k}"`).join(', ')} are only valid for entity="agent" `
              + `(this call used entity="${entity}"). Retry with entity="agent", or drop the ${agentMisScopedKeys.join('/')} filter.`,
            );
          }
          if (scopeValueInvalid) {
            parts.push(`Filter "scope" must be "project" (default) or "global"; got ${JSON.stringify(filter.scope)}.`);
          }
          if (nonBooleanKeys.length > 0) {
            parts.push(
              `Filter key(s) ${nonBooleanKeys.map((k) => `"${k}"`).join(', ')} must be a boolean `
              + `(got ${nonBooleanKeys.map((k) => JSON.stringify(filter[k])).join(', ')}).`,
            );
          }
          return {
            response: createToolErrorResponse(
              'validation_error',
              parts.join(' '),
              {
                unknown_keys: unknownKeys,
                mis_scoped_keys: [...misScopedKeys, ...agentMisScopedKeys],
                accepted_keys: [...KNOWN_FILTER_KEYS].sort(),
                agent_run_only_keys: [...agentRunOnlyFilterKeys],
                agent_only_keys: [...agentOnlyFilterKeys],
                non_boolean_keys: nonBooleanKeys,
              },
            ),
          };
        }
        const result = listEntities(entity, targetCwd, filter);
        // pln#491 — bound the payload (count is already capped by applyPaging;
        // this caps SIZE) so a verbose result set never overflows the MCP token
        // cap and silently pushes the agent to the CLI (trp#449). Advertises
        // has_more / next_offset / hint for explicit pagination.
        // pln#542: budget_tokens lets the caller shrink the size cap further
        // (~4 chars/token); it can only tighten, never exceed the default.
        const offset = Math.max(0, Number(filter.offset) || 0);
        const budgetTokens = typeof args.budget_tokens === 'number' && args.budget_tokens > 0 ? args.budget_tokens : undefined;
        const charBudget = budgetTokens ? Math.min(budgetTokens * 4, DEFAULT_FIND_CHAR_BUDGET) : DEFAULT_FIND_CHAR_BUDGET;
        const bounded = boundListResult(result, offset, charBudget);
        const warnings = collectLoadValidationWarnings(entity, targetCwd);
        const nextActions: Array<Record<string, unknown>> = [
          { tool: 'bclaw_get', args: { entity, id: '<id from items>', ...(args.project ? { project: args.project } : {}), ...(args.budget_tokens ? { budget_tokens: args.budget_tokens } : {}) }, when: 'to read one item in full' },
        ];
        if (bounded.has_more) {
          nextActions.push({ tool: 'bclaw_find', args: { entity, filter: { ...filter, offset: bounded.next_offset }, ...(args.project ? { project: args.project } : {}), ...(args.budget_tokens ? { budget_tokens: args.budget_tokens } : {}) }, when: 'to fetch the next page' });
        }
        // structuredContent is the canonical MCP return channel that clients
        // (VS Code extension, Codex, etc.) read for machine-parseable data.
        // Prior to this fix we spread `...result` at top-level of the
        // response body, which got dropped by the MCP protocol wrapper so
        // `result.items` arrived as undefined on the client — the root cause
        // of the VS Code Backlog section rendering empty.
        const moreNote = bounded.has_more ? ` (returned ${bounded.returned}; ${result.total - bounded.returned} more — offset ${bounded.next_offset})` : '';
        const provenanceFilterNote = renderProvenanceFilterNote(result);
        const legacyNote = provenanceFilterNote
          ? `; ${provenanceFilterNote}`
          : '';
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ ${result.total} ${entity} item(s)${moreNote}${legacyNote}` }],
            structuredContent: {
              ...bounded,
              warnings,
              resolved_project: targetScope.resolved_project,
              active_source: targetScope.active_source,
              next_actions: nextActions,
            },
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
        const targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
        const validationWarning = findLoadValidationWarning(entity, id, targetCwd);
        if (validationWarning) {
          return {
            response: toolResponse({
              content: [{ type: 'text', text: `✖ ${entity} ${id} failed validation at load` }],
              structuredContent: {
                ok: false,
                error: 'validation_failed',
                entity_id: validationWarning.entity_id,
                validation_errors: validationWarning.validation_errors,
                path: validationWarning.path,
              },
            }, true),
          };
        }
        const item = getEntity(entity, id, targetCwd);
        // trp#449 class (pln#542): handoff snapshots embed an unbounded git
        // diff — cap it (budget_tokens tightens, ~4 chars/token).
        let boundedItem = item;
        let diffTruncated = false;
        const getBudgetTokens = typeof args.budget_tokens === 'number' && args.budget_tokens > 0 ? args.budget_tokens : undefined;
        const getCharBudget = getBudgetTokens ? Math.min(getBudgetTokens * 4, DEFAULT_FIND_CHAR_BUDGET) : DEFAULT_FIND_CHAR_BUDGET;
        if (entity === 'handoff' && item && typeof item === 'object') {
          const snapshot = (item as { snapshot?: { diff?: string; diff_digest?: { full_bytes: number; sha256: string; truncated: boolean } } }).snapshot;
          if (snapshot?.diff && snapshot.diff.length > getCharBudget) {
            diffTruncated = true;
            boundedItem = {
              ...(item as Record<string, unknown>),
              snapshot: { ...snapshot, diff: `${snapshot.diff.slice(0, getCharBudget)}\n… [diff truncated to ${getCharBudget} chars]` },
            };
          } else {
            const note = handoffDiffPreviewNote(snapshot);
            if (snapshot?.diff && note) {
              boundedItem = {
                ...(item as Record<string, unknown>),
                snapshot: { ...snapshot, diff: `${snapshot.diff}\n${note}` },
              };
            }
          }
        }
        return {
          response: toolResponse({
            content: [{ type: 'text', text: `✔ fetched ${entity} ${id}` }],
            structuredContent: { entity, item: boundedItem, ...(diffTruncated ? { diff_truncated: true } : {}) },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_create') {
      return handleBclawCreate(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_update') {
      return handleBclawUpdate(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_remove') {
      return handleBclawRemove(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_move') {
      return handleBclawMove(payload, writeEntitiesCtx);
    }

    if (name === 'bclaw_transition') {
      return handleBclawTransition(payload, writeEntitiesCtx);
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
  const baseCwd = payload.cwd;
  const effective = payload.name === 'bclaw_switch'
    ? { cwd: baseCwd, active_source: 'cwd' as const, resolved_project: undefined }
    : resolveEffectiveCwdInfo({ baseCwd, sessionId: payload.connectionSessionId });
  const cwd = effective.cwd;
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
        const sessionResult = await startSession({ cwd, maintenanceMode: 'fast' });
        autoSessionId = sessionResult.session_id;
        effectiveConnectionSessionId = autoSessionId;
        try { adoptClaimSession(envClaimId, autoSessionId, cwd); } catch { /* best-effort */ }
        // Link session_id to any active assignment for this claim so runtime events
        // no longer show session_id="unknown".
        try {
          const { listAssignments: listA, saveAssignment: saveA } = await import('../core/assignments.js');
          const active = listA(cwd, { claim_id: envClaimId }).filter(
            (a) => !['completed', 'cancelled', 'expired', 'rerouted'].includes(a.status),
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

  if ((payload.name === 'bclaw_find' || payload.name === 'bclaw_get') && payload.args.entity === 'agent_run') {
    try { sweepDeadPidRunningAgentRunsAtRead(cwd); } catch { /* best-effort */ }
  }

  // ── Delegate to inner handler ───────────────────────────────────────────────
  const outcome = await _executeMcpToolCallInner({
    ...payload,
    cwd,
    connectionSessionId: effectiveConnectionSessionId,
    effectiveScope: effective,
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
