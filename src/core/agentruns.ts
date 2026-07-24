/**
 * AgentRun lifecycle — concrete execution attempts for an Assignment.
 *
 * Assignment stays the business coordination object.
 * AgentRun tracks one concrete launch / pickup / retry attempt.
 *
 * @module
 */
import fs from 'node:fs';
import { AgentRunSchema, type AgentRun, type AgentRunStatus, type AgentRunTransport, type Assignment, type AssignmentArtifact } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO, generateIdWithLabel } from './ids.js';
import { JsonStore } from './json-store.js';
import { appendAuditEntry } from './audit.js';
import { appendEvent } from './event-log.js';
import { createRuntimeEvent } from './events.js';
import { emitRegistryPostImage, registryFaultPoint } from './events/registry-post-image.js';

function agentRunsDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('runs', cwd, mode);
}

function ensureAgentRunsDir(cwd?: string): void {
  const dir = agentRunsDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function agentRunStore(cwd?: string): JsonStore<AgentRun> {
  return new JsonStore<AgentRun>({
    dirPath: agentRunsDir(cwd, 'read'),
    documentType: 'agent_run',
    getId: (run) => run.id,
    sort: (a, b) => {
      const byAssignment = a.assignment_id.localeCompare(b.assignment_id);
      if (byAssignment !== 0) return byAssignment;
      return a.created_at.localeCompare(b.created_at);
    },
  });
}

export function saveAgentRun(run: AgentRun, cwd?: string): void {
  mutate({ cwd }, () => {
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
  });
}

export function loadAgentRun(id: string, cwd?: string): AgentRun | undefined {
  try {
    return agentRunStore(cwd).load(id);
  } catch {
    return undefined;
  }
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

export function listAgentRuns(cwd?: string, filter?: ListAgentRunsFilter): AgentRun[] {
  let runs = agentRunStore(cwd).list();
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
  tags?: string[];
}

export function createAgentRun(options: CreateAgentRunOptions, cwd?: string): AgentRun {
  const generated = options.id ? undefined : generateAgentRunId(cwd);
  const now = nowISO();
  const run: AgentRun = AgentRunSchema.parse({
    schema_version: 1,
    id: options.id ?? generated!.id,
    short_label: options.short_label ?? generated!.short_label,
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
    created_at: now,
    updated_at: now,
    last_event_at: now,
    ...(options.status === 'launching' ? { launched_at: now } : {}),
    ...(options.status === 'running' ? { started_at: now, launched_at: now } : {}),
    ...(options.status === 'waiting_input' ? { launched_at: now } : {}),
    artifacts: [],
    tags: options.tags ?? [],
  });

  saveAgentRun(run, cwd);
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
  return run;
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
