import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from './json-store.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO, generateIdWithLabel } from './ids.js';
import {
  ActionRequiredSchema,
  type ActionRequired,
  type ActionRequiredKind,
  type ActionRequiredResponse,
  type ActionRequiredStatus,
} from './schema.js';
import { saveVersionedJsonFile } from './migration.js';
import { appendAuditEntry } from './audit.js';
import { createRuntimeEvent } from './events.js';
import { loadAssignment, transitionAssignment } from './assignments.js';
import { loadAgentRun, transitionAgentRun } from './agentruns.js';

function actionsDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('actions', cwd ?? process.cwd(), mode);
}

function ensureActionsDir(cwd?: string): void {
  const dir = actionsDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function actionStore(cwd?: string): JsonStore<ActionRequired> {
  return new JsonStore<ActionRequired>({
    dirPath: actionsDir(cwd, 'read'),
    documentType: 'action_required',
    getId: (action) => action.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

export interface ListActionRequiredFilter {
  status?: ActionRequiredStatus;
  kind?: ActionRequiredKind;
  agent?: string;
  assignment_id?: string;
  run_id?: string;
  claim_id?: string;
  plan_id?: string;
  sequence_id?: string;
}

export function loadActionRequired(id: string, cwd?: string): ActionRequired | undefined {
  return actionStore(cwd).load(id);
}

/** Default TTL for pending actions (1 hour). */
const ACTION_DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Expire stale pending actions on read.
 * Called lazily during list() to avoid needing a separate sweeper process.
 */
function expireStaleActions(actions: ActionRequired[], cwd?: string): ActionRequired[] {
  const now = Date.now();
  for (const action of actions) {
    if (action.status !== 'pending') continue;
    const expiresAt = action.expires_at
      ? new Date(action.expires_at).getTime()
      : new Date(action.created_at).getTime() + ACTION_DEFAULT_TTL_MS;
    if (now > expiresAt) {
      action.status = 'expired';
      action.updated_at = nowISO();
      try { saveActionRequired(action, cwd); } catch { /* best-effort */ }
    }
  }
  return actions;
}

export function listActionRequired(cwd?: string, filter: ListActionRequiredFilter = {}): ActionRequired[] {
  let actions = actionStore(cwd).list();
  // Sweep-on-read: expire stale pending actions
  actions = expireStaleActions(actions, cwd);
  if (filter.status) actions = actions.filter((action) => action.status === filter.status);
  if (filter.kind) actions = actions.filter((action) => action.kind === filter.kind);
  if (filter.agent) actions = actions.filter((action) => action.agent === filter.agent);
  if (filter.assignment_id) actions = actions.filter((action) => action.assignment_id === filter.assignment_id);
  if (filter.run_id) actions = actions.filter((action) => action.run_id === filter.run_id);
  if (filter.claim_id) actions = actions.filter((action) => action.claim_id === filter.claim_id);
  if (filter.plan_id) actions = actions.filter((action) => action.plan_id === filter.plan_id);
  if (filter.sequence_id) actions = actions.filter((action) => action.sequence_id === filter.sequence_id);
  return actions;
}

function saveActionRequired(action: ActionRequired, cwd?: string): void {
  mutate({ cwd }, () => {
    ensureActionsDir(cwd);
    const filepath = path.join(actionsDir(cwd, 'write'), `${action.id}.json`);
    saveVersionedJsonFile('action_required', filepath, ActionRequiredSchema.parse(action));
  });
}

export interface CreateActionRequiredOptions {
  assignment_id: string;
  run_id?: string;
  claim_id?: string;
  message_id?: string;
  plan_id?: string;
  sequence_id?: string;
  agent: string;
  agent_id?: string;
  session_id?: string;
  kind: ActionRequiredKind;
  scope?: string;
  title: string;
  prompt: string;
  options?: string[];
  response_schema?: Record<string, unknown>;
  ttl_ms?: number;
  tags?: string[];
}

export function createActionRequired(options: CreateActionRequiredOptions, cwd?: string): ActionRequired {
  const generated = generateIdWithLabel('actions', cwd);
  const now = nowISO();
  const action: ActionRequired = ActionRequiredSchema.parse({
    schema_version: 1,
    id: generated.id,
    short_label: generated.short_label,
    assignment_id: options.assignment_id,
    run_id: options.run_id,
    claim_id: options.claim_id,
    message_id: options.message_id,
    plan_id: options.plan_id,
    sequence_id: options.sequence_id,
    agent: options.agent,
    agent_id: options.agent_id,
    session_id: options.session_id,
    kind: options.kind,
    status: 'pending',
    scope: options.scope,
    title: options.title,
    prompt: options.prompt,
    options: options.options ?? [],
    response_schema: options.response_schema,
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + (options.ttl_ms ?? ACTION_DEFAULT_TTL_MS)).toISOString(),
    tags: options.tags ?? [],
  });

  saveActionRequired(action, cwd);
  appendAuditEntry({
    actor: options.agent,
    actor_id: options.agent_id,
    action: 'create',
    item_id: action.id,
    item_type: 'state',
    after: { kind: action.kind, assignment_id: action.assignment_id, run_id: action.run_id },
    scope: action.scope,
    session_id: action.session_id,
  }, cwd);
  createRuntimeEvent({
    agent: options.agent,
    agent_id: options.agent_id,
    session_id: options.session_id,
    event_type: 'observation',
    text: `Action required: ${action.title}`,
    tags: ['agent-runtime', 'action-required', `kind:${action.kind}`],
    assignment_id: action.assignment_id,
    run_id: action.run_id,
    claim_id: action.claim_id,
    plan_id: action.plan_id,
    sequence_id: action.sequence_id,
    scope: action.scope,
    status: action.status,
    status_reason: action.prompt,
    metadata: {
      protocol: 'brainclaw.agent_runtime.action_required.v1',
      action_id: action.id,
      kind: action.kind,
    },
  }, cwd);
  return action;
}

export interface ResolveActionRequiredOptions {
  outcome: ActionRequiredResponse['outcome'];
  text?: string;
  payload?: Record<string, unknown>;
  responded_by: string;
  responded_by_id?: string;
  session_id?: string;
}

export function resolveActionRequired(id: string, options: ResolveActionRequiredOptions, cwd?: string): ActionRequired {
  // Wrap the entire load-check-mutate-save cycle in mutate() to prevent
  // TOCTOU races where two supervisors resolve the same action concurrently.
  // The inner saveActionRequired also calls mutate(), but the lock is reentrant.
  return mutate({ cwd }, () => {
    const action = loadActionRequired(id, cwd);
    if (!action) {
      throw new Error(`ActionRequired not found: ${id}`);
    }
    if (action.status !== 'pending') {
      throw new Error(`ActionRequired ${id} is already ${action.status}`);
    }

    const now = nowISO();
    action.status = options.outcome;
    action.updated_at = now;
    action.resolved_at = now;
    action.response = {
      outcome: options.outcome,
      text: options.text,
      payload: options.payload,
      responded_by: options.responded_by,
      responded_by_id: options.responded_by_id,
      responded_at: now,
    };
    saveActionRequired(action, cwd);

    appendAuditEntry({
      actor: options.responded_by,
      actor_id: options.responded_by_id,
      action: 'update',
      item_id: action.id,
      item_type: 'state',
      before: { status: 'pending' },
      after: { status: action.status },
      scope: action.scope,
      session_id: options.session_id,
    }, cwd);

    const runtimeStatusMessage = options.text ?? `${action.kind} ${options.outcome}`;
    if (action.run_id) {
      const run = loadAgentRun(action.run_id, cwd);
      if (run) {
        if (options.outcome === 'resolved' && ['blocked', 'waiting_input'].includes(run.status)) {
          transitionAgentRun(run.id, 'running', {
            actor: options.responded_by,
            actor_id: options.responded_by_id,
            session_id: options.session_id,
            status_reason: runtimeStatusMessage,
          }, cwd);
        } else if (options.outcome !== 'resolved' && !['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) {
          transitionAgentRun(run.id, 'cancelled', {
            actor: options.responded_by,
            actor_id: options.responded_by_id,
            session_id: options.session_id,
            status_reason: runtimeStatusMessage,
          }, cwd);
        }
      }
    }

    const assignment = loadAssignment(action.assignment_id, cwd);
    if (assignment) {
      if (options.outcome === 'resolved' && assignment.status === 'blocked') {
        transitionAssignment(assignment.id, 'started', {
          actor: options.responded_by,
          actor_id: options.responded_by_id,
          session_id: options.session_id,
          status_reason: runtimeStatusMessage,
        }, cwd);
      } else if (options.outcome !== 'resolved' && assignment.status === 'blocked') {
        transitionAssignment(assignment.id, 'failed', {
          actor: options.responded_by,
          actor_id: options.responded_by_id,
          session_id: options.session_id,
          status_reason: runtimeStatusMessage,
          error_message: runtimeStatusMessage,
        }, cwd);
      }
    }

    createRuntimeEvent({
      agent: options.responded_by,
      agent_id: options.responded_by_id,
      session_id: options.session_id,
      event_type: 'observation',
      text: `Action ${options.outcome}: ${action.title}`,
      tags: ['agent-runtime', 'action-response', `kind:${action.kind}`],
      assignment_id: action.assignment_id,
      run_id: action.run_id,
      claim_id: action.claim_id,
      plan_id: action.plan_id,
      sequence_id: action.sequence_id,
      scope: action.scope,
      status: action.status,
      status_reason: runtimeStatusMessage,
      metadata: {
        protocol: 'brainclaw.agent_runtime.action_required.v1',
        action_id: action.id,
        outcome: options.outcome,
      },
    }, cwd);

    return action;
  });
}
