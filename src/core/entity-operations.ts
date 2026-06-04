/**
 * Entity Operations — dispatch layer between the canonical CRUD verbs
 * (bclaw_find/get/create/update/remove/transition) and the entity-specific
 * code in src/core/*.
 *
 * Phase 3 slice 3b (pln_c6472192). Keeps imperative code where it lives
 * (per P6.2) — this module only routes.
 *
 * MVP wiring (this landing): plan, decision, constraint, trap,
 * runtime_note, candidate. Other entities throw
 * `EntityOperationUnsupportedError` with a pointer at the legacy tool
 * until later slices wire them in.
 */

import path from 'node:path';
import { loadState, persistState } from './state.js';
import {
  archiveCandidate,
  listCandidates,
  loadCandidate,
  saveCandidate,
} from './candidates.js';
import {
  addCrossProjectLink,
  removeCrossProjectLink,
  resolveCrossProjectLinks,
  type ResolvedCrossProjectLink,
} from './cross-project.js';
import { listClaims } from './claims.js';
import { listActionRequired } from './actions.js';
import { deleteAssignment, listAssignments, loadAssignment, saveAssignment, transitionAssignment } from './assignments.js';
import { listAgentRuns } from './agentruns.js';
import { reconcileAgentRun, reconcileDeadPidRunningAgentRunAtRead, TERMINAL_STATUSES } from './agentrun-reconciler.js';
import {
  deleteRuntimeNote,
  listRuntimeNotes,
  saveRuntimeNote,
} from './runtime.js';
import {
  createSequence,
  deleteSequence,
  listSequences,
  updateSequence,
} from './sequence.js';
import {
  createConstraint,
  createDecision,
  createTrap,
} from './operations/memory-write.js';
import {
  deleteMemoryItem,
  findMemoryItemInChain,
  updateMemoryItem,
} from './operations/memory-mutation.js';
import {
  createPlan,
  deletePlan,
  updatePlan,
  type UpdatePlanInput,
} from './operations/plan.js';
import {
  ENTITY_REGISTRY,
  isValidTransition,
  type EntityName,
} from './entity-registry.js';
import { generateId } from './ids.js';
import {
  CandidateTypeSchema,
  ConstraintCategorySchema,
  DecisionOutcomeSchema,
  MemoryVisibilitySchema,
  PlanTypeEnumSchema,
  PrioritySchema,
  RuntimeNoteTypeSchema,
  SequenceStatusSchema,
  SeveritySchema,
} from './schema.js';
import type {
  AssignmentStatus,
  Candidate,
  Constraint,
  Decision,
  PlanItem,
  Provenance,
  RuntimeNote,
  SequenceItemInput,
  SequenceStatus,
  Trap,
} from './schema.js';

/**
 * Default provenance stamp applied on create when the caller does not
 * supply one. `user` kind with whatever author is in the payload; the
 * caller can override to 'agent', 'auto_reflect', etc. at write time.
 */
function defaultProvenance(data: Record<string, unknown>): Provenance {
  const author = typeof data.author === 'string' ? data.author : undefined;
  if (author) return { kind: 'user', author };
  return { kind: 'user' };
}

/**
 * Default read filter: exclude legacy provenance and low-confidence
 * auto_reflect records below 0.6. Override via `includeLegacy` /
 * `minAutoReflectConfidence` in the filter.
 */
const DEFAULT_MIN_AUTO_REFLECT_CONFIDENCE = 0.6;

function passesProvenanceFilter(item: Record<string, unknown>, filter: EntityFilter): boolean {
  const provenance = item.provenance as Provenance | undefined;
  if (!provenance) return true; // pre-provenance record — never filter out.

  if (provenance.kind === 'legacy') {
    return filter.includeLegacy === true;
  }
  if (provenance.kind === 'auto_reflect') {
    const threshold = typeof filter.minAutoReflectConfidence === 'number'
      ? filter.minAutoReflectConfidence
      : DEFAULT_MIN_AUTO_REFLECT_CONFIDENCE;
    const confidence = provenance.confidence ?? 0;
    return confidence >= threshold;
  }
  return true;
}

/** Thrown when a verb is not yet wired for a given entity. */
export class EntityOperationUnsupportedError extends Error {
  constructor(entity: EntityName, verb: string, hint?: string) {
    super(
      `bclaw_${verb}(entity='${entity}') is not yet wired.` +
      (hint ? ` ${hint}` : ' Use the legacy tool for now.'),
    );
    this.name = 'EntityOperationUnsupportedError';
  }
}

