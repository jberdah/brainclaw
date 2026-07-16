import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { resolveCrossProjectLinks, resolveCrossProjectWritableTarget, resolveProjectCwd, writeCrossProjectSignal } from '../core/cross-project.js';
import { buildContext } from '../core/context.js';
import { ageStaleWarnings, ageWorkflowHints, loadServeRegistry } from '../core/hint-aging.js';
import { loadHygienePolicy } from '../core/hygiene-policy.js';
import { sweepAssignmentsAtReadPath, selectReadPathSweepCandidates } from '../core/assignment-sweeper.js';
import { loadAssignment } from '../core/assignments.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { checkBrainclawInstallableUpdate, getInstalledBrainclawVersion, readDiskBrainclawVersion, renderBrainclawInstallableUpdateNotice } from '../core/brainclaw-version.js';
import { loadConfig } from '../core/config.js';
import { collectLoadValidationWarnings, findLoadValidationWarning, loadState, persistState, saveState } from '../core/state.js';
import { generateIdWithLabel } from '../core/ids.js';
import { memoryExists, MEMORY_DIR } from '../core/io.js';
import { loadCandidate } from '../core/candidates.js';
import {
  createEntity,
  getEntity,
  listEntities,
  boundListResult,
  DEFAULT_FIND_CHAR_BUDGET,
  removeEntity,
  transitionEntity,
  updateEntity,
  type EntityFilter,
} from '../core/entity-operations.js';
import { relocateEntity } from '../core/operations/relocate.js';
import { handoffDiffPreviewNote } from '../core/handoff-snapshot.js';
import { ENTITY_REGISTRY, type EntityName } from '../core/entity-registry.js';
import { generateClaimId, listClaims, loadClaim, saveClaim, adoptClaimSession, releaseClaimWithCascade } from '../core/claims.js';
import { createSequence, updateSequence, deleteSequence } from '../core/sequence.js';
import { assertCrossProjectBoundary, checkPolicy } from '../core/policy.js';
import { createWorktree as coreCreateWorktree, sanitizeBranchComponent } from '../core/worktree.js';
import { createRuntimeNote } from './runtime-note.js';
import { createCandidateFromInput } from './reflect.js';
import { acceptCandidate } from './accept.js';
import { rejectCandidate } from './reject.js';
import { startSession } from './session-start.js';
import { endSession } from './session-end.js';
import { applyHandoffUpdates } from './update-handoff.js';
import {
  AgentIdentityResolutionError,
  AgentTrustError,
  hasMinimumTrustLevel,
  resolveCurrentModel,
  resolveOrAutoRegisterAgentIdentity,
} from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO, generateId } from '../core/ids.js';
import { buildOperationalIdentity, loadAllSessions, loadCurrentSession, loadSessionById, saveCurrentSession } from '../core/identity.js';
import { validateMcpInput, validateMcpField } from '../core/input-validation.js';
import { createCapability, createTool as createRegistryTool } from '../core/registries.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import { isObserverMode } from '../core/observer-mode.js';
import {
  checkGitPresence,
  scanGitRepos,
  parseRoots,
  parseRepoSelection,
  parseAgentSelection,
  getDetectedSetupAgentNames,
  getInstalledAgentNames,
  runGlobalInstall,
  initReposAndConfigureAgents,
  readSetupState,
  ALL_KNOWN_AGENTS,
} from './setup.js';
import { buildAgentInventory } from '../core/agent-inventory.js';
import { findOutermostBrainclawRoot, resolveEffectiveCwd, resolveEffectiveCwdInfo, resolveProjectRef, resolveTargetStore, type ResolvedEffectiveCwd, type StoreTarget } from '../core/store-resolution.js';
import { switchProject } from './switch.js';
import { assessBootstrapNeed, probeForQuickSetup, buildQuickSetupProbeResponse, buildOnboardingPreview, resolveEmptyMemoryRecommendation, type EmptyMemoryRecommendation, type ProjectTypeChoice, type TopologyChoice } from '../core/setup-flow.js';
import { ensureUserStore, resolveHomeDir } from '../core/setup-state.js';
import type { CandidateType, MemoryVisibility, PlanStepStatus, PlanType, Priority, SequenceItemInput, SequenceStatus } from '../core/schema.js';
import { createPlan, addStep as addStepOp, completeStep as completeStepOp, updateStep as updateStepOp, deleteStep as deleteStepOp, deletePlan as deletePlanOp } from '../core/operations/plan.js';
import { countActionable } from '../core/messaging.js';
import { deleteMemoryItem, updateMemoryItem, type MemoryItemType } from '../core/operations/memory-mutation.js';
import { assessMemoryPressure, buildCompactionTemplate, applyCompaction } from '../core/gc-semantic.js';
import { WorkRequestSchema, type FacadeResponse } from '../core/facade-schema.js';
import { codeMapWorkSection, codeMapRefreshNextActions } from '../core/code-map/work-section.js';
import { sweepDeadPidRunningAgentRunsAtRead } from '../core/agentrun-reconciler.js';
import { bumpActiveAssignmentHeartbeat } from '../core/assignments.js';
import { harvestCandidates } from './harvest.js';
import {
  handleBclawAckMessage,
  handleBclawCoordinate,
  handleBclawDispatch,
  handleBclawLoop,
  handleBclawSendMessage,
} from './mcp-write-coordination.js';
import { ensureTrust, resolveConnectionPrincipal, resolveMutationIdentity } from './mcp-write-support.js';

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
  normaliseFormat,
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
import { renderContextForMcp } from './mcp-presentation.js';
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
export type { PinnedConnectionPrincipal } from './mcp-write-support.js';

