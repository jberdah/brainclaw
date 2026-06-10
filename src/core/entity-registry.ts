/**
 * Entity Registry — single source of truth for the canonical CRUD surface.
 *
 * Phase 3 slice 3a (pln_c6472192). Consumed by bclaw_find / get / create /
 * update / remove / transition (slice 3b). Grammar-consistency tests
 * live in tests/unit/entity-registry.test.ts.
 *
 * Design principles (per entity-model-audit §6 P6.2):
 *  - Declarative: transition matrix + side-effect tags as data.
 *  - Imperative side effects (the code that actually releases claims,
 *    promotes candidates, emits events) stays in `src/core/operations/*`
 *    and `src/core/<entity>.ts` — the registry references them by name
 *    but does not dispatch.
 *  - Short-label prefixes match the authoritative map in `src/core/ids.ts`
 *    (a consistency test pins this).
 *  - `updatable` is the subset of persisted fields `bclaw_update` may
 *    patch. Non-listed fields are set at create time or via a
 *    transition — never by plain update.
 */

import type { ZodType } from 'zod';
import {
  CandidateSchema,
  ClaimSchema,
  ConstraintSchema,
  CrossProjectLinkSchema,
  CurrentSessionStateSchema,
  DecisionSchema,
  HandoffSchema,
  InboxMessageSchema,
  InstructionEntrySchema,
  PlanItemSchema,
  PlanStepSchema,
  RuntimeNoteSchema,
  SequenceSchema,
  TrapSchema,
  AssignmentSchema,
  AgentRunSchema,
  ActionRequiredSchema,
} from './schema.js';

/** Every entity the canonical CRUD surface addresses. */
export type EntityName =
  | 'plan'
  | 'step'
  | 'claim'
  | 'session'
  | 'handoff'
  | 'decision'
  | 'constraint'
  | 'trap'
  | 'candidate'
  | 'runtime_note'
  | 'sequence'
  | 'inbox_message'
  | 'instruction'
  | 'assignment'
  | 'agent_run'
  | 'action'
  | 'cross_project_link';

export interface EntitySpec {
  /** Canonical name used in bclaw_<verb>(entity='<name>'). */
  name: EntityName;
  /** Short-label prefix. Must match src/core/ids.ts PREFIXES (or the hardcoded generator). */
  shortLabelPrefix: string;
  /** Zod schema of the full persisted shape. */
  schema: ZodType;
  /** Fields bclaw_update may patch. Non-listed fields require a transition or re-create. */
  updatable: readonly string[];
  /** Name of the status-bearing field, if any. undefined = stateless entity. */
  statusField?: string;
  /** Declarative transition matrix: current → [next, …]. Empty when stateless. */
  transitions: Readonly<Record<string, readonly string[]>>;
  /** Statuses from which no further transition is allowed. */
  terminal: readonly string[];
  /**
   * Documentary side-effect tags per transition (`from→to`). Points at
   * the imperative hook that actually runs — callers/tests can reason
   * about what a transition implies without reading 10 files.
   */
  sideEffects: Readonly<Record<string, readonly string[]>>;
}

/** Canonical plan lifecycle. */
const plan: EntitySpec = {
  name: 'plan',
  shortLabelPrefix: 'pln',
  schema: PlanItemSchema,
  updatable: ['text', 'priority', 'tags', 'assignee', 'estimated_effort', 'actual_effort', 'depends_on', 'related_paths'],
  statusField: 'status',
  transitions: {
    todo: ['in_progress', 'blocked', 'done', 'dropped'],
    in_progress: ['blocked', 'done', 'dropped'],
    blocked: ['in_progress', 'dropped'],
  },
  terminal: ['done', 'dropped'],
  sideEffects: {
    'in_progress->done': ['audit:plan_done', 'cascade:release_linked_claims_if_last'],
    'todo->done': ['audit:plan_done', 'cascade:release_linked_claims_if_last'],
    'todo->dropped': ['audit:plan_dropped'],
    'in_progress->dropped': ['audit:plan_dropped'],
    'blocked->dropped': ['audit:plan_dropped'],
  },
};

