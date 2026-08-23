/**
 * AgentRun lifecycle — concrete execution attempts for an Assignment.
 *
 * Assignment stays the business coordination object.
 * AgentRun tracks one concrete launch / pickup / retry attempt.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { AgentRunSchema, type AgentRun, type AgentRunStatus, type AgentRunTransport, type Assignment, type AssignmentArtifact } from './schema.js';
import { RuntimeCapabilityObservationSchema, type CapabilitySnapshot, type ExecutionContractRef, type RuntimeCapabilityObservation } from './execution-contract.js';
import { resolveOwnerProjectId } from './config.js';
import { entityRecordDirs, resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO, generateIdWithLabel } from './ids.js';
import { JsonStore } from './json-store.js';
import { appendAuditEntry } from './audit.js';
import { appendEvent } from './event-log.js';
import { createRuntimeEvent } from './events.js';
import { emitRegistryPostImage, registryFaultPoint } from './events/registry-post-image.js';
import { findReservationByRunId } from './loops/attempt-reservation.js';
import { resolveTurnGenerationChain } from './loops/attempt-generations.js';

export class AgentRunFencedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly activeRunId: string | null,
    public readonly attemptEpoch: number,
    public readonly authorityStatus: 'active' | 'settled' | 'cancelled',
  ) {
    super(
      `AgentRun ${runId} is fenced by attempt epoch ${attemptEpoch}`
      + `${activeRunId ? ` (authoritative run: ${activeRunId})` : ''}`
      + ` [${authorityStatus}]`,
    );
    this.name = 'AgentRunFencedError';
  }
}

/**
 * Refuse late writes from an AgentRun superseded by attempt-authority v2.
 *
 * The immutable generation chain is authoritative; assignment status and the
 * mutable head projection are deliberately not consulted. A settled latest
 * generation may still finish its replayable projections after publishing its
 * close cell. Controllers may explicitly override this guard only to project a
 * terminal state onto the run that they just fenced.
 */
function assertAgentRunMutationAllowed(id: string, cwd?: string, allowFencedProjection = false): void {
  if (allowFencedProjection) return;
  const reservation = findReservationByRunId(id, cwd);
  if (!reservation) return;
  const chain = resolveTurnGenerationChain(reservation.store_root, reservation.turn_id);
  if (!chain) return; // Legacy attempt authority remains compatible.
  const latest = chain.latest_generation;
  if (latest.run_id === id && (chain.status === 'active' || chain.status === 'settled')) return;
  throw new AgentRunFencedError(
    id,
    chain.status === 'active' ? latest.run_id : null,
    latest.attempt_epoch,
    chain.status,
  );
}

function agentRunsDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('runs', cwd, mode);
}