const MCP_RUNTIME_REPAIR_COMMAND = 'brainclaw doctor --repair';

type QuickCaptureTarget = 'decision' | 'trap' | 'constraint' | 'note';

interface QuickCaptureClassification {
  target: QuickCaptureTarget;
  reason: string;
  decisionScore: number;
  trapScore: number;
}

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

/**
 * Auto-repair outcome for a canonical-grammar mutation.
 *
 * Populated when `resolveCanonicalAuthor` had to fall through from the strict
 * `resolveMutationIdentity` path onto `resolveOrAutoRegisterAgentIdentity` +
 * auto-session. The doctrine (pln#608): mechanical + non-ambiguous + cheap +
 * scoped precondition → the engine satisfies it AND announces it — never
 * silence. Callers surface these fields as a warning in the response text
 * and in structuredContent.auto_repair.
 */
export interface CanonicalAuthorAutoRepair {
  /** True if the agent identity itself was auto-registered (first use). */
  agent_auto_registered?: boolean;
  /** Session id that was materialized by the auto-repair path, if any. */
  session_auto_created?: string;
}

export interface CanonicalAuthorResolution {
  agent_name: string;
  agent_id?: string;
  /** Undefined when the strict path resolved cleanly (no announcement needed). */
  auto_repair?: CanonicalAuthorAutoRepair;
}

/**
 * Resolve the agent identity for canonical-grammar mutation verbs
 * (bclaw_create/update/remove/transition), so handlers can auto-fill required
 * fields (e.g. plan.author) instead of letting the create land on disk with a
 * missing field — which would then be silently GC'd by the state sync loop
 * (see fix plan pln_5f44426c).
 *
 * pln#562 step 3 — a write that would create a record with a missing/'unknown'
 * author must never be silent (that produced records that passed creation but
 * were schema-invalid on read and silently GC'd from disk).
 *
 * pln#608 — extended with auto-repair: when the caller has no session but a
 * derivable agent name (arg / $BRAINCLAW_AGENT_NAME / detected AI agent),
 * fall through to `resolveOrAutoRegisterAgentIdentity` and materialize the
 * session via `buildOperationalIdentity({ persistImplicitSession: true })`
 * (same mechanic as switchProject:86-106 and session-start). The freshly-
 * created session is tagged `auto_created` so aggressive harvesting can
 * distinguish it from operator sessions (pln#602). The caller receives
 * `auto_repair` and surfaces it as a warning — never silent.
 *
 * KEEP (still a hard error, doctrine boundary): the identity is ambiguous
 * (no name in args, no env signal, no detectable agent). We do not invent
 * an identity — invoke intent is unclear and the write would misattribute.
 */
function resolveCanonicalAuthor(
  args: Record<string, unknown>,
  cwd?: string,
  connectionSessionId?: string,
): CanonicalAuthorResolution {
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

  const strictError = 'error' in resolved && resolved.error ? resolved.error : undefined;

  // KEEP (doctrine boundary): a pinned principal that rejected the caller args
  // is a SPOOF/MISMATCH, not an ambiguous first-write. Never auto-repair over
  // it — silently re-attributing would defeat pln#562 step 3. The strict error
  // already carries the pointer to a curator override.
  if (resolveConnectionPrincipal(cwd, connectionSessionId)) {
    throw new Error(
      `cannot resolve mutation author: ${strictError?.message ?? 'principal mismatch'}`,
    );
  }

  // Observer processes are read-only dashboards/inspectors. Even when an env
  // variable leaks an agent name into the observer process, canonical writes
  // must not use the auto-repair path because it can mint identity/session
  // state as a side effect.
  if (isObserverMode()) {
    throw new Error(
      `cannot resolve mutation author: ${strictError?.message ?? 'observer mode cannot auto-repair identity/session state'}`,
    );
  }

  const explicitName = typeof args.agent === 'string' ? args.agent : undefined;
  const explicitId = typeof args.agentId === 'string' ? args.agentId : undefined;
  // resolveOrAutoRegisterAgentIdentity's fall-through helper only reads
  // BRAINCLAW_AGENT / OPENCLAW_AGENT. resolveCurrentAgentIdentity also honors
  // BRAINCLAW_AGENT_NAME, and dispatched workers set both. Normalize here so
  // an env-declared name is a first-class signal to the auto-repair path.
  const envAgentName = explicitName
    ?? (process.env.BRAINCLAW_AGENT_NAME?.trim() || undefined)
    ?? (process.env.BRAINCLAW_AGENT?.trim() || undefined);

  let identity;
  let autoRegistered: boolean;
  try {
    const outcome = resolveOrAutoRegisterAgentIdentity({
      agentName: envAgentName,
      agentId: explicitId,
      cwd,
      allowCurrent: true,
      allowEnv: true,
    });
    identity = outcome.identity;
    autoRegistered = outcome.auto_registered;
  } catch (err) {
    // Genuine ambiguity — no derivable name. Stays a hard error (KEEP: doctrine
    // boundary is "ambiguous intent → refuse with next_action", not silence).
    const detail = err instanceof Error ? err.message : (strictError?.message ?? String(err));
    throw new Error(
      `cannot resolve mutation author: ${detail} `
      + 'Pass a registered agent, set $BRAINCLAW_AGENT_NAME, '
      + 'or register with `brainclaw register-agent <name>` before writing.',
      { cause: err },
    );
  }

  const explicitSessionId = connectionSessionId?.trim() || explicitSessionIdFromEnv();
  const hadSessionBefore = explicitSessionId
    ? Boolean(loadSessionById(explicitSessionId, cwd))
    : Boolean(loadCurrentSession(cwd));

  let sessionAutoCreated: string | undefined;
  try {
    const opIdentity = buildOperationalIdentity(identity.agent_name, cwd, {
      agentId: identity.agent_id,
      sessionId: explicitSessionId,
      persistImplicitSession: true,
    });
    if (!hadSessionBefore && opIdentity.session_id) {
      sessionAutoCreated = opIdentity.session_id;
      const session = loadSessionById(opIdentity.session_id, cwd);
      if (session && !session.auto_created) {
        saveCurrentSession({ ...session, auto_created: true }, cwd);
      }
    }
  } catch { /* best-effort — write can still proceed without a persisted session */ }

  const autoRepair: CanonicalAuthorAutoRepair | undefined = (autoRegistered || sessionAutoCreated)
    ? {
        ...(autoRegistered ? { agent_auto_registered: true } : {}),
        ...(sessionAutoCreated ? { session_auto_created: sessionAutoCreated } : {}),
      }
    : undefined;

  return {
    agent_name: identity.agent_name,
    agent_id: identity.agent_id,
    ...(autoRepair ? { auto_repair: autoRepair } : {}),
  };
}