/** Plan steps — finer-grained lifecycle with a testing stage. */
const step: EntitySpec = {
  name: 'step',
  shortLabelPrefix: 'stp',
  schema: PlanStepSchema,
  updatable: ['text', 'assignee'],
  statusField: 'status',
  transitions: {
    todo: ['in_progress', 'blocked', 'done'],
    in_progress: ['testing', 'done', 'blocked'],
    testing: ['done', 'blocked', 'in_progress'],
    blocked: ['in_progress', 'todo'],
  },
  terminal: ['done'],
  sideEffects: {
    'testing->done': ['audit:step_done', 'cascade:auto_complete_plan_if_last_step'],
    'in_progress->done': ['audit:step_done', 'cascade:auto_complete_plan_if_last_step'],
  },
};

/** Claim — file-level advisory lock. */
const claim: EntitySpec = {
  name: 'claim',
  shortLabelPrefix: 'clm',
  schema: ClaimSchema,
  // worktree_path: sprint 1.5 — coordinators register manual worktrees (or fix
  // stale paths) so harvest/dispatch_status can resolve LANE-RESULT locations.
  updatable: ['description', 'worktree_path'],
  statusField: 'status',
  transitions: {
    active: ['released', 'stale'],
  },
  terminal: ['released', 'stale'],
  sideEffects: {
    'active->released': ['audit:claim_released', 'cascade:plan_status_if_last_claim'],
    'active->stale': ['audit:claim_stale', 'heartbeat:expired'],
  },
};

/** Session — execution envelope. Status tracked via timestamps, not an enum. */
const session: EntitySpec = {
  name: 'session',
  shortLabelPrefix: 'sess',
  schema: CurrentSessionStateSchema,
  updatable: ['last_seen_at'],
  transitions: {},
  terminal: [],
  sideEffects: {},
};

/** Handoff — session-end artefact. Downscale in 3e: no more review sub-flow. */
const handoff: EntitySpec = {
  name: 'handoff',
  shortLabelPrefix: 'hnd',
  schema: HandoffSchema,
  updatable: ['narrative', 'tags'],
  statusField: 'status',
  transitions: {
    open: ['accepted', 'closed'],
    accepted: ['closed'],
  },
  terminal: ['closed'],
  sideEffects: {
    'open->closed': ['audit:handoff_closed'],
    'open->accepted': ['audit:handoff_accepted'],
    'accepted->closed': ['audit:handoff_closed'],
  },
};

/** Decision — memory record with a retrospective outcome field (not a lifecycle status). */
const decision: EntitySpec = {
  name: 'decision',
  shortLabelPrefix: 'dec',
  schema: DecisionSchema,
  updatable: ['text', 'tags', 'outcome', 'scope', 'related_paths', 'verified_at', 'verify_cmd'],
  statusField: 'outcome',
  transitions: {
    pending: ['approved', 'rejected', 'deferred'],
    deferred: ['approved', 'rejected'],
  },
  terminal: ['approved', 'rejected'],
  sideEffects: {},
};

/** Constraint — enforced rule. */
const constraint: EntitySpec = {
  name: 'constraint',
  shortLabelPrefix: 'cst',
  schema: ConstraintSchema,
  updatable: ['text', 'tags', 'category', 'scope', 'related_paths', 'expires_at'],
  statusField: 'status',
  transitions: {
    active: ['resolved', 'expired'],
  },
  terminal: ['resolved', 'expired'],
  sideEffects: {
    'active->resolved': ['audit:constraint_resolved'],
    'active->expired': ['audit:constraint_expired'],
  },
};

/** Trap — environmental pitfall. */
const trap: EntitySpec = {
  name: 'trap',
  shortLabelPrefix: 'trp',
  schema: TrapSchema,
  updatable: ['text', 'tags', 'severity', 'scope', 'related_paths', 'expires_at', 'platform_scope', 'verified_at', 'verify_cmd'],
  statusField: 'status',
  transitions: {
    active: ['resolved', 'expired'],
  },
  terminal: ['resolved', 'expired'],
  sideEffects: {
    'active->resolved': ['audit:trap_resolved'],
    'active->expired': ['audit:trap_expired'],
  },
};

