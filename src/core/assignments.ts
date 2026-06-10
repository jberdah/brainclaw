/**
 * Assignment lifecycle — Agent SDK runtime protocol.
 *
 * An Assignment is the canonical coordination entity that tracks the full
 * lifecycle of dispatched work: from creation through offer, acceptance,
 * execution, and completion (or failure/timeout/reroute).
 *
 * Assignments reference Claims (scope lock) and InboxMessages (brief delivery)
 * but don't replace them. They own the status FSM and heartbeat tracking.
 *
 * @module
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AssignmentSchema, type Assignment, type AssignmentStatus, type AssignmentArtifact } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO, generateIdWithLabel } from './ids.js';
import { JsonStore } from './json-store.js';
import { appendAuditEntry } from './audit.js';
import { appendEvent } from './event-log.js';
import { createRuntimeEvent } from './events.js';
import { findLatestAgentRunForAssignment, recordAgentRunProgress, syncAgentRunFromAssignmentTransition } from './agentruns.js';

// ── Directory / Store ────────────────────────────────────────

function assignmentsDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('assignments', cwd, mode);
}

function ensureAssignmentsDir(cwd?: string): void {
  const dir = assignmentsDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function assignmentStore(cwd?: string): JsonStore<Assignment> {
  return new JsonStore<Assignment>({
    dirPath: assignmentsDir(cwd, 'read'),
    documentType: 'assignment',
    getId: (a) => a.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

// ── CRUD ─────────────────────────────────────────────────────

export function saveAssignment(assignment: Assignment, cwd?: string): void {
  mutate({ cwd }, () => {
    ensureAssignmentsDir(cwd);
    const store = new JsonStore<Assignment>({
      dirPath: assignmentsDir(cwd, 'write'),
      documentType: 'assignment',
      getId: (a) => a.id,
      sort: (a, b) => a.created_at.localeCompare(b.created_at),
    });
    store.save(AssignmentSchema.parse(assignment));
  });
}

export function loadAssignment(id: string, cwd?: string): Assignment | undefined {
  // JsonStore.load throws when the id is missing; honor the declared
  // "| undefined" return type so callers (e.g. transitionAssignment)
  // can emit their own 'Assignment not found' error with the right wording.
  try {
    return assignmentStore(cwd).load(id);
  } catch {
    return undefined;
  }
}

export interface ListAssignmentsFilter {
  status?: AssignmentStatus;
  agent?: string;
  claim_id?: string;
  plan_id?: string;
  sequence_id?: string;
}

export function listAssignments(cwd?: string, filter?: ListAssignmentsFilter): Assignment[] {
  let items = assignmentStore(cwd).list();
  if (filter?.status) items = items.filter((a) => a.status === filter.status);
  if (filter?.agent) items = items.filter((a) => a.agent === filter.agent);
  if (filter?.claim_id) items = items.filter((a) => a.claim_id === filter.claim_id);
  if (filter?.plan_id) items = items.filter((a) => a.plan_id === filter.plan_id);
  if (filter?.sequence_id) items = items.filter((a) => a.sequence_id === filter.sequence_id);
  return items;
}

export function deleteAssignment(id: string, cwd?: string): boolean {
  const store = assignmentStore(cwd);
  if (!store.exists(id)) {
    return false;
  }
  mutate({ cwd }, () => {
    const writableStore = new JsonStore<Assignment>({
      dirPath: assignmentsDir(cwd, 'write'),
      documentType: 'assignment',
      getId: (a) => a.id,
      sort: (a, b) => a.created_at.localeCompare(b.created_at),
    });
    writableStore.delete(id);
  });
  return true;
}

// ── ID Generation ────────────────────────────────────────────

export function generateAssignmentId(cwd?: string): { id: string; short_label: string } {
  return generateIdWithLabel('assignments', cwd);
}

// ── Status FSM ───────────────────────────────────────────────

/** Valid transitions: from → Set<to>.
 *
 * `rerouted` is reachable from every non-terminal state (pln#451 / trp#61):
 * rerouting a claim must close the predecessor assignment regardless of where
 * it was in the FSM. Previously only `blocked` could reach `rerouted`, which
 * left assignments stuck in `created` or `offered` when the coordinator
 * rerouted a still-unstarted lane.
 */