function renderAutoRepairWarning(auto_repair: CanonicalAuthorAutoRepair, agent_name: string): string {
  const parts: string[] = [];
  if (auto_repair.agent_auto_registered) {
    parts.push(`agent '${agent_name}' auto-registered (first use). Run \`brainclaw register-agent ${agent_name}\` to set capabilities and trust level.`);
  }
  if (auto_repair.session_auto_created) {
    parts.push(`session ${auto_repair.session_auto_created} auto-created for this write.`);
  }
  return `⚠️ auto-repair: ${parts.join(' ')}`;
}

function explicitSessionIdFromEnv(): string | undefined {
  return process.env.BRAINCLAW_SESSION_ID?.trim()
    || process.env.OPENCLAW_SESSION_ID?.trim()
    || process.env.CLAUDE_SESSION_ID?.trim()
    || process.env.COPILOT_SESSION_ID?.trim();
}

function projectInfoForCwd(cwd: string): { path: string; name?: string } {
  try {
    const config = loadConfig(cwd);
    return { path: cwd, name: config.project_name };
  } catch {
    return { path: cwd };
  }
}

function scopeMetadataForTarget(
  args: Record<string, unknown>,
  targetCwd: string,
  effectiveScope: ResolvedEffectiveCwd,
): { resolved_project: { path: string; name?: string }; active_source: ResolvedEffectiveCwd['active_source'] | 'explicit' } {
  const hasExplicitProject = typeof args.project === 'string' && args.project.trim().length > 0;
  return {
    resolved_project: projectInfoForCwd(targetCwd),
    active_source: hasExplicitProject ? 'explicit' : effectiveScope.active_source,
  };
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
        summary.push('✔ Full brainclaw MCP catalog activates automatically; reload your agent session only if new tools do not appear.');

        // Bootstrap route follows the shared empty-memory rule; the preview
        // already embeds the same recommendation text when memory is empty.
        const probe = probeForQuickSetup(cwd);
        const bootstrapAvailable = probe.hasContent;
        const emptyMemoryRec = resolveEmptyMemoryRecommendation(cwd);
        const preview = buildOnboardingPreview(cwd);

        return {
          response: toolResponse({
            content: [{ type: 'text', text: summary.join('\n') + '\n\n' + preview }],
            structuredContent: {
              setup_complete: true,
              project_type: projectType,
              topology,
              detected_agent: detected?.name ?? null,
              bootstrap_available: bootstrapAvailable,
              bootstrap_route: emptyMemoryRec.route,
              next_action: emptyMemoryRec.mcp_next_action,
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
        const installedAgents = getInstalledAgentNames(buildAgentInventory(resolveHomeDir(env) ?? os.homedir(), env));
        const detectedSetupAgents = getDetectedSetupAgentNames(detected?.name, installedAgents);
        const agentList = ALL_KNOWN_AGENTS.map((a, i) => {
          const tag = a === detected?.name ? ' ← detected' : installedAgents.includes(a) ? ' ← installed' : '';
          return `  ${i + 1}) ${a}${tag}`;
        }).join('\n');
        const detectedLine = detectedSetupAgents.length > 0 ? `\nDetected install set: ${detectedSetupAgents.join(', ')}\n` : '\n';
        return { response: toolResponse({ content: [{ type: 'text', text: `Selected ${selectedRepos.length} repo(s). Detected AI agent: ${detected?.name ?? 'none'}.${detectedLine}\nAvailable agents:\n${agentList}\n\nAsk the user which agents to configure.` }], structuredContent: { pending_question: 'agent_selection', roots: rootsArg, repo_selection: choice, selected_repos: selectedRepos.map((r) => ({ path: r.path, name: r.name })), detected_agent: detected?.name ?? null, installed_agents: installedAgents, detected_setup_agents: detectedSetupAgents, all_agents: ALL_KNOWN_AGENTS, prompt: 'Please ask the user: "Which agents to configure? Reply: (d)etected installed, (a)ll, or agent names like claude-code,cursor"' } }) };
      }

      if (step === 'agent_selection') {
        if (!rootsArg || !repoSelectionArg) {
          return { response: toolResponse({ content: [{ type: 'text', text: 'Missing roots or repo_selection parameter from previous steps.' }], structuredContent: { error: 'missing_params' } }, true) };
        }
        const roots = parseRoots(rootsArg, env);
        const repos = scanGitRepos(roots);
        const selectedRepos = parseRepoSelection(repoSelectionArg, repos, cwd);
        const detected = detectAiAgent(env);
        const installedAgents = getInstalledAgentNames(buildAgentInventory(resolveHomeDir(env) ?? os.homedir(), env));
        const selectedAgents = parseAgentSelection(choice, detected?.name, installedAgents);
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

    if (name === 'bclaw_init_project') {
      const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!rawPath) {
        return { response: createToolErrorResponse('validation_error', 'path is required') };
      }
      const force = args.force === true;
      const projectModeArg = typeof args.project_mode === 'string' ? args.project_mode : undefined;
      const linkAs = typeof args.link_as === 'string' && args.link_as.trim().length > 0
        ? args.link_as.trim()
        : undefined;

      const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

      let wasAlreadyInitialized = false;
      if (memoryExists(resolvedPath) && !force) {
        wasAlreadyInitialized = true;
      } else {
        if (!fs.existsSync(resolvedPath)) {
          try {
            fs.mkdirSync(resolvedPath, { recursive: true });
          } catch (err) {
            return {
              response: createToolErrorResponse(
                'init_project_failed',
                `Failed to create target directory '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
              ),
            };
          }
        }
        try {
          const { runInit } = await import('./init.js');
          await runInit({
            yes: true,
            cwd: resolvedPath,
            force,
            ...(projectModeArg ? { projectMode: projectModeArg as 'single-project' | 'multi-project' | 'auto' } : {}),
          });
        } catch (err) {
          return {
            response: createToolErrorResponse(
              'init_project_failed',
              `runInit failed for '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
            ),
          };
        }
      }

      let projectName: string;
      try {
        projectName = loadConfig(resolvedPath).project_name;
      } catch {
        projectName = path.basename(resolvedPath);
      }

      let linkName: string;
      try {
        const { addCrossProjectLink } = await import('../core/cross-project.js');
        const link = addCrossProjectLink({
          path: resolvedPath,
          name: linkAs ?? projectName,
          cwd,
          force,
        });
        linkName = link.name ?? path.basename(resolvedPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Treat a duplicate link as idempotent success when the caller did
        // not request --force; the project itself is initialised correctly
        // and the existing link already points at it.
        if (/already exists/i.test(message) && !force) {
          try {
            const { resolveCrossProjectLinks } = await import('../core/cross-project.js');
            const existing = resolveCrossProjectLinks(cwd).find(
              (l) => l.absolutePath === resolvedPath || l.path === rawPath,
            );
            linkName = existing?.name ?? linkAs ?? projectName;
          } catch {
            linkName = linkAs ?? projectName;
          }
        } else {
          return {
            response: createToolErrorResponse('init_project_failed', `Failed to register cross_project_link: ${message}`),
          };
        }
      }

      const summary = wasAlreadyInitialized
        ? `✔ ${resolvedPath} already initialised; linked as '${linkName}'.`
        : `✔ Initialised brainclaw at ${resolvedPath} and linked as '${linkName}'.`;

      return {
        response: toolResponse({
          content: [{ type: 'text', text: summary }],
          structuredContent: {
            status: 'ok',
            project_name: projectName,
            path: resolvedPath,
            link_id: linkName,
            was_already_initialized: wasAlreadyInitialized,
          },
        }),
      };
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
              id: generateId('runtime_note'),
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
      // Caller-asserted classification wins (pln#542): the calling agent
      // declares decision/trap/constraint/note; keyword heuristics are the
      // fallback when no type is given.
      const assertedType = typeof args.type === 'string' ? args.type.trim().toLowerCase() : undefined;
      let classification: QuickCaptureClassification;
      if (assertedType === 'decision' || assertedType === 'trap' || assertedType === 'constraint' || assertedType === 'note') {
        classification = { target: assertedType, reason: 'caller_asserted', decisionScore: 0, trapScore: 0 };
      } else if (assertedType !== undefined) {
        return { response: createToolErrorResponse('validation_error', `type must be one of: decision, trap, constraint, note (got '${assertedType}')`) };
      } else {
        classification = classifyQuickCapture(text);
      }
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
              next_actions: [
                { tool: 'bclaw_quick_capture', args: { text: '<same text>', type: 'decision' }, when: 'this was actually a durable decision/trap/constraint — re-capture with an asserted type' },
              ],
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
      const captureNextActions = capture.writeThrough
        ? [
            { tool: 'bclaw_get', args: { entity: classification.target, id: capture.promotedItemId }, when: 'to verify the promoted item' },
          ]
        : [
            { tool: 'bclaw_get', args: { entity: 'candidate', id: capture.candidateId }, when: 'to review the pending candidate (contradiction metadata is advisory)' },
          ];
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
            // Advisory only (cnd_abe61d68): contradictions are metadata on
            // the candidate, never a promotion blocker.
            contradiction_summary: capture.contradictionSummary,
            contradictions_detected: capture.contradictionsDetected?.map((item) => ({
              severity: item.severity,
              reason: item.reason,
              conflicts_with: item.conflicts_with,
            })),
            context,
            next_actions: captureNextActions,
          },
        }),
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
      // project=X naming a workspace sibling auto-localizes (session+switch then
      // claim locally); federated links / unknown names stay blocked.
      const claimLoc = resolveExecutionWriteTarget('claim', args, cwd, connectionSessionId);
      if (claimLoc.block) {
        return { response: claimLoc.block };
      }
      const effectiveClaimCwd = claimLoc.targetCwd;
      const claimAutoSwitched = claimLoc.autoSwitched;
      const storeTarget = (args.store as StoreTarget | undefined) ?? 'local';
      const claimCwd = resolveTargetStore(effectiveClaimCwd, storeTarget);
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
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
      const identity = {
        ...buildOperationalIdentity(resolvedIdentity.agent_name, cwd, {
          agentId: resolvedIdentity.agent_id,
          sessionId: connectionSessionId,
        }),
        project_id: loadConfig(claimCwd).project_id,
      };
      const claimId = generateClaimId();
      let worktreePath: string | undefined;
      let worktreeWarn = '';
      // trp#431: advisory mode skips worktree creation. Default is to create an
      // isolated worktree (multi-agent safety), but when the work already lives
      // (uncommitted) in the main tree a fresh worktree is counterproductive and
      // the agent ends up skipping the claim. Pass advisory:true (or
      // worktree:false) for an advisory-only lock with no worktree.
      const advisoryClaim = args.advisory === true || args.worktree === false;
      if (!advisoryClaim) {
        // Shared slug logic (trp#950): collision-resistant when the scope
        // exceeds the branch-component cap, and identical to createCoordinatorClaim.
        const branchSlug = sanitizeBranchComponent(claimScope);
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
            const branchSlug = sanitizeBranchComponent(claimScope);
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
      const autoSwitchNote = claimAutoSwitched ? `\n  Auto-switched → ${projectInfoForCwd(effectiveClaimCwd).name ?? effectiveClaimCwd}` : '';
      const claimText = `✔ Claimed scope [${claimId}]${worktreeNote}${expiryNote}${handoffNote}${autoSwitchNote}${noPlanWarn}${worktreeWarn}${branchWarn}${staleBranchWarn}${policyWarn}${postClaimText ? `\n${postClaimText}` : ''}`;

      return {
        response: appendLegacyMcpToolWarning(toolResponse({
          content: [{ type: 'text', text: claimText }],
          claim_id: claimId,
          session_id: identity.session_id,
          worktree_path: worktreePath,
          triggered_items: postClaimItems,
          ...(claimAutoSwitched ? { auto_switched: true, resolved_project: projectInfoForCwd(effectiveClaimCwd) } : {}),
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
      // pln#562 step 5 + trp#928 — release is ownership-checked like acquisition
      // and adoption. Under the trp#928 tightening the coordinator override is
      // OPT-IN via coordinator_override:true (implicit "trusted+ = always
      // override" was too magic — a coordinator releasing a worker's claim
      // should be a visible act, not a silent side-effect of trust). The
      // ownership check still enforces:
      //   - owner-of-claim releases (identity matches): allowed, no override needed
      //   - non-owner releases without coordinator_override: rejected loudly (the
      //     error message points the caller at coordinator_override so it is
      //     executable — pln#607 rule).
      //   - non-owner releases with coordinator_override:true but not trusted+:
      //     trust_error (privilege escalation prevention).
      //   - non-owner releases with coordinator_override:true and trusted+:
      //     allowed, audited (auditReleaseOverride).
      const releaseIdentity = resolveMutationIdentity(args, { nameField: 'agent', idField: 'agentId' }, cwd, connectionSessionId);
      if ('error' in releaseIdentity && releaseIdentity.error) {
        const { kind, message, details } = releaseIdentity.error;
        return { response: createToolErrorResponse(kind, message, details) };
      }
      if (!('identity' in releaseIdentity) || !releaseIdentity.identity) {
        return { response: createToolErrorResponse('identity_error', 'No registered agent identity resolved for bclaw_release_claim.') };
      }
      const coordinatorOverrideRequested = args.coordinator_override === true;
      if (coordinatorOverrideRequested) {
        const trustLevel = releaseIdentity.identity.trust_level ?? 'contributor';
        if (!hasMinimumTrustLevel(trustLevel, 'trusted')) {
          return {
            response: createToolErrorResponse(
              'trust_error',
              `coordinator_override:true requires trust_level 'trusted' or higher — caller is '${trustLevel}'. Ask a curator to elevate the agent, or have the claim owner release it.`,
            ),
          };
        }
      }
      const releaseAuth = {
        agent: releaseIdentity.identity.agent_name,
        agent_id: releaseIdentity.identity.agent_id,
        session_id: connectionSessionId,
        override: coordinatorOverrideRequested,
      };
      let cascadeResult;
      try {
        cascadeResult = releaseClaimWithCascade(claimId, {
          planStatus: args.planStatus as string | undefined,
          cwd,
          auth: releaseAuth,
        });
      } catch (err: unknown) {
        return { response: createToolErrorResponse('trust_error', err instanceof Error ? err.message : String(err)) };
      }
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
      const result = await startSession({
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
      const result = await endSession({
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
        nextConnectionSessionId: null,
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
      return await handleBclawDispatch(args, { cwd, connectionSessionId });
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

        // trp#928 — cascade-release the assignment's linked claim on completion.
        // Before this landing an obedient worker had to make TWO calls to close
        // the loop (bclaw_assignment_update status=completed AND
        // bclaw_release_claim); dispatch briefs enumerate both, but not every
        // sandboxed worker gets through both, and the coordinator's harvest path
        // only releases on --integrate — so contributor-driven completions left
        // claims active. The worker's own identity owns the claim (session
        // adoption), so ownership matches and no coordinator_override is needed.
        // Silent success/failure is unacceptable: log per-claim outcome.
        if (status === 'completed' && assignment.claim_id) {
          try {
            const { releaseClaimsCascade, logCascadeReleaseResult } = await import('../core/claims.js');
            const cascade = releaseClaimsCascade([assignment.claim_id], {
              cwd,
              planStatus: 'done',
              auth: {
                agent: callerAgent,
                agent_id: resolved.identity!.agent_id,
                session_id: effectiveSessionId,
                override: false,
              },
            });
            logCascadeReleaseResult({
              actor: callerAgent,
              trigger: 'assignment_completed',
              assignment_id: assignmentId,
              claim_id: assignment.claim_id,
              cascade,
              cwd,
            });
          } catch { /* never block the update on cascade release */ }
        }

        // When accepted: auto-acknowledge the inbox message (replaces bclaw_ack_message)
        if (status === 'accepted' && assignment.message_id) {
          try {
            const { ackMessage } = await import('../core/messaging.js');
            // pln#562 step 4 — scope the ack to this assignment's claim so a
            // same-named sibling instance cannot consume the message.
            ackMessage(assignment.message_id, callerAgent, cwd, { claimId: assignment.claim_id });
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
      return handleBclawSendMessage(args, { cwd, connectionSessionId });
    }

    if (name === 'bclaw_ack_message') {
      return handleBclawAckMessage(args, { cwd, connectionSessionId });
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
      const stepLoc = resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
      if (stepLoc.block) {
        return { response: stepLoc.block };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const stepPlanId = String(args.planId ?? '').trim();
      const stepData = args.data && typeof args.data === 'object' && !Array.isArray(args.data)
        ? args.data as Record<string, unknown>
        : {};
      if ((args.text !== undefined || args.assignee !== undefined) && Object.keys(stepData).length > 0) {
        console.warn('[brainclaw:warn] bclaw_add_step received legacy top-level fields alongside data.*; using data.* values');
      }
      const stepTextRaw = stepData.text ?? stepData.title ?? args.text;
      const stepText = typeof stepTextRaw === 'string' ? stepTextRaw.trim() : '';
      const stepAssignee = (stepData.assignee ?? args.assignee) as string | undefined;
      const stepEstimated = (stepData.estimated_effort ?? args.estimated_effort) as number | string | undefined;
      const stepActual = (stepData.actual_effort ?? args.actual_effort) as string | undefined;
      if (!stepPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!stepText) return { response: createToolErrorResponse('validation_error', 'Missing required argument: data.text') };
      const stepTargetCwd = stepLoc.targetCwd;
      try {
        const result = addStepOp({ planId: stepPlanId, text: stepText, assignee: stepAssignee, estimatedEffort: stepEstimated, actualEffort: stepActual }, stepTargetCwd);
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
      const csLoc = resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
      if (csLoc.block) {
        return { response: csLoc.block };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const csPlanId = String(args.planId ?? '').trim();
      const csStepId = String(args.stepId ?? '').trim();
      if (!csPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!csStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
      const csTargetCwd = csLoc.targetCwd;
      try {
        const result = completeStepOp({ planId: csPlanId, stepId: csStepId }, csTargetCwd);
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
      const usLoc = resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
      if (usLoc.block) {
        return { response: usLoc.block };
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
      const usTargetCwd = usLoc.targetCwd;
      try {
        const result = updateStepOp({
          planId: usPlanId,
          stepId: usStepId,
          status: args.status as PlanStepStatus | undefined,
          text: args.text as string | undefined,
          assignee: args.assignee as string | undefined,
          estimatedEffort: args.estimated_effort as number | string | undefined,
          actualEffort: args.actual_effort as string | undefined,
        }, usTargetCwd);
        const changes: string[] = [];
        if (args.status) changes.push(`status=${args.status}`);
        if (args.text) changes.push('text updated');
        if (args.assignee !== undefined) changes.push(`assignee=${args.assignee || 'unassigned'}`);
        if (args.estimated_effort !== undefined) changes.push(`estimate=${args.estimated_effort}`);
        if (args.actual_effort !== undefined) changes.push(`actual=${args.actual_effort}`);
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
      const dsLoc = resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
      if (dsLoc.block) {
        return { response: dsLoc.block };
      }
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const dsPlanId = String(args.planId ?? '').trim();
      const dsStepId = String(args.stepId ?? '').trim();
      if (!dsPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
      if (!dsStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
      const dsTargetCwd = dsLoc.targetCwd;
      try {
        const result = deleteStepOp({ planId: dsPlanId, stepId: dsStepId }, dsTargetCwd);
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
      const dpLoc = resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
      if (dpLoc.block) {
        return { response: dpLoc.block };
      }
      const dpTargetCwd = dpLoc.targetCwd;
      const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
      if (resolved.error) {
        return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
      }
      const dpId = String(args.id ?? '').trim();
      if (!dpId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
      try {
        const result = deletePlanOp(dpId, dpTargetCwd);
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
        const KNOWN_FILTER_KEYS = new Set([
          'status', 'tag', 'tags', 'author', 'plan_id', 'source', 'auto_generated',
          'assignment_id', 'claim_id', 'message_id',
          'limit', 'offset', 'includeLegacy', 'minAutoReflectConfidence',
        ]);
        const agentRunOnlyFilterKeys = new Set(['assignment_id', 'claim_id', 'message_id']);
        const providedKeys = Object.keys(filter);
        const unknownKeys = providedKeys.filter((k) => !KNOWN_FILTER_KEYS.has(k));
        const misScopedKeys = providedKeys.filter((k) => agentRunOnlyFilterKeys.has(k) && entity !== 'agent_run');
        if (unknownKeys.length > 0 || misScopedKeys.length > 0) {
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
          return {
            response: createToolErrorResponse(
              'validation_error',
              parts.join(' '),
              {
                unknown_keys: unknownKeys,
                mis_scoped_keys: misScopedKeys,
                accepted_keys: [...KNOWN_FILTER_KEYS].sort(),
                agent_run_only_keys: [...agentRunOnlyFilterKeys],
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
      try {
        const entity = String(args.entity ?? '') as EntityName;
        // Execution entities (plan/claim) auto-localize into a workspace sibling
        // when project=X names one: session+switch then write locally. Only
        // federated links / unknown names are blocked (signaling-only boundary).
        let targetCwd: string;
        let autoSwitched = false;
        if (entity === 'claim' || entity === 'plan') {
          const loc = resolveExecutionWriteTarget(entity, args, cwd, connectionSessionId);
          if (loc.block) return { response: loc.block };
          targetCwd = loc.targetCwd;
          autoSwitched = loc.autoSwitched;
        } else {
          targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
        }
        const rawData = (args.data ?? {}) as Record<string, unknown>;
        const targetScope = scopeMetadataForTarget(args, targetCwd, scopeInfo);

        // Auto-fill identity fields. Without this, a caller who omits author/agent
        // creates a schema-invalid record that is silently dropped on read and
        // GC'd from disk on the next mutation.
        // Identity is resolved against the SOURCE cwd (the agent's own
        // project/registry), not the target — an agent doesn't need to be
        // registered in the target project to write into it. An explicitly
        // supplied data.author is honored as content-level attribution
        // (cross-project signaling writers may not be registered locally);
        // when author is MISSING, resolution is mandatory and failure is a
        // hard validation_error (pln#562 step 3) — never author:'unknown'.
        const data: Record<string, unknown> = { ...rawData };
        let actor = typeof data.author === 'string' ? data.author : undefined;
        let actorId = typeof data.agent_id === 'string' ? data.agent_id : undefined;
        let autoRepair: CanonicalAuthorAutoRepair | undefined;
        if (data.author === undefined) {
          const author = resolveCanonicalAuthor(args, cwd, connectionSessionId);
          data.author = author.agent_name;
          if (data.agent === undefined) data.agent = author.agent_name;
          if (data.agent_id === undefined && author.agent_id) data.agent_id = author.agent_id;
          actor = author.agent_name;
          actorId = author.agent_id;
          autoRepair = author.auto_repair;
        } else if (data.agent === undefined) {
          data.agent = data.author;
        }

        const result = createEntity(entity, data, targetCwd);
        appendAuditEntry(
          { actor: actor ?? 'unknown', ...(actorId ? { actor_id: actorId } : {}), action: 'create', item_id: result.id, item_type: entity },
          targetCwd,
        );
        const createText = `✔ created ${entity} ${result.id}${autoSwitched ? ` (auto-switched → ${targetScope.resolved_project.name ?? targetScope.resolved_project.path})` : ''}`;
        const createContent = autoRepair
          ? [{ type: 'text' as const, text: createText }, { type: 'text' as const, text: renderAutoRepairWarning(autoRepair, actor ?? 'unknown') }]
          : [{ type: 'text' as const, text: createText }];
        return {
          response: toolResponse({
            content: createContent,
            structuredContent: {
              ...result,
              resolved_project: targetScope.resolved_project,
              active_source: autoSwitched ? 'auto_switch' : targetScope.active_source,
              ...(autoSwitched ? { auto_switched: true } : {}),
              ...(autoRepair ? { auto_repair: autoRepair } : {}),
            },
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
        const targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
        const targetScope = scopeMetadataForTarget(args, targetCwd, scopeInfo);
        const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        const result = updateEntity(entity, id, patch, targetCwd);
        appendAuditEntry(
          { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'update', item_id: id, item_type: entity },
          targetCwd,
        );
        const updateText = `✔ updated ${entity} ${id}`;
        const updateContent = auto_repair
          ? [{ type: 'text' as const, text: updateText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
          : [{ type: 'text' as const, text: updateText }];
        return {
          response: toolResponse({
            content: updateContent,
            structuredContent: {
              ...result,
              resolved_project: targetScope.resolved_project,
              active_source: targetScope.active_source,
              ...(auto_repair ? { auto_repair } : {}),
            },
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
        const targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
        const targetScope = scopeMetadataForTarget(args, targetCwd, scopeInfo);
        const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        const result = removeEntity(entity, id, targetCwd, purge);
        appendAuditEntry(
          { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'delete', item_id: id, item_type: entity, reason: purge ? 'purged' : 'archived' },
          targetCwd,
        );
        const removeText = `✔ removed ${entity} ${id}`;
        const removeContent = auto_repair
          ? [{ type: 'text' as const, text: removeText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
          : [{ type: 'text' as const, text: removeText }];
        return {
          response: toolResponse({
            content: removeContent,
            structuredContent: {
              ...result,
              resolved_project: targetScope.resolved_project,
              active_source: targetScope.active_source,
              ...(auto_repair ? { auto_repair } : {}),
            },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_move') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        const id = String(args.id ?? '');
        const toProject = String(args.to_project ?? '');
        const fromProject = typeof args.from_project === 'string' ? args.from_project : undefined;
        const force = args.force === true;
        const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        const result = relocateEntity({ entity, id, toProject, fromProject, force, cwd, actor: agent_name, actorId: agent_id });
        const warn = result.warnings.length ? ` (${result.warnings.length} warning(s))` : '';
        const moveText = `✔ moved ${entity} ${id} → ${result.to}${warn}`;
        const moveContent = auto_repair
          ? [{ type: 'text' as const, text: moveText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
          : [{ type: 'text' as const, text: moveText }];
        return {
          response: toolResponse({
            content: moveContent,
            structuredContent: {
              ...result,
              ...(auto_repair ? { auto_repair } : {}),
            },
          }),
        };
      } catch (error: unknown) {
        return { response: createToolErrorResponse('validation_error', (error as Error).message) };
      }
    }

    if (name === 'bclaw_transition') {
      try {
        const entity = String(args.entity ?? '') as EntityName;
        // Same auto-localize as bclaw_create: a workspace sibling named by
        // project=X is switched into and transitioned locally; only federated
        // links / unknown names are blocked (signaling-only boundary).
        let targetCwd: string;
        let autoSwitched = false;
        if (entity === 'claim' || entity === 'plan') {
          const loc = resolveExecutionWriteTarget(entity, args, cwd, connectionSessionId);
          if (loc.block) return { response: loc.block };
          targetCwd = loc.targetCwd;
          autoSwitched = loc.autoSwitched;
        } else {
          targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
        }
        const id = String(args.id ?? '');
        const to = String(args.to ?? '');
        const reason = args.reason as string | undefined;
        const targetScope = scopeMetadataForTarget(args, targetCwd, scopeInfo);
        const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
        // trp#928 — claim transitions consume the ReleaseClaimAuth ownership
        // check (released/stale both mutate a claim owned by SOME agent). Reuse
        // the same coordinator_override opt-in as bclaw_release_claim so both
        // paths have identical trust semantics and the same executable error.
        let transitionAuth: import('../core/entity-operations.js').TransitionAuth | undefined;
        if (entity === 'claim') {
          const transitionIdentity = resolveMutationIdentity(args, { nameField: 'agent', idField: 'agentId' }, targetCwd, connectionSessionId);
          const coordinatorOverrideRequested = args.coordinator_override === true;
          if (coordinatorOverrideRequested) {
            const identity = 'identity' in transitionIdentity ? transitionIdentity.identity : undefined;
            const trustLevel = identity?.trust_level ?? 'contributor';
            if (!hasMinimumTrustLevel(trustLevel, 'trusted')) {
              return {
                response: createToolErrorResponse(
                  'trust_error',
                  `coordinator_override:true requires trust_level 'trusted' or higher — caller is '${trustLevel}'.`,
                ),
              };
            }
          }
          transitionAuth = 'identity' in transitionIdentity && transitionIdentity.identity
            ? {
                agent: transitionIdentity.identity.agent_name,
                agent_id: transitionIdentity.identity.agent_id,
                session_id: connectionSessionId,
                override: coordinatorOverrideRequested,
              }
            : undefined;
        }
        const result = transitionEntity(entity, id, to, targetCwd, reason, transitionAuth);
        appendAuditEntry(
          { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'update', item_id: id, item_type: entity, reason: `transition ${result.from} → ${to}${reason ? ` (${reason})` : ''}` },
          targetCwd,
        );
        const transitionText = `✔ ${entity} ${id}: ${result.from} → ${to}${autoSwitched ? ` (auto-switched → ${targetScope.resolved_project.name ?? targetScope.resolved_project.path})` : ''}`;
        const transitionContent = auto_repair
          ? [{ type: 'text' as const, text: transitionText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
          : [{ type: 'text' as const, text: transitionText }];
        return {
          response: toolResponse({
            content: transitionContent,
            structuredContent: {
              ...result,
              resolved_project: targetScope.resolved_project,
              active_source: autoSwitched ? 'auto_switch' : targetScope.active_source,
              ...(autoSwitched ? { auto_switched: true } : {}),
              ...(auto_repair ? { auto_repair } : {}),
            },
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