/**
 * Candidate — review queue entity. Slated for removal in v1.0: new code
 * should prefer direct memory writes + read-time confidence filtering.
 * Kept in the registry so that legacy accept/reject flows still work.
 */
const candidate: EntitySpec = {
  name: 'candidate',
  shortLabelPrefix: 'cnd',
  schema: CandidateSchema,
  updatable: ['text', 'tags', 'severity', 'narrative', 'related_paths', 'plan_id'],
  statusField: 'status',
  transitions: {
    pending: ['accepted', 'rejected'],
  },
  terminal: ['accepted', 'rejected'],
  sideEffects: {
    'pending->accepted': ['audit:candidate_accepted', 'promote:to_decision_or_constraint_or_trap_or_handoff'],
    'pending->rejected': ['audit:candidate_rejected'],
  },
};

/** Runtime note — observation record, no lifecycle. */
const runtime_note: EntitySpec = {
  name: 'runtime_note',
  shortLabelPrefix: 'rtn',
  schema: RuntimeNoteSchema,
  updatable: ['text', 'tags', 'visibility', 'expires_at'],
  transitions: {},
  terminal: [],
  sideEffects: {},
};

/** Sequence — lane-based execution coordinator across plans/steps. */
const sequence: EntitySpec = {
  name: 'sequence',
  shortLabelPrefix: 'seq',
  schema: SequenceSchema,
  updatable: ['name', 'description', 'tags', 'items', 'owner'],
  statusField: 'status',
  transitions: {
    draft: ['active', 'archived'],
    active: ['archived'],
  },
  terminal: ['archived'],
  sideEffects: {
    'draft->active': ['audit:sequence_activated'],
    'active->archived': ['audit:sequence_archived'],
  },
};

/** Inbox message — dispatch brief, review request, or signal. */
const inbox_message: EntitySpec = {
  name: 'inbox_message',
  shortLabelPrefix: 'msg',
  schema: InboxMessageSchema,
  updatable: [],
  statusField: 'status',
  transitions: {
    pending: ['read', 'acknowledged', 'archived'],
    read: ['acknowledged', 'archived'],
    acknowledged: ['archived'],
  },
  terminal: ['archived'],
  sideEffects: {
    'pending->read': ['timestamp:read_at'],
    'pending->acknowledged': ['timestamp:read_at', 'timestamp:ack_at'],
    'read->acknowledged': ['timestamp:ack_at'],
  },
};

/** Instruction — rule layer (global/project/agent). No lifecycle status. */
const instruction: EntitySpec = {
  name: 'instruction',
  shortLabelPrefix: 'ins',
  schema: InstructionEntrySchema,
  updatable: ['text', 'tags', 'active'],
  transitions: {},
  terminal: [],
  sideEffects: {},
};

/**
 * Assignment — work delegation record. Its transition matrix is rich and
 * owned by `src/core/assignments.ts` (transitionAssignment + VALID). The
 * registry mirrors that matrix so the canonical CRUD verbs see a unified
 * surface; the imperative transition code stays where it is.
 */
const assignment: EntitySpec = {
  name: 'assignment',
  shortLabelPrefix: 'asgn',
  schema: AssignmentSchema,
  updatable: ['description', 'status_reason', 'tags'],
  statusField: 'status',
  transitions: {
    created: ['offered', 'expired', 'rerouted', 'cancelled'],
    offered: ['accepted', 'expired', 'rerouted', 'failed', 'cancelled'],
    accepted: ['started', 'failed', 'timed_out', 'rerouted', 'cancelled'],
    started: ['completed', 'failed', 'blocked', 'timed_out', 'rerouted', 'cancelled'],
    failed: ['retrying', 'rerouted', 'cancelled'],
    timed_out: ['retrying', 'rerouted', 'cancelled'],
    retrying: ['offered', 'rerouted', 'cancelled'],
    blocked: ['started', 'rerouted', 'failed', 'cancelled'],
  },
  terminal: ['completed', 'cancelled', 'expired', 'rerouted'],
  sideEffects: {
    'created->offered': ['timestamp:offered_at', 'event:assignment_offered', 'audit:assignment_offered'],
    'offered->accepted': ['timestamp:accepted_at', 'event:assignment_accepted', 'sync:agent_run'],
    'accepted->started': ['timestamp:started_at', 'event:assignment_started', 'sync:agent_run'],
    'started->completed': ['timestamp:completed_at', 'event:assignment_completed', 'sync:agent_run'],
    'started->cancelled': ['timestamp:cancelled_at', 'event:assignment_cancelled', 'sync:agent_run'],
    'started->failed': ['timestamp:failed_at', 'event:assignment_failed', 'sync:agent_run'],
  },
};