function ensureAgentRunsDir(cwd?: string): void {
  const dir = agentRunsDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function agentRunStoreForDir(dirPath: string): JsonStore<AgentRun> {
  return new JsonStore<AgentRun>({
    dirPath,
    documentType: 'agent_run',
    getId: (run) => run.id,
    sort: (a, b) => {
      const byAssignment = a.assignment_id.localeCompare(b.assignment_id);
      if (byAssignment !== 0) return byAssignment;
      return a.created_at.localeCompare(b.created_at);
    },
  });
}

// NOTE: no single-directory reader remains. The helper that resolved ONE dir via the
// hasContent heuristic is what let a legacy run stay invisible to the list while the by-id
// loader found it; removing it stops the next reader from reintroducing that asymmetry.


export function saveAgentRun(run: AgentRun, cwd?: string): void {
  mutate({ cwd }, () => {
    saveAgentRunUnlocked(run, cwd);
  });
}

/** Store-lock caller variant used by create-or-validate projection repair. */
function saveAgentRunUnlocked(run: AgentRun, cwd?: string): void {
  ensureAgentRunsDir(cwd);
  const store = new JsonStore<AgentRun>({
    dirPath: agentRunsDir(cwd, 'write'),
    documentType: 'agent_run',
    getId: (item) => item.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
  const parsed = AgentRunSchema.parse(run);
  // pln#568 (I2): journal the post-image BEFORE the projection write.
  const created = !store.exists(parsed.id);
  emitRegistryPostImage('agent_run', parsed, { created, agent: parsed.agent, agent_id: parsed.agent_id, session_id: parsed.session_id, cwd });
  registryFaultPoint('after_registry_journal');
  store.save(parsed);
  // Converge the other layout (mirrors saveClaim / saveAssignment): leaving a legacy copy
  // holding the stale status is what let a deleted record be resurrected by its own zombie.
  const writeDir = agentRunsDir(cwd, 'write');
  for (const dirPath of entityRecordDirs('runs', cwd ?? process.cwd())) {
    if (dirPath === writeDir) continue;
    const legacyPath = path.join(dirPath, `${parsed.id}.json`);
    try {
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch { /* best effort — the dual-layout list keeps it visible */ }
  }
}

export function loadAgentRun(id: string, cwd?: string): AgentRun | undefined {
  // Record-specific across both layouts (pln#649, shared io.ts primitive). Resolving
  // a single directory made a legacy run invisible as soon as the canonical one held
  // any file — the same defect reproduced twice on assignments, found here by a Fable
  // audit before it reached a field report.
  for (const dirPath of entityRecordDirs('runs', cwd ?? process.cwd())) {
    try {
      return new JsonStore<AgentRun>({
        dirPath,
        documentType: 'agent_run',
        getId: (run) => run.id,
        sort: (a, b) => {
          const byAssignment = a.assignment_id.localeCompare(b.assignment_id);
          if (byAssignment !== 0) return byAssignment;
          return a.created_at.localeCompare(b.created_at);
        },
      }).load(id);
    } catch { /* not in this layout — try the other */ }
  }
  return undefined;
}

export interface ExecutionContractAnomalyInput {
  source: NonNullable<AgentRun['execution_contract_anomaly']>['source'];
  reason: string;
  accepted_contract_hash?: string;
  accepted_capability_snapshot_hash?: string;
}

/**
 * Persist the first execution-contract anomaly for a run.
 *
 * The field is deliberately monotone: later correct-looking evidence cannot
 * erase an already-observed post-crossing mismatch and reopen convergence.
 */
export function recordExecutionContractAnomaly(
  id: string,
  anomaly: ExecutionContractAnomalyInput,
  cwd?: string,
): AgentRun {
  assertAgentRunMutationAllowed(id, cwd);
  return mutate({ cwd }, () => {
    const run = loadAgentRun(id, cwd);
    if (!run) throw new Error(`AgentRun not found: ${id}`);
    if (run.execution_contract_anomaly) return run;
    const now = nowISO();
    run.execution_contract_anomaly = {
      detected_at: now,
      source: anomaly.source,
      reason: anomaly.reason,
      accepted_contract_hash: anomaly.accepted_contract_hash,
      accepted_capability_snapshot_hash: anomaly.accepted_capability_snapshot_hash,
    };
    run.updated_at = now;
    run.last_event_at = now;
    saveAgentRunUnlocked(run, cwd);
    return run;
  });
}

/** Persist a post-start observation without ever rewriting the frozen snapshot. */
export function recordRuntimeCapabilityObservation(
  id: string,
  observation: RuntimeCapabilityObservation,
  diagnostic?: AgentRun['harness_exit_diagnostic'],
  cwd?: string,
): AgentRun {
  assertAgentRunMutationAllowed(id, cwd);
  return mutate({ cwd }, () => {
    const run = loadAgentRun(id, cwd);
    if (!run) throw new Error(`AgentRun not found: ${id}`);
    const parsed = RuntimeCapabilityObservationSchema.parse(observation);
    if (run.runtime_capability_observation) {
      if (JSON.stringify(run.runtime_capability_observation) !== JSON.stringify(parsed)) {
        throw new Error(`AgentRun ${id} already has a different runtime capability observation`);
      }
      return run;
    }
    const now = nowISO();
    run.runtime_capability_observation = parsed;
    if (diagnostic) run.harness_exit_diagnostic = diagnostic;
    const frozenRef = run.execution_contract_ref;
    const frozenHarness = run.capability_snapshot?.resolved.harness;
    const resolvedModel = frozenHarness?.resolved_model ?? run.capability_snapshot?.resolved.model;
    const mismatches: string[] = [];
    if (frozenRef?.hash !== parsed.contract_hash) {
      mismatches.push(`observed contract hash '${parsed.contract_hash}' differs from frozen '${frozenRef?.hash ?? 'absent'}'`);
    }
    if (frozenRef?.snapshot_hash !== parsed.capability_snapshot_hash) {
      mismatches.push(`observed capability snapshot hash '${parsed.capability_snapshot_hash}' differs from frozen '${frozenRef?.snapshot_hash ?? 'absent'}'`);
    }
    if (parsed.accepted_contract_hash && parsed.accepted_contract_hash !== frozenRef?.hash) {
      mismatches.push(`accepted contract hash '${parsed.accepted_contract_hash}' differs from frozen '${frozenRef?.hash ?? 'absent'}'`);
    }
    if (parsed.accepted_capability_snapshot_hash && parsed.accepted_capability_snapshot_hash !== frozenRef?.snapshot_hash) {
      mismatches.push(`accepted capability snapshot hash '${parsed.accepted_capability_snapshot_hash}' differs from frozen '${frozenRef?.snapshot_hash ?? 'absent'}'`);
    }
    if (frozenHarness && parsed.adapter_id && frozenHarness.adapter_id !== parsed.adapter_id) {
      mismatches.push(`observed adapter '${parsed.adapter_id}' differs from frozen '${frozenHarness.adapter_id}'`);
    }
    if (frozenHarness && parsed.adapter_version && frozenHarness.adapter_version !== parsed.adapter_version) {
      mismatches.push(`observed adapter version '${parsed.adapter_version}' differs from frozen '${frozenHarness.adapter_version}'`);
    }
    if (resolvedModel && parsed.observed_model && resolvedModel !== parsed.observed_model) {
      mismatches.push(`observed model '${parsed.observed_model}' differs from frozen resolved model '${resolvedModel}'`);
    }
    if (mismatches.length > 0 && !run.execution_contract_anomaly) {
      run.execution_contract_anomaly = {
        detected_at: now,
        source: 'reconciler',
        reason: mismatches.join('; '),
        accepted_contract_hash: parsed.accepted_contract_hash,
        accepted_capability_snapshot_hash: parsed.accepted_capability_snapshot_hash,
      };
    }
    run.updated_at = now;
    run.last_event_at = now;
    saveAgentRunUnlocked(run, cwd);
    return run;
  });
}

export interface ListAgentRunsFilter {
  status?: AgentRunStatus;
  agent?: string;
  assignment_id?: string;
  claim_id?: string;
  plan_id?: string;
  sequence_id?: string;
  transport?: AgentRunTransport;
}

/**
 * BOTH LAYOUTS, canonical winning on a duplicate id (mirrors listClaims / listAssignments).
 *
 * This list is the one `nextAttemptIndex` and `findLatestAgentRunForAssignment` read, so a
 * run visible by id but missing from the list is what lets an attempt index restart at 1
 * and a run's FSM freeze. Reachability is LOW — agent runs postdate the partitioned layout,
 * so brainclaw has never written them flat (measured: legacy=0 in the field) — which is why
 * this is internal consistency, not a field fix.
 */
export function listAgentRuns(cwd?: string, filter?: ListAgentRunsFilter): AgentRun[] {
  const byId = new Map<string, AgentRun>();
  for (const dirPath of entityRecordDirs('runs', cwd ?? process.cwd())) {
    for (const run of agentRunStoreForDir(dirPath).list()) {
      if (!byId.has(run.id)) byId.set(run.id, run);
    }
  }
  let runs = Array.from(byId.values()).sort((a, b) => {
    const byAssignment = a.assignment_id.localeCompare(b.assignment_id);
    if (byAssignment !== 0) return byAssignment;
    return a.created_at.localeCompare(b.created_at);
  });
  if (filter?.status) runs = runs.filter((run) => run.status === filter.status);
  if (filter?.agent) runs = runs.filter((run) => run.agent === filter.agent);
  if (filter?.assignment_id) runs = runs.filter((run) => run.assignment_id === filter.assignment_id);
  if (filter?.claim_id) runs = runs.filter((run) => run.claim_id === filter.claim_id);
  if (filter?.plan_id) runs = runs.filter((run) => run.plan_id === filter.plan_id);
  if (filter?.sequence_id) runs = runs.filter((run) => run.sequence_id === filter.sequence_id);
  if (filter?.transport) runs = runs.filter((run) => run.transport === filter.transport);
  return runs;
}

export function generateAgentRunId(cwd?: string): { id: string; short_label: string } {
  return generateIdWithLabel('runs', cwd);
}

function nextAttemptIndex(assignmentId: string, cwd?: string): number {
  const existing = listAgentRuns(cwd, { assignment_id: assignmentId });
  if (existing.length === 0) return 1;
  return Math.max(...existing.map((run) => run.attempt_index)) + 1;
}

export function findLatestAgentRunForAssignment(assignmentId: string, cwd?: string): AgentRun | undefined {
  const runs = listAgentRuns(cwd, { assignment_id: assignmentId });
  if (runs.length === 0) return undefined;
  return [...runs].sort((left, right) => {
    if (left.attempt_index !== right.attempt_index) return right.attempt_index - left.attempt_index;
    return right.created_at.localeCompare(left.created_at);
  })[0];
}

const VALID_TRANSITIONS = new Map<AgentRunStatus, Set<AgentRunStatus>>([
  // `failed` added (pln#630 PR2c-lease): a turn-owned run preallocated `created`
  // whose launch grant CROSSED but crashed before the created→launching
  // transition is `launch_attempted_unknown` — a failure, reconciled straight
  // from `created`. (reserved_never_launched, where the grant never crossed,
  // goes to `cancelled`, already permitted.)
  ['created', new Set(['launching', 'waiting_input', 'running', 'failed', 'cancelled', 'interrupted'])],
  ['launching', new Set(['waiting_input', 'running', 'failed', 'cancelled', 'timed_out', 'interrupted'])],
  ['waiting_input', new Set(['launching', 'running', 'blocked', 'cancelled', 'timed_out', 'interrupted'])],
  ['running', new Set(['blocked', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])],
  ['blocked', new Set(['running', 'cancelled', 'timed_out', 'interrupted'])],
  ['completed', new Set()],
  ['failed', new Set()],
  ['cancelled', new Set()],
  ['timed_out', new Set()],
  ['interrupted', new Set()],
]);

export interface CreateAgentRunOptions {
  id?: string;
  short_label?: string;
  // NO project_id override — same reasoning as CreateAssignmentOptions (review P1-1):
  // the owner is always the store being written to, never a caller's claim about it.
  assignment_id: string;
  claim_id: string;
  message_id?: string;
  plan_id?: string;
  sequence_id?: string;
  retry_of_run_id?: string;
  attempt_index?: number;
  agent: string;
  agent_id?: string;
  session_id?: string;
  transport: AgentRunTransport;
  status?: AgentRunStatus;
  status_reason?: string;
  scope: string;
  description: string;
  worktree_path?: string;
  command?: string;
  shell?: string;
  pid?: number;
  provider_run_id?: string;
  execution_contract_ref?: ExecutionContractRef;
  capability_snapshot?: CapabilitySnapshot;
  tags?: string[];
}

function buildAgentRun(options: CreateAgentRunOptions, cwd?: string): AgentRun {
  const generated = options.id ? undefined : generateAgentRunId(cwd);
  const now = nowISO();
  return AgentRunSchema.parse({
    schema_version: 1,
    id: options.id ?? generated!.id,
    // Same landmine as createAssignment: `generated` is undefined when the caller
    // supplied an id, so `generated!` threw on "this id, derive the rest".
    short_label: options.short_label ?? generated?.short_label ?? (options.id ?? generated!.id),
    assignment_id: options.assignment_id,
    claim_id: options.claim_id,
    message_id: options.message_id,
    plan_id: options.plan_id,
    sequence_id: options.sequence_id,
    retry_of_run_id: options.retry_of_run_id,
    attempt_index: options.attempt_index ?? nextAttemptIndex(options.assignment_id, cwd),
    agent: options.agent,
    agent_id: options.agent_id,
    session_id: options.session_id,
    // OWNER project — same core-level capture as createAssignment (pln#649 step 1).
    project_id: resolveOwnerProjectId(cwd),
    transport: options.transport,
    status: options.status ?? 'created',
    status_reason: options.status_reason,
    scope: options.scope,
    description: options.description,
    worktree_path: options.worktree_path,
    command: options.command,
    shell: options.shell,
    pid: options.pid,
    provider_run_id: options.provider_run_id,
    execution_contract_ref: options.execution_contract_ref,
    capability_snapshot: options.capability_snapshot,
    created_at: now,
    updated_at: now,
    last_event_at: now,
    ...(options.status === 'launching' ? { launched_at: now } : {}),
    ...(options.status === 'running' ? { started_at: now, launched_at: now } : {}),
    ...(options.status === 'waiting_input' ? { launched_at: now } : {}),
    artifacts: [],
    tags: options.tags ?? [],
  });
}

function emitAgentRunCreatedSideEffects(run: AgentRun, options: CreateAgentRunOptions, cwd?: string): void {
  emitAgentRunEvent(run, 'run_created', options.agent, cwd);
  if (run.status !== 'created') {
    emitAgentRunEvent(run, `run_${run.status}` as import('./event-log.js').EventAction, options.agent, cwd);
  }
  appendAuditEntry({
    actor: options.agent,
    actor_id: options.agent_id,
    action: 'create',
    item_id: run.id,
    item_type: 'agent_run',
    after: { assignment_id: run.assignment_id, status: run.status, transport: run.transport },
    scope: run.scope,
    session_id: run.session_id,
  }, cwd);
}

export function createAgentRun(options: CreateAgentRunOptions, cwd?: string): AgentRun {
  const run = buildAgentRun(options, cwd);

  saveAgentRun(run, cwd);
  emitAgentRunCreatedSideEffects(run, options, cwd);
  return run;
}

export class AgentRunProjectionConflictError extends Error {
  constructor(public readonly runId: string, detail: string) {
    super(`AgentRun projection conflict for ${runId}: ${detail}`);
    this.name = 'AgentRunProjectionConflictError';
  }
}

export interface EnsureAgentRunProjectionResult {
  run: AgentRun;
  created: boolean;
  repaired?: boolean;
}

const RECOVERABLE_PROJECTION_RUN_STATUSES = new Set<AgentRunStatus>([
  'created', 'launching', 'waiting_input', 'running',
]);

function assertAgentRunProjectionMatches(
  existing: AgentRun,
  expected: AgentRun,
): void {
  const fields: Array<keyof AgentRun> = [
    'id', 'assignment_id', 'claim_id', 'agent', 'agent_id', 'transport', 'scope',
    'worktree_path', 'attempt_index',
  ];
  for (const field of fields) {
    if (existing[field] !== expected[field]) {
      throw new AgentRunProjectionConflictError(
        expected.id,
        `${String(field)} differs (existing=${String(existing[field])}, expected=${String(expected[field])})`,
      );
    }
  }
  if (existing.project_id !== undefined && existing.project_id !== expected.project_id) {
    throw new AgentRunProjectionConflictError(expected.id, 'project_id differs');
  }
  if (
    existing.execution_contract_ref !== undefined
    && expected.execution_contract_ref !== undefined
    && JSON.stringify(existing.execution_contract_ref) !== JSON.stringify(expected.execution_contract_ref)
  ) {
    throw new AgentRunProjectionConflictError(expected.id, 'execution_contract_ref differs');
  }
  if (
    existing.capability_snapshot !== undefined
    && expected.capability_snapshot !== undefined
    && JSON.stringify(existing.capability_snapshot) !== JSON.stringify(expected.capability_snapshot)
  ) {
    throw new AgentRunProjectionConflictError(expected.id, 'capability_snapshot differs');
  }
  if (!RECOVERABLE_PROJECTION_RUN_STATUSES.has(existing.status)) {
    throw new AgentRunProjectionConflictError(expected.id, `existing status is terminal (${existing.status})`);
  }
}

/**
 * Create-or-validate a deterministic AgentRun projection for one physical
 * generation of a logical turn. P0 callers omit `attempt_index` and therefore
 * keep the legacy value 1; AttemptAuthority v2 supplies the immutable
 * generation index. Recovery never changes an existing run's generation and
 * never resets an existing live run to `created`.
 */
export function ensureAgentRunProjection(
  options: CreateAgentRunOptions & { id: string },
  cwd?: string,
): EnsureAgentRunProjectionResult {
  const normalized: CreateAgentRunOptions & { id: string } = {
    ...options,
    attempt_index: options.attempt_index ?? 1,
  };
  const expected = buildAgentRun(normalized, cwd);
  let created = false;
  let repaired = false;
  const run = mutate({ cwd }, () => {
    const existing = loadAgentRun(options.id, cwd);
    if (existing) {
      const requiredTags = normalized.tags ?? [];
      const missingContractRef = existing.execution_contract_ref === undefined && expected.execution_contract_ref !== undefined;
      const missingCapabilitySnapshot = existing.capability_snapshot === undefined && expected.capability_snapshot !== undefined;
      const missingTags = !requiredTags.every((tag) => existing.tags.includes(tag));
      const enriched = !missingContractRef && !missingCapabilitySnapshot && !missingTags
        ? existing
        : {
          ...existing,
          ...(missingContractRef ? { execution_contract_ref: expected.execution_contract_ref } : {}),
          ...(missingCapabilitySnapshot ? { capability_snapshot: expected.capability_snapshot } : {}),
          tags: [...new Set([...existing.tags, ...requiredTags])],
        };
      assertAgentRunProjectionMatches(enriched, expected);
      if (enriched !== existing) {
        saveAgentRunUnlocked(enriched, cwd);
        repaired = true;
      }
      return enriched;
    }
    saveAgentRunUnlocked(expected, cwd);
    created = true;
    return expected;
  });
  if (created) emitAgentRunCreatedSideEffects(run, normalized, cwd);
  return { run, created, ...(repaired ? { repaired: true } : {}) };
}

export interface TransitionAgentRunOptions {
  session_id?: string;
  status_reason?: string;
  artifacts?: AssignmentArtifact[];
  error_message?: string;
  actor?: string;
  actor_id?: string;
  pid?: number;
  provider_run_id?: string;
  /** Controller-only projection after an immutable close cell fenced this run. */
  allow_fenced_projection?: boolean;
}

export interface AgentRunTransitionResult {
  run: AgentRun;
  previous_status: AgentRunStatus;
  idempotent?: boolean;
}

export function transitionAgentRun(
  id: string,
  newStatus: AgentRunStatus,
  options: TransitionAgentRunOptions = {},
  cwd?: string,
): AgentRunTransitionResult {
  assertAgentRunMutationAllowed(id, cwd, options.allow_fenced_projection);
  const run = loadAgentRun(id, cwd);
  if (!run) throw new Error(`AgentRun not found: ${id}`);

  if (run.status === newStatus) {
    const now = nowISO();
    run.updated_at = now;
    run.last_event_at = now;
    if (options.session_id) run.session_id = options.session_id;
    if (options.status_reason) run.status_reason = options.status_reason;
    if (options.pid) run.pid = options.pid;
    if (options.provider_run_id) run.provider_run_id = options.provider_run_id;
    if (options.artifacts?.length) run.artifacts = [...run.artifacts, ...options.artifacts];
    saveAgentRun(run, cwd);
    return { run, previous_status: newStatus, idempotent: true };
  }

  const allowed = VALID_TRANSITIONS.get(run.status);
  if (!allowed?.has(newStatus)) {
    throw new Error(`Invalid AgentRun transition: ${run.status} -> ${newStatus}`);
  }

  const previous_status = run.status;
  const now = nowISO();
  run.status = newStatus;
  run.updated_at = now;
  run.last_event_at = now;
  if (options.session_id) run.session_id = options.session_id;
  if (options.status_reason) run.status_reason = options.status_reason;
  if (options.error_message) run.error_message = options.error_message;
  if (options.artifacts?.length) run.artifacts = [...run.artifacts, ...options.artifacts];
  if (options.pid) run.pid = options.pid;
  if (options.provider_run_id) run.provider_run_id = options.provider_run_id;

  switch (newStatus) {
    case 'launching': run.launched_at = now; break;
    case 'waiting_input': run.launched_at ??= now; break;
    case 'running':
      run.launched_at ??= now;
      run.started_at = now;
      break;
    case 'blocked': run.blocked_at = now; break;
    case 'completed': run.completed_at = now; break;
    case 'failed': run.failed_at = now; break;
    case 'cancelled': run.cancelled_at = now; break;
    case 'timed_out': run.timed_out_at = now; break;
    case 'interrupted': run.interrupted_at = now; break;
  }

  saveAgentRun(run, cwd);
  emitAgentRunEvent(run, `run_${newStatus}` as import('./event-log.js').EventAction, options.actor, cwd);
  appendAuditEntry({
    actor: options.actor ?? run.agent,
    actor_id: options.actor_id,
    action: 'update',
    item_id: run.id,
    item_type: 'agent_run',
    before: { status: previous_status },
    after: { status: newStatus, reason: options.status_reason },
    scope: run.scope,
    session_id: options.session_id,
  }, cwd);

  return { run, previous_status };
}

export interface AgentRunProgressOptions {
  message?: string;
  session_id?: string;
  artifacts?: AssignmentArtifact[];
  actor?: string;
  actor_id?: string;
}

export function recordAgentRunProgress(
  id: string,
  options: AgentRunProgressOptions = {},
  cwd?: string,
): AgentRun {
  assertAgentRunMutationAllowed(id, cwd);
  const run = loadAgentRun(id, cwd);
  if (!run) throw new Error(`AgentRun not found: ${id}`);

  if (run.status === 'created' || run.status === 'launching' || run.status === 'waiting_input' || run.status === 'blocked') {
    transitionAgentRun(id, 'running', {
      actor: options.actor,
      actor_id: options.actor_id,
      session_id: options.session_id,
      status_reason: options.message,
      artifacts: options.artifacts,
    }, cwd);
    return loadAgentRun(id, cwd)!;
  }

  if (run.status !== 'running') {
    throw new Error(`Cannot record progress: run ${id} is ${run.status}, expected running`);
  }

  const now = nowISO();
  run.updated_at = now;
  run.last_event_at = now;
  if (options.session_id) run.session_id = options.session_id;
  if (options.message) run.status_reason = options.message;
  if (options.artifacts?.length) run.artifacts = [...run.artifacts, ...options.artifacts];
  saveAgentRun(run, cwd);
  emitAgentRunEvent(run, 'run_running', options.actor, cwd);
  return run;
}

/** Check if a run transition is allowed before attempting it (best-effort sync). */
function canTransitionRun(run: AgentRun, target: AgentRunStatus): boolean {
  if (run.status === target) return true; // idempotent
  const allowed = VALID_TRANSITIONS.get(run.status);
  return !!allowed?.has(target);
}

export function syncAgentRunFromAssignmentTransition(
  assignment: Assignment,
  newStatus: Assignment['status'],
  options: {
    actor?: string;
    actor_id?: string;
    session_id?: string;
    status_reason?: string;
    artifacts?: AssignmentArtifact[];
    error_message?: string;
  } = {},
  cwd?: string,
): void {
  const run = findLatestAgentRunForAssignment(assignment.id, cwd);
  if (!run) return;

  switch (newStatus) {
    case 'accepted': {
      const now = nowISO();
      run.updated_at = now;
      run.last_event_at = now;
      if (options.session_id) run.session_id = options.session_id;
      if (options.status_reason) run.status_reason = options.status_reason;
      saveAgentRun(run, cwd);
      return;
    }
    case 'started':
      if (!canTransitionRun(run, 'running')) return;
      transitionAgentRun(run.id, 'running', {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason,
      }, cwd);
      return;
    case 'completed':
      if (!canTransitionRun(run, 'completed')) return;
      transitionAgentRun(run.id, 'completed', {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason,
        artifacts: options.artifacts,
      }, cwd);
      return;
    case 'cancelled':
      if (!canTransitionRun(run, 'cancelled')) return;
      transitionAgentRun(run.id, 'cancelled', {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason ?? 'Cancelled via assignment lifecycle',
      }, cwd);
      return;
    case 'failed':
      if (!canTransitionRun(run, 'failed')) return;
      transitionAgentRun(run.id, 'failed', {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason,
        artifacts: options.artifacts,
        error_message: options.error_message,
      }, cwd);
      return;
    case 'blocked':
      if (!canTransitionRun(run, 'blocked')) return;
      transitionAgentRun(run.id, 'blocked', {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason,
      }, cwd);
      return;
    case 'timed_out':
      if (!canTransitionRun(run, 'timed_out')) return;
      transitionAgentRun(run.id, 'timed_out', {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason,
      }, cwd);
      return;
    case 'expired':
    case 'rerouted':
      if (!canTransitionRun(run, 'interrupted')) return;
      transitionAgentRun(run.id, 'interrupted', {
        actor: options.actor,
        actor_id: options.actor_id,
        session_id: options.session_id,
        status_reason: options.status_reason ?? `${newStatus} via assignment lifecycle`,
      }, cwd);
      return;
    case 'retrying':
      if (!['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) {
        if (!canTransitionRun(run, 'interrupted')) return;
        transitionAgentRun(run.id, 'interrupted', {
          actor: options.actor,
          actor_id: options.actor_id,
          session_id: options.session_id,
          status_reason: options.status_reason ?? 'Retry requested at assignment level',
        }, cwd);
      }
      return;
    default:
      return;
  }
}

function emitAgentRunEvent(
  run: AgentRun,
  action: import('./event-log.js').EventAction,
  actor?: string,
  cwd?: string,
): void {
  const text = `${run.description} [${run.status}/${run.transport}]${run.status_reason ? ` — ${run.status_reason}` : ''}`;
  appendEvent({
    ts: nowISO(),
    agent: actor ?? run.agent,
    agent_id: run.agent_id,
    action,
    item_type: 'agent_run',
    item_id: run.id,
    summary: `${run.status}: ${run.description.slice(0, 80)}`,
  }, cwd);
  try {
    createRuntimeEvent({
      agent: actor ?? run.agent,
      agent_id: run.agent_id,
      session_id: run.session_id,
      event_type: action as import('./schema.js').RuntimeEvent['event_type'],
      text,
      tags: ['agent-runtime', 'run'],
      assignment_id: run.assignment_id,
      run_id: run.id,
      claim_id: run.claim_id,
      message_id: run.message_id,
      plan_id: run.plan_id,
      sequence_id: run.sequence_id,
      scope: run.scope,
      transport: run.transport,
      status: run.status,
      status_reason: run.status_reason,
      related_paths: [run.scope],
      metadata: {
        attempt_index: run.attempt_index,
        retry_of_run_id: run.retry_of_run_id,
        provider_run_id: run.provider_run_id,
        protocol: 'brainclaw.agent_runtime.v0',
      },
    }, cwd);
  } catch {
    /* best-effort: runtime event emission should not break run lifecycle */
  }
}