const VALID_TRANSITIONS = new Map<string, Set<string>>([
  ['created',   new Set(['offered', 'rerouted', 'cancelled'])],
  ['offered',   new Set(['accepted', 'failed', 'expired', 'rerouted', 'cancelled'])],
  ['accepted',  new Set(['started', 'timed_out', 'rerouted', 'cancelled'])],
  ['started',   new Set(['completed', 'failed', 'blocked', 'timed_out', 'rerouted', 'cancelled'])],
  ['failed',    new Set(['retrying', 'rerouted', 'cancelled'])],
  ['timed_out', new Set(['retrying', 'rerouted', 'cancelled'])],
  ['retrying',  new Set(['offered', 'rerouted', 'cancelled'])],
  ['blocked',   new Set(['rerouted', 'started', 'failed', 'cancelled'])],
  // can_948acfd6: evidence can arrive AFTER an administrative expiry — the
  // worker was alive all along but never acked (sandboxed, no MCP), and its
  // commit / LANE-RESULT surfaced later. Allow the late convergence so
  // harvest/reconcile can record the truth instead of being FSM-blocked.
  ['expired',   new Set(['completed'])],
  // Terminal: completed, cancelled, rerouted (no outgoing transitions)
]);

export interface TransitionValidation {
  valid: boolean;
  reason?: string;
}

export function validateTransition(from: AssignmentStatus, to: AssignmentStatus): TransitionValidation {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    return { valid: false, reason: `Invalid transition: ${from} → ${to}` };
  }
  return { valid: true };
}

// ── Transition Engine ────────────────────────────────────────

export interface TransitionOptions {
  session_id?: string;
  status_reason?: string;
  artifacts?: AssignmentArtifact[];
  error_message?: string;
  /** Disable AgentRun sync when the caller is managing a specific run attempt. */
  syncAgentRun?: boolean;
  /** Actor performing the transition (agent name or dispatcher). */
  actor?: string;
  actor_id?: string;
}

export interface TransitionResult {
  assignment: Assignment;
  previous_status: AssignmentStatus;
  /** True when the transition was a same-status no-op (idempotent retry). */
  idempotent?: boolean;
}

/**
 * Transition an assignment to a new status with FSM validation.
 * Same-status transitions are idempotent no-ops (returns current state
 * with idempotent=true instead of throwing). This handles network retries
 * where a worker calls accepted/started again after a timeout.
 * Updates relevant timestamps, emits event and audit entry.
 */
export function transitionAssignment(
  id: string,
  newStatus: AssignmentStatus,
  options: TransitionOptions,
  cwd?: string,
): TransitionResult {
  const assignment = loadAssignment(id, cwd);
  if (!assignment) {
    throw new Error(`Assignment not found: ${id}`);
  }

  // Idempotent: same-status transition is a no-op (handles network retries)
  if (assignment.status === newStatus) {
    // Still update heartbeat for liveness tracking
    assignment.last_heartbeat_at = nowISO();
    assignment.updated_at = assignment.last_heartbeat_at;
    saveAssignment(assignment, cwd);
    return { assignment, previous_status: newStatus, idempotent: true };
  }

  const validation = validateTransition(assignment.status, newStatus);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const previous_status = assignment.status;
  const now = nowISO();

  // Update status
  assignment.status = newStatus;
  assignment.updated_at = now;
  assignment.last_heartbeat_at = now;
  if (options.status_reason) assignment.status_reason = options.status_reason;
  if (options.session_id) assignment.session_id = options.session_id;
  if (options.error_message) assignment.error_message = options.error_message;
  if (options.artifacts?.length) {
    assignment.artifacts = [...assignment.artifacts, ...options.artifacts];
  }

  // Set transition-specific timestamps
  switch (newStatus) {
    case 'offered':   assignment.offered_at = now; break;
    case 'accepted':  assignment.accepted_at = now; break;
    case 'started':   assignment.started_at = now; break;
    case 'completed': assignment.completed_at = now; break;
    case 'cancelled': assignment.cancelled_at = now; break;
    case 'failed':    assignment.failed_at = now; break;
    case 'blocked':   assignment.blocked_at = now; break;
    case 'timed_out': assignment.timed_out_at = now; break;
    case 'expired':   assignment.expired_at = now; break;
    case 'rerouted':  assignment.rerouted_at = now; break;
  }

  saveAssignment(assignment, cwd);
  emitAssignmentEvent(assignment, `assignment_${newStatus}`, options.actor, cwd);
  if (options.syncAgentRun !== false) {
    try {
      syncAgentRunFromAssignmentTransition(assignment, newStatus, {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason,
        artifacts: options.artifacts,
        error_message: options.error_message,
      }, cwd);
    } catch {
      /* best-effort: run state should not break assignment lifecycle */
    }
  }

  appendAuditEntry({
    actor: options.actor ?? assignment.agent,
    actor_id: options.actor_id,
    action: 'update',
    item_id: assignment.id,
    item_type: 'assignment',
    before: { status: previous_status },
    after: { status: newStatus, reason: options.status_reason },
    scope: assignment.scope,
    session_id: options.session_id,
  }, cwd);

  return { assignment, previous_status };
}