export class EntityNotFoundError extends Error {
  constructor(entity: EntityName, id: string) {
    super(`${entity} with id '${id}' not found`);
    this.name = 'EntityNotFoundError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(entity: EntityName, from: string, to: string) {
    super(`Invalid transition for ${entity}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface EntityFilter {
  status?: string;
  tag?: string;
  tags?: string[];
  author?: string;
  plan_id?: string;
  assignment_id?: string;
  claim_id?: string;
  message_id?: string;
  limit?: number;
  offset?: number;
  /**
   * Phase 3 slice 3f — provenance-aware read filtering.
   * Default: exclude `legacy` provenance + auto_reflect records below
   * 0.6 confidence. Override to show legacy records or lower the
   * threshold.
   */
  includeLegacy?: boolean;
  minAutoReflectConfidence?: number;
  [key: string]: unknown;
}

export interface ListResult<T = unknown> {
  entity: EntityName;
  total: number;
  items: T[];
}

export interface CreateResult {
  entity: EntityName;
  id: string;
  short_label?: string;
}

export interface UpdateResult {
  entity: EntityName;
  id: string;
}

export interface RemoveResult {
  entity: EntityName;
  id: string;
  archived: boolean;
  purged: boolean;
}

export interface TransitionResult {
  entity: EntityName;
  id: string;
  from: string;
  to: string;
  side_effects: readonly string[];
}

// ─── FIND ─────────────────────────────────────────────────────────────

/**
 * Lazy reconciliation pass on agent_run reads (pln#503 phase 3.2).
 *
 * Before returning agent_run records to `bclaw_find` / `bclaw_get`, walk any
 * record whose status is non-terminal and call `reconcileAgentRun(id)`. The
 * reconciler:
 *   - no-ops for runs under the 60s grace window or already terminal
 *   - transitions to `completed` (inferred=true) when evidence of completion
 *     exists (post-start commit, claim released, assignment completed)
 *   - transitions to `failed` (silent_termination_no_evidence) when the run
 *     is past the stale threshold AND its pid is provably dead
 *
 * Without this pass, a worker that crashed before its first output keeps
 * `status="running"` indefinitely — the empirical pattern recorded in trp#292.
 * The full agentrun-reconciler.ts machinery already existed (pln#496); this
 * just wires it into the canonical-grammar read path so every read of
 * `agent_run` produces converged state.
 */
function loadAgentRunsWithReconciliation(cwd: string): unknown[] {
  const runs = listAgentRuns(cwd);
  for (const run of runs) {
    if (run.status === 'running') {
      try { reconcileDeadPidRunningAgentRunAtRead(run.id, cwd); } catch { /* best-effort: never block reads on reconciliation errors */ }
      continue;
    }
    if (!TERMINAL_STATUSES.has(run.status)) {
      try { reconcileAgentRun(run.id, cwd); } catch { /* best-effort: never block reads on reconciliation errors */ }
    }
  }
  // Re-list to capture any transitions made above.
  return listAgentRuns(cwd);
}


export function listEntities(
  name: EntityName,
  cwd: string,
  filter: EntityFilter = {},
): ListResult {
  const all = loadAll(name, cwd);
  const filtered = applyFilter(all, filter);
  const paged = applyPaging(filtered, filter);
  return { entity: name, total: filtered.length, items: paged };
}

function loadAll(name: EntityName, cwd: string): unknown[] {
  switch (name) {
    case 'plan':                return loadState(cwd).plan_items;
    case 'decision':            return loadState(cwd).recent_decisions;
    case 'constraint':          return loadState(cwd).active_constraints;
    case 'trap':                return loadState(cwd).known_traps;
    case 'handoff':             return loadState(cwd).open_handoffs;
    case 'candidate':           return listCandidates(undefined, cwd);
    case 'runtime_note':        return listRuntimeNotes(undefined, cwd);
    case 'sequence':            return listSequences(cwd);
    case 'claim':               return listClaims(cwd);
    case 'action':              return listActionRequired(cwd);
    case 'assignment':          return listAssignments(cwd);
    case 'agent_run':           return loadAgentRunsWithReconciliation(cwd);
    case 'cross_project_link':  return resolveCrossProjectLinks(cwd);
    default:
      throw new EntityOperationUnsupportedError(name, 'find');
  }
}

function applyFilter(items: unknown[], filter: EntityFilter): unknown[] {
  let result = items as Array<Record<string, unknown>>;
  result = result.filter((item) => passesProvenanceFilter(item, filter));
  if (filter.status) {
    result = result.filter((item) => item.status === filter.status);
  }
  if (filter.tag) {
    result = result.filter((item) =>
      Array.isArray(item.tags) && (item.tags as unknown[]).includes(filter.tag),
    );
  }
  if (Array.isArray(filter.tags) && filter.tags.length > 0) {
    result = result.filter((item) =>
      Array.isArray(item.tags) && filter.tags!.some((tag) => (item.tags as unknown[]).includes(tag)),
    );
  }
  if (filter.author) {
    result = result.filter((item) => item.author === filter.author);
  }
  if (filter.plan_id) {
    result = result.filter((item) => item.plan_id === filter.plan_id);
  }
  if (filter.assignment_id) {
    result = result.filter((item) => item.assignment_id === filter.assignment_id);
  }
  if (filter.claim_id) {
    result = result.filter((item) => item.claim_id === filter.claim_id);
  }
  if (filter.message_id) {
    result = result.filter((item) => item.message_id === filter.message_id);
  }
  if (filter.source) {
    result = result.filter((item) => item.source === filter.source);
  }
  if (typeof filter.auto_generated === 'boolean') {
    result = result.filter((item) => {
      const source = typeof item.source === 'string' ? item.source : undefined;
      const origin = typeof item.origin === 'string' ? item.origin : undefined;
      const isAuto = source === 'auto' || origin?.startsWith('session-end') === true;
      return filter.auto_generated ? isAuto : !isAuto;
    });
  }
  return result;
}

function applyPaging(items: unknown[], filter: EntityFilter): unknown[] {
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = filter.limit ?? 50;
  return items.slice(offset, offset + limit);
}

// ─── GET ───────────────────────────────────────────────────────────────

export function getEntity(
  name: EntityName,
  idOrShortLabel: string,
  cwd: string,
): unknown {
  if (name === 'cross_project_link') {
    const links = resolveCrossProjectLinks(cwd) as ResolvedCrossProjectLink[];
    const hit = links.find(
      (l) => l.name === idOrShortLabel ||
             l.projectName === idOrShortLabel ||
             l.path === idOrShortLabel ||
             l.absolutePath === idOrShortLabel ||
             path.basename(l.absolutePath) === idOrShortLabel,
    );
    if (!hit) throw new EntityNotFoundError(name, idOrShortLabel);
    return hit;
  }
  const items = loadAll(name, cwd) as Array<Record<string, unknown>>;
  const hit = items.find(
    (item) => item.id === idOrShortLabel || item.short_label === idOrShortLabel,
  );
  if (!hit) throw new EntityNotFoundError(name, idOrShortLabel);
  return hit;
}

// ─── CREATE ────────────────────────────────────────────────────────────

export function createEntity(
  name: EntityName,
  data: Record<string, unknown>,
  cwd: string,
): CreateResult {
  switch (name) {
    case 'plan': {
      // Explicit field whitelist + required-author check brings plan create in line
      // with decision/constraint/trap above. Previous behaviour (`data as CreatePlanInput`)
      // bypassed validation and allowed schema-invalid plan files on disk, which
      // were then silently GC'd at the next state mutation. See fix plan pln_5f44426c.
      const res = createPlan({
        text: requireString(data, 'text'),
        author: requireString(data, 'author'),
        type: requireEnum(data, 'type', PlanTypeEnumSchema.options, { optional: true }),
        priority: requireEnum(data, 'priority', PrioritySchema.options, { optional: true }),
        assignee: data.assignee as string | undefined,
        project: data.project as string | undefined,
        tags: data.tags as string[] | undefined,
        relatedPaths: data.related_paths as string[] | undefined,
        dependsOn: data.depends_on as string[] | undefined,
        estimatedEffort: data.estimated_effort as number | undefined,
      }, cwd);
      stampProvenanceOnStateItem('plan', res.id, defaultProvenance(data), cwd);
      return { entity: name, id: res.id, short_label: res.shortLabel };
    }
    case 'decision': {
      const res = createDecision({
        text: requireString(data, 'text'),
        author: requireString(data, 'author'),
        outcome: requireEnum(data, 'outcome', DecisionOutcomeSchema.options, { optional: true }),
        tags: data.tags as string[] | undefined,
        relatedPaths: data.related_paths as string[] | undefined,
        planId: data.plan_id as string | undefined,
      }, cwd);
      stampProvenanceOnStateItem('decision', res.id, defaultProvenance(data), cwd);
      return { entity: name, id: res.id, short_label: res.shortLabel };
    }
    case 'constraint': {
      const res = createConstraint({
        text: requireString(data, 'text'),
        author: requireString(data, 'author'),
        category: requireEnum(data, 'category', ConstraintCategorySchema.options, { optional: true }),
        tags: data.tags as string[] | undefined,
        relatedPaths: data.related_paths as string[] | undefined,
      }, cwd);
      stampProvenanceOnStateItem('constraint', res.id, defaultProvenance(data), cwd);
      return { entity: name, id: res.id, short_label: res.shortLabel };
    }
    case 'trap': {
      const res = createTrap({
        text: requireString(data, 'text'),
        author: requireString(data, 'author'),
        severity: requireEnum(data, 'severity', SeveritySchema.options, { optional: true }) ?? 'medium',
        tags: data.tags as string[] | undefined,
        relatedPaths: data.related_paths as string[] | undefined,
      }, cwd);
      stampProvenanceOnStateItem('trap', res.id, defaultProvenance(data), cwd);
      return { entity: name, id: res.id, short_label: res.shortLabel };
    }
    case 'runtime_note': {
      const id = generateId('runtime_note');
      const note: RuntimeNote = {
        id,
        agent: requireString(data, 'agent'),
        text: requireString(data, 'text'),
        created_at: new Date().toISOString(),
        tags: (data.tags as string[] | undefined) ?? [],
        visibility: requireEnum(data, 'visibility', MemoryVisibilitySchema.options, { optional: true }) ?? 'shared',
        note_type: requireEnum(data, 'note_type', RuntimeNoteTypeSchema.options, { optional: true }) ?? 'observation',
        provenance: defaultProvenance(data),
        ...(data.agent_id ? { agent_id: data.agent_id as string } : {}),
        ...(data.project_id ? { project_id: data.project_id as string } : {}),
        ...(data.session_id ? { session_id: data.session_id as string } : {}),
        ...(data.plan_id ? { plan_id: data.plan_id as string } : {}),
      };
      saveRuntimeNote(note, cwd);
      return { entity: name, id };
    }
    case 'candidate': {
      const id = generateId('candidate');
      const validatedType = requireEnum(data, 'type', CandidateTypeSchema.options);
      if (!validatedType) {
        // requireEnum without `optional` throws on missing/invalid, but
        // narrow the type for the assignment below.
        throw new Error(`Missing required field: type`);
      }
      const candidate: Candidate = {
        id,
        type: validatedType,
        text: requireString(data, 'text'),
        created_at: new Date().toISOString(),
        author: requireString(data, 'author'),
        tags: (data.tags as string[] | undefined) ?? [],
        status: 'pending',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
        source: data.source as Candidate['source'],
        origin: data.origin as string | undefined,
        provenance: defaultProvenance(data),
      };
      saveCandidate(candidate, cwd);
      return { entity: name, id };
    }
    case 'sequence': {
      const res = createSequence({
        name: requireString(data, 'name'),
        description: data.description as string | undefined,
        status: requireEnum(data, 'status', SequenceStatusSchema.options, { optional: true }),
        items: optionalSequenceItems(data),
        owner: data.owner as string | undefined,
        author: requireString(data, 'author'),
        authorId: data.agent_id as string | undefined,
        tags: data.tags as string[] | undefined,
      }, cwd);
      return { entity: name, id: res.id, short_label: res.shortLabel };
    }
    case 'cross_project_link': {
      const link = addCrossProjectLink({
        path: requireString(data, 'path'),
        name: data.name as string | undefined,
        role: data.role as 'subscriber' | 'publisher' | undefined,
        channels: data.channels as string[] | undefined,
        force: data.force === true,
        cwd,
      });
      return { entity: name, id: link.name ?? link.path };
    }
    default:
      throw new EntityOperationUnsupportedError(name, 'create');
  }
}

// ─── UPDATE ────────────────────────────────────────────────────────────

export function updateEntity(
  name: EntityName,
  id: string,
  patch: Record<string, unknown>,
  cwd: string,
): UpdateResult {
  const spec = ENTITY_REGISTRY[name];
  const invalidFields = Object.keys(patch).filter(
    (field) => !spec.updatable.includes(field),
  );
  if (invalidFields.length > 0) {
    throw new Error(
      `Fields not updatable on ${name}: [${invalidFields.join(', ')}]. ` +
      `Use bclaw_transition for status changes.`,
    );
  }

  switch (name) {
    case 'plan': {
      // Pass the whole patch through the generic escape-hatch so EntityRegistry-
      // declared updatable fields (text, tags, estimated_effort, depends_on)
      // actually land. The typed surface still covers status/assignee/priority/
      // actualEffort for legacy CLI callers — see UpdatePlanInput.
      // Note: `plan.type` is intentionally create-only (not in plan.updatable
      // at entity-registry.ts) — no validation needed here.
      validatePatchEnum(patch, 'priority', PrioritySchema.options);
      updatePlan({
        id,
        patch: patch as Partial<PlanItem>,
      }, cwd);
      return { entity: name, id };
    }
    case 'decision':
    case 'constraint':
    case 'trap': {
      // Same generic-patch escape-hatch for memory items. Registry declares
      // severity, scope, related_paths, expires_at, etc. as updatable; the
      // legacy explicit text/tags whitelist silently dropped them.
      if (name === 'decision') {
        validatePatchEnum(patch, 'outcome', DecisionOutcomeSchema.options);
      } else if (name === 'constraint') {
        validatePatchEnum(patch, 'category', ConstraintCategorySchema.options);
      } else {
        validatePatchEnum(patch, 'severity', SeveritySchema.options);
      }
      updateMemoryItem({
        id,
        type: name,
        patch: patch as Partial<Constraint | Decision | Trap>,
      }, cwd);
      return { entity: name, id };
    }
    case 'runtime_note': {
      // Note: `note_type` is intentionally create-only (not in
      // runtime_note.updatable at entity-registry.ts) — no validation needed.
      validatePatchEnum(patch, 'visibility', MemoryVisibilitySchema.options);
      const notes = listRuntimeNotes(undefined, cwd);
      const note = notes.find((n) => n.id === id);
      if (!note) throw new EntityNotFoundError(name, id);
      const patched = { ...note, ...patch } as RuntimeNote;
      saveRuntimeNote(patched, cwd);
      return { entity: name, id };
    }
    case 'assignment': {
      const assignment = loadAssignment(id, cwd);
      if (!assignment) throw new EntityNotFoundError(name, id);
      const patched = { ...assignment, ...patch } as typeof assignment;
      saveAssignment(patched, cwd);
      return { entity: name, id };
    }
    case 'candidate': {
      // Note: `candidate.type` is intentionally create-only (not in
      // candidate.updatable at entity-registry.ts) — no validation needed.
      const candidate = loadCandidate(id, cwd);
      const patched = { ...candidate, ...patch } as Candidate;
      saveCandidate(patched, cwd);
      return { entity: name, id };
    }
    case 'sequence': {
      // `status` is intentionally NOT in sequence.updatable — lifecycle moves
      // go through bclaw_transition. The invalidFields guard above already
      // rejects it, so only name/description/tags/items/owner reach here.
      const result = updateSequence({
        id,
        name: patch.name as string | undefined,
        description: patch.description as string | undefined,
        items: optionalSequenceItems(patch),
        owner: patch.owner as string | undefined,
        tags: patch.tags as string[] | undefined,
      }, cwd);
      return { entity: name, id: result.id };
    }
    case 'cross_project_link': {
      // In-place patch: find by id (= name/path), remove, re-add with merged
      // fields. Same path semantics as resolveCrossProjectTarget so callers can
      // pass either the link `name` or the original `path`.
      const current = getEntity(name, id, cwd) as ResolvedCrossProjectLink;
      removeCrossProjectLink(current.name ?? current.path, cwd);
      const merged = addCrossProjectLink({
        path: current.path,
        name: (patch.name as string | undefined) ?? current.name,
        role: ((patch.role as 'subscriber' | 'publisher' | undefined) ?? current.role),
        channels: (patch.channels as string[] | undefined) ?? current.channels,
        cwd,
        force: true,
      });
      return { entity: name, id: merged.name ?? merged.path };
    }
    default:
      throw new EntityOperationUnsupportedError(name, 'update');
  }
}

// ─── REMOVE ────────────────────────────────────────────────────────────

export function removeEntity(
  name: EntityName,
  id: string,
  cwd: string,
  purge: boolean = false,
): RemoveResult {
  switch (name) {
    case 'plan': {
      deletePlan(id, cwd);
      return { entity: name, id, archived: !purge, purged: purge };
    }
    case 'decision':
    case 'constraint':
    case 'trap': {
      const found = findMemoryItemInChain(id, name, cwd);
      if (!found) throw new EntityNotFoundError(name, id);
      deleteMemoryItem(id, name, cwd);
      return { entity: name, id, archived: false, purged: true };
    }
    case 'runtime_note': {
      const notes = listRuntimeNotes(undefined, cwd);
      const note = notes.find((n) => n.id === id);
      if (!note) throw new EntityNotFoundError(name, id);
      const ok = deleteRuntimeNote(note, cwd);
      if (!ok) throw new EntityNotFoundError(name, id);
      return { entity: name, id, archived: false, purged: true };
    }
    case 'candidate': {
      // Remove = archive to rejected. `purge` would delete the file; not exposed yet.
      const candidate = loadCandidate(id, cwd);
      archiveCandidate(candidate, 'rejected', cwd);
      return { entity: name, id, archived: true, purged: false };
    }
    case 'sequence': {
      // purge → hard-delete the file; default → soft-archive (status='archived',
      // the sequence terminal state) so the lane history stays auditable.
      if (purge) {
        const deleted = deleteSequence(id, cwd);
        return { entity: name, id: deleted.id, archived: false, purged: true };
      }
      const archived = updateSequence({ id, status: 'archived' }, cwd);
      return { entity: name, id: archived.id, archived: true, purged: false };
    }
    case 'cross_project_link': {
      const removed = removeCrossProjectLink(id, cwd);
      return { entity: name, id: removed.name ?? removed.path, archived: false, purged: true };
    }
    case 'assignment': {
      const assignment = loadAssignment(id, cwd);
      if (!assignment) throw new EntityNotFoundError(name, id);
      if (purge) {
        const deleted = deleteAssignment(id, cwd);
        if (!deleted) throw new EntityNotFoundError(name, id);
        return { entity: name, id, archived: false, purged: true };
      }
      if (assignment.status === 'cancelled') {
        return { entity: name, id, archived: true, purged: false };
      }
      if (ENTITY_REGISTRY.assignment.terminal.includes(assignment.status)) {
        throw new Error(`assignment '${id}' is already terminal (${assignment.status}); use purge:true to hard-delete if needed`);
      }
      transitionAssignment(id, 'cancelled', {
        actor: 'brainclaw',
        status_reason: 'Archived via bclaw_remove',
      }, cwd);
      return { entity: name, id, archived: true, purged: false };
    }
    default:
      throw new EntityOperationUnsupportedError(name, 'remove');
  }
}

// ─── TRANSITION ───────────────────────────────────────────────────────

export function transitionEntity(
  name: EntityName,
  id: string,
  to: string,
  cwd: string,
  _reason?: string,
): TransitionResult {
  const spec = ENTITY_REGISTRY[name];
  if (!spec.statusField) {
    throw new Error(`${name} has no lifecycle (statusField is undefined)`);
  }
  const current = getEntity(name, id, cwd) as Record<string, unknown>;
  const from = current[spec.statusField] as string | undefined;
  if (!from) {
    throw new Error(`${name} '${id}' has no '${spec.statusField}' field set`);
  }
  if (!isValidTransition(name, from, to)) {
    throw new InvalidTransitionError(name, from, to);
  }

  const key = `${from}->${to}`;
  const sideEffects = spec.sideEffects[key] ?? [];

  switch (name) {
    case 'plan': {
      updatePlan({ id, status: to as PlanItem['status'] }, cwd);
      return { entity: name, id, from, to, side_effects: sideEffects };
    }
    case 'decision':
    case 'constraint':
    case 'trap': {
      const state = loadState(cwd);
      const bucket = name === 'decision' ? state.recent_decisions
        : name === 'constraint' ? state.active_constraints
        : state.known_traps;
      const item = bucket.find((x) => x.id === id);
      if (!item) throw new EntityNotFoundError(name, id);
      (item as Record<string, unknown>)[spec.statusField] = to;
      persistState(state, cwd);
      return { entity: name, id, from, to, side_effects: sideEffects };
    }
    case 'candidate': {
      const candidate = loadCandidate(id, cwd);
      if (to === 'accepted' || to === 'rejected') {
        archiveCandidate(candidate, to, cwd);
        return { entity: name, id, from, to, side_effects: sideEffects };
      }
      throw new InvalidTransitionError(name, from, to);
    }
    case 'assignment': {
      transitionAssignment(id, to as AssignmentStatus, {
        actor: 'brainclaw',
        status_reason: _reason,
      }, cwd);
      return { entity: name, id, from, to, side_effects: sideEffects };
    }
    case 'sequence': {
      // isValidTransition above already enforced the registry matrix
      // (draft→active|archived, active→archived); updateSequence persists it.
      updateSequence({ id, status: to as SequenceStatus }, cwd);
      return { entity: name, id, from, to, side_effects: sideEffects };
    }
    default:
      throw new EntityOperationUnsupportedError(
        name,
        'transition',
        `Lifecycle transitions for ${name} not yet wired.`,
      );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Stamp provenance on a state-resident record (plan, decision, constraint, trap)
 * immediately after create. Writes one extra persistState call; acceptable for
 * v1 since create is infrequent compared to reads.
 */
function stampProvenanceOnStateItem(
  name: 'plan' | 'decision' | 'constraint' | 'trap',
  id: string,
  provenance: Provenance,
  cwd: string,
): void {
  const state = loadState(cwd);
  const bucket = name === 'plan' ? state.plan_items
    : name === 'decision' ? state.recent_decisions
    : name === 'constraint' ? state.active_constraints
    : state.known_traps;
  const item = (bucket as Array<Record<string, unknown>>).find((x) => x.id === id);
  if (!item) return;
  item.provenance = provenance;
  persistState(state, cwd);
}

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Missing required field: ${field}`);
  }
  return value;
}