/** Agent run — per-attempt execution record paired with an assignment. */
const agent_run: EntitySpec = {
  name: 'agent_run',
  shortLabelPrefix: 'run',
  schema: AgentRunSchema,
  updatable: ['output_summary', 'error_summary'],
  statusField: 'status',
  transitions: {
    created: ['launching', 'waiting_input', 'running', 'cancelled', 'interrupted'],
    launching: ['waiting_input', 'running', 'failed', 'cancelled', 'timed_out', 'interrupted'],
    waiting_input: ['running', 'blocked', 'failed', 'cancelled', 'timed_out', 'interrupted'],
    running: ['waiting_input', 'blocked', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'],
    blocked: ['waiting_input', 'running', 'failed', 'cancelled', 'timed_out', 'interrupted'],
  },
  terminal: ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'],
  sideEffects: {
    'running->completed': ['timestamp:completed_at', 'event:agent_run_completed'],
    'running->failed': ['timestamp:completed_at', 'event:agent_run_failed'],
  },
};

/** Action — required follow-up item. */
const action: EntitySpec = {
  name: 'action',
  shortLabelPrefix: 'act',
  schema: ActionRequiredSchema,
  updatable: ['description', 'priority'],
  statusField: 'status',
  transitions: {
    open: ['in_progress', 'completed', 'dismissed'],
    in_progress: ['completed', 'dismissed'],
  },
  terminal: ['completed', 'dismissed'],
  sideEffects: {
    'open->completed': ['audit:action_completed'],
    'in_progress->completed': ['audit:action_completed'],
  },
};

/**
 * Cross-project link — federation peer entry stored in config.yaml
 * (cross_project_links). Stateless: identified by `name`, no lifecycle.
 * Storage is YAML-in-config rather than a per-entity directory, so the
 * `bclaw_create/find/remove` ops route through `src/core/cross-project.ts`
 * helpers (addCrossProjectLink / resolveCrossProjectLinks /
 * removeCrossProjectLink).
 */
const cross_project_link: EntitySpec = {
  name: 'cross_project_link',
  shortLabelPrefix: 'xpl',
  schema: CrossProjectLinkSchema,
  updatable: ['name', 'role', 'channels'],
  transitions: {},
  terminal: [],
  sideEffects: {},
};

export const ENTITY_REGISTRY: Readonly<Record<EntityName, EntitySpec>> = {
  plan, step, claim, session, handoff,
  decision, constraint, trap, candidate, runtime_note, sequence,
  inbox_message, instruction,
  assignment, agent_run, action,
  cross_project_link,
};

export const ENTITY_NAMES: readonly EntityName[] = Object.keys(ENTITY_REGISTRY) as EntityName[];

/** Look up an entity spec by name. Throws if the name is unknown. */
export function getEntitySpec(name: EntityName): EntitySpec {
  const spec = ENTITY_REGISTRY[name];
  if (!spec) throw new Error(`Unknown entity: ${name}`);
  return spec;
}

/**
 * Check if a transition is valid for the given entity.
 * Stateless entities (no statusField) always reject transitions.
 */
export function isValidTransition(name: EntityName, from: string, to: string): boolean {
  const spec = getEntitySpec(name);
  if (!spec.statusField) return false;
  if (spec.terminal.includes(from)) return false;
  const allowed = spec.transitions[from];
  return allowed ? allowed.includes(to) : false;
}

/** Canonical transition key for sideEffects lookup: `from->to`. */
export function transitionKey(from: string, to: string): string {
  return `${from}->${to}`;
}