// ── Progress (heartbeat without status change) ───────────────

export interface ProgressOptions {
  message?: string;
  artifacts?: AssignmentArtifact[];
  actor?: string;
  actor_id?: string;
  session_id?: string;
}

/**
 * Record progress on a started assignment (heartbeat).
 * Updates last_heartbeat_at without changing status.
 */
export function recordProgress(
  id: string,
  options: ProgressOptions,
  cwd?: string,
): Assignment {
  const assignment = loadAssignment(id, cwd);
  if (!assignment) {
    throw new Error(`Assignment not found: ${id}`);
  }
  if (assignment.status !== 'started') {
    throw new Error(`Cannot record progress: assignment ${id} is ${assignment.status}, expected started`);
  }

  const now = nowISO();
  assignment.last_heartbeat_at = now;
  assignment.updated_at = now;
  if (options.message) assignment.status_reason = options.message;
  if (options.artifacts?.length) {
    assignment.artifacts = [...assignment.artifacts, ...options.artifacts];
  }

  saveAssignment(assignment, cwd);
  emitAssignmentEvent(assignment, 'assignment_progress', options.actor, cwd);
  try {
    const latestRun = findLatestAgentRunForAssignment(assignment.id, cwd);
    if (latestRun) {
      recordAgentRunProgress(latestRun.id, {
        message: options.message,
        artifacts: options.artifacts,
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
      }, cwd);
    }
  } catch {
    /* best-effort */
  }

  return assignment;
}

// ── Assignment Creation (called by dispatcher) ───────────────

export interface CreateAssignmentOptions {
  /** Pre-generated ID (from generateAssignmentId). Auto-generated if omitted. */
  id?: string;
  /** Pre-generated short label. Auto-generated if omitted. */
  short_label?: string;
  claim_id: string;
  message_id?: string;
  plan_id?: string;
  sequence_id?: string;
  correlation_id?: string;
  agent: string;
  agent_id?: string;
  dispatcher_agent: string;
  dispatcher_session_id?: string;
  scope: string;
  description: string;
  lane?: string;
  worktree_path?: string;
  heartbeat_ttl_ms?: number;
  acceptance_ttl_ms?: number;
  max_retries?: number;
  tags?: string[];
}

/**
 * Create a new assignment. Called by the dispatcher after creating a claim
 * and sending an inbox message.
 */
export function createAssignment(options: CreateAssignmentOptions, cwd?: string): Assignment {
  const generated = options.id ? undefined : generateAssignmentId(cwd);
  const id = options.id ?? generated!.id;
  const short_label = options.short_label ?? generated!.short_label;

  const assignment: Assignment = AssignmentSchema.parse({
    schema_version: 1,
    id,
    short_label,
    claim_id: options.claim_id,
    message_id: options.message_id,
    plan_id: options.plan_id,
    sequence_id: options.sequence_id,
    correlation_id: options.correlation_id,
    agent: options.agent,
    agent_id: options.agent_id,
    dispatcher_agent: options.dispatcher_agent,
    dispatcher_session_id: options.dispatcher_session_id,
    scope: options.scope,
    description: options.description,
    lane: options.lane,
    worktree_path: options.worktree_path,
    status: 'created',
    created_at: nowISO(),
    heartbeat_ttl_ms: options.heartbeat_ttl_ms,
    acceptance_ttl_ms: options.acceptance_ttl_ms,
    max_retries: options.max_retries,
    retry_count: 0,
    artifacts: [],
    tags: options.tags ?? [],
  });

  saveAssignment(assignment, cwd);
  emitAssignmentEvent(assignment, 'assignment_created', options.dispatcher_agent, cwd);

  appendAuditEntry({
    actor: options.dispatcher_agent,
    action: 'create',
    item_id: assignment.id,
    item_type: 'assignment',
    after: { agent: options.agent, scope: options.scope, claim_id: options.claim_id },
  }, cwd);

  return assignment;
}