function optionalSequenceItems(data: Record<string, unknown>): SequenceItemInput[] | undefined {
  if (!('items' in data) || data.items === undefined || data.items === null) return undefined;
  if (!Array.isArray(data.items)) {
    throw new Error(`Invalid value for 'items': expected an array of sequence item objects`);
  }
  return data.items as SequenceItemInput[];
}

/**
 * Validates that data[field] is one of `validValues`, throwing a clear
 * error message when the value is invalid. Fixes the silent-data-loss bug
 * documented in candidate can_a3458961 + pln#509 step 1: previously the
 * create path used unchecked `as` casts on enum fields, so invalid values
 * (e.g. outcome:'accepted' instead of 'approved') were written to disk and
 * then silently skipped at load time by the strict Zod parser. Now we
 * validate at write time against the same valid-value lists used by the
 * load-time schemas.
 *
 * Callers pass `XxxSchema.options` (a readonly tuple of valid strings)
 * rather than the schema itself — this avoids brittle generic constraints
 * on Zod's enum type which differs between major versions.
 */
function requireEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  validValues: readonly T[],
  opts: { optional?: boolean } = {},
): T | undefined {
  const value = data[field];
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new Error(`Missing required field: ${field}`);
  }
  if (typeof value !== 'string' || !(validValues as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid value for '${field}': got ${JSON.stringify(value)}. Expected one of: ${validValues.join(' | ')}`,
    );
  }
  return value as T;
}

/**
 * Validates that, if `patch[field]` is present (and not null/undefined), it
 * matches one of `validValues`. Used by updateEntity for enum-shaped patch
 * fields, to extend the same validation parity used at create time. Codex
 * round 1 (pln#509 step 1 review) correctly flagged that updateEntity was
 * still vulnerable to the same silent persistence bug when patching enum
 * fields with invalid values. Fields not present in `patch` are ignored.
 */
function validatePatchEnum(
  patch: Record<string, unknown>,
  field: string,
  validValues: readonly string[],
): void {
  if (!(field in patch)) return;
  const value = patch[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !(validValues as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid value for '${field}' in patch: got ${JSON.stringify(value)}. Expected one of: ${validValues.join(' | ')}`,
    );
  }
}
