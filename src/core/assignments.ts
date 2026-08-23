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
import fs from 'node:fs';
import path from 'node:path';
import { AssignmentSchema, type Assignment, type AssignmentStatus, type AssignmentArtifact } from './schema.js';
import type { CapabilitySnapshot, ExecutionContractRef } from './execution-contract.js';
import { resolveOwnerProjectId } from './config.js';
import { entityRecordDirs, resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO, generateIdWithLabel } from './ids.js';
import { JsonStore } from './json-store.js';
import { appendAuditEntry } from './audit.js';
import { appendEvent } from './event-log.js';
import { createRuntimeEvent } from './events.js';
import { emitRegistryPostImage, emitRegistryTombstone, registryFaultPoint } from './events/registry-post-image.js';
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

function assignmentStoreForDir(dirPath: string): JsonStore<Assignment> {
  return new JsonStore<Assignment>({
    dirPath,
    documentType: 'assignment',
    getId: (a) => a.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

// NOTE: there is deliberately no single-directory reader left in this module. A helper that
// resolved ONE dir via the `hasContent` heuristic is what made a legacy record invisible to
// the list while the by-id loader could see it; removing it means the next reader cannot
// reintroduce the asymmetry by reaching for the convenient function.

// ── CRUD ─────────────────────────────────────────────────────

export function saveAssignment(assignment: Assignment, cwd?: string): void {
  mutate({ cwd }, () => {
    saveAssignmentUnlocked(assignment, cwd);
  });
}

/** Store-lock caller variant used by create-or-validate projection repair. */
function saveAssignmentUnlocked(assignment: Assignment, cwd?: string): void {
  ensureAssignmentsDir(cwd);
  const store = new JsonStore<Assignment>({
    dirPath: assignmentsDir(cwd, 'write'),
    documentType: 'assignment',
    getId: (a) => a.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
  const parsed = AssignmentSchema.parse(assignment);
  // pln#568 (I2): journal the post-image BEFORE the projection write.
  const created = !store.exists(parsed.id);
  emitRegistryPostImage('assignment', parsed, { created, agent: parsed.agent, agent_id: parsed.agent_id, session_id: parsed.session_id, cwd });
  registryFaultPoint('after_registry_journal');
  store.save(parsed);
  // CONVERGE THE OTHER LAYOUT, exactly as saveClaim does. Without this, a save wrote
  // canonical and LEFT a legacy copy holding the stale status: `loadAssignment` reads
  // canonical first so the record looked right, but `deleteAssignment` removed only the
  // canonical one and the stale copy became the record again — a zombie resurrection.
  // Best effort on purpose: `listAssignments` reads both dirs, so a missed cleanup stays
  // visible rather than silently dropping data. (Fable audit; claims.ts already had it.)
  const writeDir = assignmentsDir(cwd, 'write');
  for (const dirPath of entityRecordDirs('assignments', cwd ?? process.cwd())) {
    if (dirPath === writeDir) continue;
    const legacyPath = path.join(dirPath, `${parsed.id}.json`);
    try {
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch { /* best effort — the dual-layout list keeps it visible */ }
  }
}

export function loadAssignment(id: string, cwd?: string): Assignment | undefined {
  // JsonStore.load throws when the id is missing; honor the declared
  // "| undefined" return type so callers (e.g. transitionAssignment)
  // can emit their own 'Assignment not found' error with the right wording.
  //
  // RECORD-SPECIFIC ACROSS BOTH LAYOUTS (pln#649 step 3 review P1-2, reproduced).
  // `assignmentStore` resolves a DIRECTORY via resolveEntityDir(..., 'read'), which
  // picks the canonical one as soon as it holds ANY file — so in a store
  // mid-migration a legacy `assignments/asgn_x.json` was invisible even though the
  // step-2 locator had just found it. Locator said `found`, this said `not found`:
  // the same defect one layer down. Asking "where is THIS record" needs both
  // layouts, exactly as recordPaths does in the locator.
  for (const dirPath of entityRecordDirs('assignments', cwd ?? process.cwd())) {
    try {
      return new JsonStore<Assignment>({
        dirPath,
        documentType: 'assignment',
        getId: (a) => a.id,
        sort: (a, b) => a.created_at.localeCompare(b.created_at),
      }).load(id);
    } catch { /* not in this layout — try the other */ }
  }
  return undefined;
}

export interface ListAssignmentsFilter {
  status?: AssignmentStatus;
  agent?: string;
  claim_id?: string;
  plan_id?: string;
  sequence_id?: string;
}

/**
 * BOTH LAYOUTS, canonical winning on a duplicate id (mirrors listClaims).
 *
 * The by-id loader was fixed to read both layouts while this list still read ONE
 * directory, chosen by the `hasContent` heuristic — so three layers gave three answers
 * about the same store. The concrete consequence: a legacy run/assignment invisible to
 * the list while visible by id, which lets `nextAttemptIndex` restart at 1 and collide,
 * and makes `getActiveAssignmentForAgent` miss a live assignment so the worker's implicit
 * heartbeat stops proving liveness. Reachability is LOW (assignments postdate the
 * partitioned layout, so brainclaw has never written them flat — measured: legacy=0 in
 * the field), which is why this is internal consistency rather than a field fix.
 */
export function listAssignments(cwd?: string, filter?: ListAssignmentsFilter): Assignment[] {
  const byId = new Map<string, Assignment>();
  for (const dirPath of entityRecordDirs('assignments', cwd ?? process.cwd())) {
    for (const a of assignmentStoreForDir(dirPath).list()) {
      if (!byId.has(a.id)) byId.set(a.id, a);
    }
  }
  let items = Array.from(byId.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (filter?.status) items = items.filter((a) => a.status === filter.status);
  if (filter?.agent) items = items.filter((a) => a.agent === filter.agent);
  if (filter?.claim_id) items = items.filter((a) => a.claim_id === filter.claim_id);
  if (filter?.plan_id) items = items.filter((a) => a.plan_id === filter.plan_id);
  if (filter?.sequence_id) items = items.filter((a) => a.sequence_id === filter.sequence_id);
  return items;
}

/**
 * Deletes the record in EVERY layout, not just the canonical one.
 *
 * Checking only the write dir meant a record `loadAssignment` could find returned `false`
 * from delete — and worse, deleting the canonical copy of a dual-layout record promoted
 * the stale legacy copy back to being the record. Deleting one layout is not deleting.
 */
export function deleteAssignment(id: string, cwd?: string): boolean {
  return mutate({ cwd }, () => {
    const dirs = entityRecordDirs('assignments', cwd ?? process.cwd());
    const holders = dirs.filter((dirPath) => assignmentStoreForDir(dirPath).exists(id));
    if (holders.length === 0) {
      return false;
    }
    // One tombstone for the record, from the copy that wins reads.
    const assignment = assignmentStoreForDir(holders[0]).load(id);
    emitRegistryTombstone('assignment', assignment.id, { agent: assignment.agent, agent_id: assignment.agent_id, session_id: assignment.session_id, cwd });
    registryFaultPoint('after_registry_journal');
    for (const dirPath of holders) {
      try {
        assignmentStoreForDir(dirPath).delete(id);
      } catch { /* another layout already gone — the remaining ones still must go */ }
    }
    return true;
  });
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

interface InternalTransitionOptions extends TransitionOptions {
  /**
   * Bypass FSM validation only for the narrow pln#563 system convergence path.
   * Kept out of the public TransitionOptions surface so arbitrary callers
   * cannot opt out of the assignment FSM.
   */
  systemConvergence?: true;
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
  return transitionAssignmentInternal(id, newStatus, options, cwd);
}

function transitionAssignmentInternal(
  id: string,
  newStatus: AssignmentStatus,
  options: InternalTransitionOptions,
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

  if (options.systemConvergence) {
    const validation = validateSystemConvergence(assignment.status, newStatus, options.actor);
    if (!validation.valid) {
      throw new Error(validation.reason);
    }
  } else {
    const validation = validateTransition(assignment.status, newStatus);
    if (!validation.valid) {
      throw new Error(validation.reason);
    }
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
  // NO project_id here, deliberately (review P1-1). The owner is ALWAYS derived
  // from the store this assignment is written into. An override could save the
  // record in store A while declaring owner B — and step 4 would then read that
  // as a divergence and refuse a correctly routed mutation. A forgeable owner is
  // worse than no owner.
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
  execution_contract_ref?: ExecutionContractRef;
  capability_snapshot?: CapabilitySnapshot;
  heartbeat_ttl_ms?: number;
  acceptance_ttl_ms?: number;
  max_retries?: number;
  tags?: string[];
}

/**
 * Create a new assignment. Called by the dispatcher after creating a claim
 * and sending an inbox message.
 */
function buildAssignment(options: CreateAssignmentOptions, cwd?: string): Assignment {
  const generated = options.id ? undefined : generateAssignmentId(cwd);
  const id = options.id ?? generated!.id;
  // `generated` is undefined whenever the caller supplied an id, so the old
  // `generated!.short_label` threw a TypeError on the perfectly reasonable call
  // "give me this id, derive the rest". Found while pinning the layout primitive.
  const short_label = options.short_label ?? generated?.short_label ?? id;

  return AssignmentSchema.parse({
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
    // OWNER project, captured HERE in core (pln#649 step 1) rather than in the
    // command layer: every caller — MCP, CLI, dispatcher, loop engine — writes
    // into `cwd`, so deriving it here means no path can create an assignment
    // without an owner. The claim surface does this in TWO command-layer sites
    // that already disagree (mcp-write-claims.ts uses loadConfig(claimCwd),
    // claim.ts uses actor.project_id); core is the one place that cannot drift.
    project_id: resolveOwnerProjectId(cwd),
    scope: options.scope,
    description: options.description,
    lane: options.lane,
    worktree_path: options.worktree_path,
    execution_contract_ref: options.execution_contract_ref,
    capability_snapshot: options.capability_snapshot,
    status: 'created',
    created_at: nowISO(),
    heartbeat_ttl_ms: options.heartbeat_ttl_ms,
    acceptance_ttl_ms: options.acceptance_ttl_ms,
    max_retries: options.max_retries,
    retry_count: 0,
    artifacts: [],
    tags: options.tags ?? [],
  });
}

function emitAssignmentCreatedSideEffects(
  assignment: Assignment,
  options: CreateAssignmentOptions,
  cwd?: string,
): void {
  emitAssignmentEvent(assignment, 'assignment_created', options.dispatcher_agent, cwd);
  appendAuditEntry({
    actor: options.dispatcher_agent,
    action: 'create',
    item_id: assignment.id,
    item_type: 'assignment',
    after: { agent: options.agent, scope: options.scope, claim_id: options.claim_id },
  }, cwd);
}

export function createAssignment(options: CreateAssignmentOptions, cwd?: string): Assignment {
  const assignment = buildAssignment(options, cwd);

  saveAssignment(assignment, cwd);
  emitAssignmentCreatedSideEffects(assignment, options, cwd);

  return assignment;
}

export class AssignmentProjectionConflictError extends Error {
  constructor(public readonly assignmentId: string, detail: string) {
    super(`Assignment projection conflict for ${assignmentId}: ${detail}`);
    this.name = 'AssignmentProjectionConflictError';
  }
}

export interface EnsureAssignmentProjectionResult {
  assignment: Assignment;
  created: boolean;
  repaired?: boolean;
}

const TERMINAL_PROJECTION_ASSIGNMENT_STATUSES = new Set<AssignmentStatus>([
  'completed', 'cancelled', 'failed', 'blocked', 'timed_out', 'expired', 'rerouted',
]);

function assertAssignmentProjectionMatches(
  existing: Assignment,
  expected: Assignment,
): void {
  const fields: Array<keyof Assignment> = [
    'id', 'claim_id', 'agent', 'dispatcher_agent', 'scope', 'description',
  ];
  for (const field of fields) {
    if (existing[field] !== expected[field]) {
      throw new AssignmentProjectionConflictError(
        expected.id,
        `${String(field)} differs (existing=${String(existing[field])}, expected=${String(expected[field])})`,
      );
    }
  }
  // project_id was added after the entity shipped. An absent legacy owner remains readable;
  // when present it must identify the same authoritative store.
  if (existing.project_id !== undefined && existing.project_id !== expected.project_id) {
    throw new AssignmentProjectionConflictError(expected.id, 'project_id differs');
  }
  // Turn-owned Assignments created before P0B did not persist agent_id. Accept and
  // enrich that legacy omission when the named agent still matches; a present,
  // divergent identity remains a hard conflict.
  if (existing.agent_id !== undefined && existing.agent_id !== expected.agent_id) {
    throw new AssignmentProjectionConflictError(expected.id, 'agent_id differs');
  }
  if (
    existing.execution_contract_ref !== undefined
    && expected.execution_contract_ref !== undefined
    && JSON.stringify(existing.execution_contract_ref) !== JSON.stringify(expected.execution_contract_ref)
  ) {
    throw new AssignmentProjectionConflictError(expected.id, 'execution_contract_ref differs');
  }
  if (
    existing.capability_snapshot !== undefined
    && expected.capability_snapshot !== undefined
    && JSON.stringify(existing.capability_snapshot) !== JSON.stringify(expected.capability_snapshot)
  ) {
    throw new AssignmentProjectionConflictError(expected.id, 'capability_snapshot differs');
  }
  if (TERMINAL_PROJECTION_ASSIGNMENT_STATUSES.has(existing.status)) {
    throw new AssignmentProjectionConflictError(expected.id, `existing status is terminal (${existing.status})`);
  }
}

/**
 * Create-or-validate the deterministic Assignment projection for one logical turn.
 *
 * The read/decision/write sequence is serialized by the store lock. Identical recovery is
 * a strict no-op (no registry/runtime/audit duplicate); any divergent projection fails closed.
 */
export function ensureAssignmentProjection(
  options: CreateAssignmentOptions & { id: string },
  cwd?: string,
): EnsureAssignmentProjectionResult {
  let created = false;
  let repaired = false;
  const expected = buildAssignment(options, cwd);
  const assignment = mutate({ cwd }, () => {
    const existing = loadAssignment(options.id, cwd);
    if (existing) {
      assertAssignmentProjectionMatches(existing, expected);
      const requiredTags = options.tags ?? [];
      const missingAgentId = existing.agent_id === undefined && expected.agent_id !== undefined;
      const missingContractRef = existing.execution_contract_ref === undefined && expected.execution_contract_ref !== undefined;
      const missingCapabilitySnapshot = existing.capability_snapshot === undefined && expected.capability_snapshot !== undefined;
      const missingTags = !requiredTags.every((tag) => existing.tags.includes(tag));
      if (!missingAgentId && !missingContractRef && !missingCapabilitySnapshot && !missingTags) return existing;
      const enriched = AssignmentSchema.parse({
        ...existing,
        ...(missingAgentId ? { agent_id: expected.agent_id } : {}),
        ...(missingContractRef ? { execution_contract_ref: expected.execution_contract_ref } : {}),
        ...(missingCapabilitySnapshot ? { capability_snapshot: expected.capability_snapshot } : {}),
        tags: [...new Set([...existing.tags, ...requiredTags])],
        updated_at: nowISO(),
      });
      saveAssignmentUnlocked(enriched, cwd);
      repaired = true;
      return enriched;
    }
    saveAssignmentUnlocked(expected, cwd);
    created = true;
    return expected;
  });
  if (created) emitAssignmentCreatedSideEffects(assignment, options, cwd);
  return { assignment, created, ...(repaired ? { repaired: true } : {}) };
}

// ── Active Assignment Lookup ─────────────────────────────────

/** Statuses that indicate a finished assignment (no longer active). */
const TERMINAL_STATUSES = new Set<AssignmentStatus>(['completed', 'cancelled', 'expired', 'rerouted']);

/**
 * Statuses a file-based worker leaves an assignment stuck in — it never calls
 * bclaw_assignment_update, so the assignment never advances past these (pln#563).
 * These are the only states a system convergence (loop-close cascade / lazy
 * reconciler) fast-forwards; failed/blocked/timed_out carry real signal and are
 * left alone.
 */
const CONVERGEABLE_STATUSES = new Set<AssignmentStatus>(['offered', 'accepted', 'started']);

function validateSystemConvergence(
  from: AssignmentStatus,
  to: AssignmentStatus,
  actor?: string,
): TransitionValidation {
  if (actor !== 'system') {
    return { valid: false, reason: 'System convergence must be performed by actor=system' };
  }
  if (!CONVERGEABLE_STATUSES.has(from) || (to !== 'completed' && to !== 'cancelled')) {
    return { valid: false, reason: `Invalid system convergence: ${from} → ${to}` };
  }
  return { valid: true };
}

/**
 * Force a stuck assignment to a terminal status as a SYSTEM convergence
 * (pln#563). No-op (returns false) if the assignment is missing or not in a
 * convergeable state, so callers can fire it best-effort. Used by the loop-close
 * cascade and the lazy orphan reconciler.
 */
export function convergeAssignmentToTerminal(
  id: string,
  terminal: 'completed' | 'cancelled',
  reason: string,
  cwd?: string,
): boolean {
  const assignment = loadAssignment(id, cwd);
  if (!assignment || !CONVERGEABLE_STATUSES.has(assignment.status)) return false;
  transitionAssignmentInternal(id, terminal, {
    actor: 'system',
    status_reason: reason,
    systemConvergence: true,
  }, cwd);
  return true;
}

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