// ── Active Assignment Lookup ─────────────────────────────────

/** Statuses that indicate a finished assignment (no longer active). */
const TERMINAL_STATUSES = new Set<AssignmentStatus>(['completed', 'cancelled', 'expired', 'rerouted']);

/**
 * Return the most recently created non-terminal assignment for the given agent.
 * When `claimId` is provided, it is used as a fast-path lookup before falling
 * back to an agent-wide scan.
 */
export function getActiveAssignmentForAgent(
  agentId: string,
  cwd?: string,
  claimId?: string,
): Assignment | undefined {
  if (claimId) {
    const byClaim = listAssignments(cwd, { claim_id: claimId });
    const active = byClaim.filter((a) => !TERMINAL_STATUSES.has(a.status));
    // listAssignments returns ascending-by-created_at — last is most recent
    if (active.length > 0) return active[active.length - 1];
  }
  if (!agentId) return undefined;
  const all = listAssignments(cwd);
  const active = all.filter((a) => a.agent_id === agentId && !TERMINAL_STATUSES.has(a.status));
  return active.length > 0 ? active[active.length - 1] : undefined;
}

/**
 * Bump `last_heartbeat_at` on the most recent active assignment for the given
 * claim (or agent). Best-effort — throws are suppressed by the caller.
 */
export function bumpActiveAssignmentHeartbeat(
  claimId: string | undefined,
  agentId: string | undefined,
  cwd?: string,
): boolean {
  const assignment = getActiveAssignmentForAgent(agentId ?? '', cwd, claimId);
  if (!assignment) return false;
  const now = nowISO();
  assignment.last_heartbeat_at = now;
  assignment.updated_at = now;
  saveAssignment(assignment, cwd);
  return true;
}

// ── Post-creation patches ────────────────────────────────────

/** Attach the inbox message_id after the message has been sent (message is created after assignment). */
export function patchAssignmentMessageId(id: string, messageId: string, cwd?: string): void {
  const assignment = loadAssignment(id, cwd);
  if (!assignment) return;
  assignment.message_id = messageId;
  saveAssignment(assignment, cwd);
}

// ── Event Emission ───────────────────────────────────────────

function emitAssignmentEvent(
  assignment: Assignment,
  action: string,
  actor?: string,
  cwd?: string,
): void {
  const text = `${assignment.description} [${assignment.status}]${assignment.status_reason ? ` — ${assignment.status_reason}` : ''}`;
  appendEvent({
    ts: nowISO(),
    agent: actor ?? assignment.agent,
    agent_id: assignment.agent_id,
    action: action as import('./event-log.js').EventAction,
    item_type: 'assignment',
    item_id: assignment.id,
    summary: `${assignment.status}: ${assignment.description.slice(0, 80)}`,
  }, cwd);
  try {
    createRuntimeEvent({
      agent: actor ?? assignment.agent,
      agent_id: assignment.agent_id,
      project_id: undefined,
      session_id: assignment.session_id,
      event_type: action as import('./schema.js').RuntimeEvent['event_type'],
      text,
      tags: ['agent-runtime', 'assignment'],
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      message_id: assignment.message_id,
      plan_id: assignment.plan_id,
      sequence_id: assignment.sequence_id,
      correlation_id: assignment.correlation_id,
      scope: assignment.scope,
      status: assignment.status,
      status_reason: assignment.status_reason,
      related_paths: [assignment.scope],
      metadata: {
        dispatcher_agent: assignment.dispatcher_agent,
        protocol: 'brainclaw.agent_runtime.v0',
      },
    }, cwd);
  } catch {
    /* best-effort: runtime event emission should not break assignment lifecycle */
  }
}
