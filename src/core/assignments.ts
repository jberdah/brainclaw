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
  return assignmentStore(cwd).load(id);
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

// ── ID Generation ────────────────────────────────────────────

export function generateAssignmentId(cwd?: string): { id: string; short_label: string } {
  return generateIdWithLabel('assignments', cwd);
}

// ── Status FSM ───────────────────────────────────────────────

/** Valid transitions: from → Set<to>. */
const VALID_TRANSITIONS = new Map<string, Set<string>>([
  ['created',   new Set(['offered'])],
  ['offered',   new Set(['accepted', 'expired'])],
  ['accepted',  new Set(['started', 'timed_out'])],
  ['started',   new Set(['completed', 'failed', 'blocked', 'timed_out'])],
  ['failed',    new Set(['retrying'])],
  ['timed_out', new Set(['retrying'])],
  ['retrying',  new Set(['offered'])],
  ['blocked',   new Set(['rerouted'])],
  // Terminal: completed, expired, rerouted (no outgoing transitions)
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
  /** Actor performing the transition (agent name or dispatcher). */
  actor?: string;
  actor_id?: string;
}

export interface TransitionResult {
  assignment: Assignment;
  previous_status: AssignmentStatus;
}

/**
 * Transition an assignment to a new status with FSM validation.
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

  const validation = validateTransition(assignment.status, newStatus);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const previous_status = assignment.status;
  const now = nowISO();

  // Update status
  assignment.status = newStatus;
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
    case 'failed':    assignment.failed_at = now; break;
  }

  saveAssignment(assignment, cwd);
  emitAssignmentEvent(assignment, `assignment_${newStatus}`, options.actor, cwd);

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

  assignment.last_heartbeat_at = nowISO();
  if (options.message) assignment.status_reason = options.message;
  if (options.artifacts?.length) {
    assignment.artifacts = [...assignment.artifacts, ...options.artifacts];
  }

  saveAssignment(assignment, cwd);
  emitAssignmentEvent(assignment, 'assignment_progress', options.actor, cwd);

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
  appendEvent({
    ts: nowISO(),
    agent: actor ?? assignment.agent,
    agent_id: assignment.agent_id,
    action: action as import('./event-log.js').EventAction,
    item_type: 'assignment',
    item_id: assignment.id,
    summary: `${assignment.status}: ${assignment.description.slice(0, 80)}`,
  }, cwd);
}
