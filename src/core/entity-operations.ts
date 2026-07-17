/**
 * Entity Operations — dispatch layer between the canonical CRUD verbs
 * (bclaw_find/get/create/update/remove/transition) and the entity-specific
 * code in src/core/*.
 *
 * Phase 3 slice 3b (pln_c6472192). Keeps imperative code where it lives
 * (per P6.2) — this module only routes.
 *
 * Write-verb wiring is per entity. An unwired write verb picks its error from
 * the registry's writePolicy (pln#625 Phase 2): a `system` entity (session,
 * inbox_message, instruction, assignment, agent_run, action) reports the
 * curated `SystemManagedError` naming its authorized path; an agent-ownable one
 * (default) reports `EntityOperationUnsupportedError` ("not yet wired"). An
 * unknown entity name is rejected at the front door with `UnknownEntityError`.
 */

import path from 'node:path';
import { loadState, mutateState } from './state.js';
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
import {
  findActiveClaimsForPlan,
  listClaims,
  loadClaim,
  logCascadeReleaseResult,
  markClaimStale,
  releaseClaimsCascade,
  releaseClaimWithCascade,
  saveClaim,
  type ReleaseClaimAuth,
} from './claims.js';
import { listActionRequired } from './actions.js';
import { listAgentIdentities } from './agent-registry.js';
import { getCapabilityProfile, getSpawnableAgents } from './agent-capability.js';
import { buildReputationSnapshot, toPublicReputationSummary } from './reputation.js';
import { loadAllSessions } from './identity.js';
import { loadInstructions } from './instructions.js';
import { deleteAssignment, listAssignments, loadAssignment, saveAssignment, transitionAssignment } from './assignments.js';
import { listAgentRuns } from './agentruns.js';
import { reconcileAgentRun, reconcileDeadPidRunningAgentRunAtRead, TERMINAL_STATUSES } from './agentrun-reconciler.js';
import { isObserverMode } from './observer-mode.js';
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
} from './operations/plan.js';
import {
  ENTITY_NAMES,
  ENTITY_REGISTRY,
  isValidTransition,
  type EntityName,
} from './entity-registry.js';
import { generateId } from './ids.js';
import { mergeHandoffReview } from './handoff-review.js';
import {
  CandidateTypeSchema,
  ConstraintCategorySchema,
  DecisionOutcomeSchema,
  HandoffContractSchema,
  HandoffReviewSchema,
  MemoryVisibilitySchema,
  PlanTypeEnumSchema,
  PrioritySchema,
  RuntimeNoteTypeSchema,
  SequenceStatusSchema,
  SeveritySchema,
} from './schema.js';
import type {
  AgentIdentityDocument,
  AssignmentStatus,
  Candidate,
  Constraint,
  Decision,
  HandoffContract,
  HandoffReview,
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

function isLegacyProvenance(item: Record<string, unknown>): boolean {
  return (item.provenance as Provenance | undefined)?.kind === 'legacy';
}

function isLowConfidenceAutoReflect(item: Record<string, unknown>, filter: EntityFilter): boolean {
  const provenance = item.provenance as Provenance | undefined;
  if (provenance?.kind !== 'auto_reflect') return false;
  const threshold = typeof filter.minAutoReflectConfidence === 'number'
    ? filter.minAutoReflectConfidence
    : DEFAULT_MIN_AUTO_REFLECT_CONFIDENCE;
  return (provenance.confidence ?? 0) < threshold;
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

/**
 * Thrown when a write verb targets a `writePolicy:'system'` entity via a verb
 * that is not agent-wired: the runtime owns these records, so this is a
 * deliberate "not agent-writable" boundary, NOT a "coming soon" gap. Names the
 * authorized path (writePolicyNote) so the caller knows where the write really
 * happens. pln#625 Phase 2 — replaces the misleading "not yet wired. Use the
 * legacy tool" for system entities.
 */
export class SystemManagedError extends Error {
  constructor(entity: EntityName, verb: string, note?: string) {
    super(
      // Verb-scoped, not entity-scoped: some system entities have OTHER wired
      // verbs (e.g. assignment transition/update), so don't claim the whole
      // entity is unwritable — only that THIS verb is not an agent-facing
      // grammar path for it.
      `bclaw_${verb}(entity='${entity}'): ${entity} is system-managed — bclaw_${verb} is not available for it via the canonical grammar.`
      + (note ? ` ${note}.` : ''),
    );
    this.name = 'SystemManagedError';
  }
}

/**
 * Pick the right "this write verb isn't available" error for an unwired entity,
 * from the registry data (no per-switch string drift): a system-managed entity
 * gets the SystemManagedError boundary; an agent-ownable one gets the
 * "not yet wired" signal. Call this from a write verb's switch DEFAULT only —
 * explicitly-wired verbs return before reaching it.
 */
function writeUnsupported(name: EntityName, verb: string): Error {
  const spec = ENTITY_REGISTRY[name];
  if (spec?.writePolicy === 'system') {
    return new SystemManagedError(name, verb, spec.writePolicyNote);
  }
  // Preserve the transition-specific hint the old default carried, so an
  // agent-ownable-but-unwired transition (e.g. handoff) keeps its precise
  // message rather than the generic "use the legacy tool" filler.
  const hint = verb === 'transition' ? `Lifecycle transitions for ${name} not yet wired.` : undefined;
  return new EntityOperationUnsupportedError(name, verb, hint);
}

/**
 * Thrown when a canonical verb is called with an entity name that is not in the
 * registry at all (e.g. bclaw_update(entity='agent')). Previously such a name
 * reached `ENTITY_REGISTRY[name].updatable` and died on a raw TypeError
 * ("Cannot read properties of undefined") — a leaked internal, not an
 * operator-legible error. This front-door guard turns it into a curated message
 * that lists the addressable entities (pln#625 Phase 1).
 */
export class UnknownEntityError extends Error {
  constructor(entity: string, verb: string) {
    super(
      `bclaw_${verb}(entity='${entity}') — unknown entity. ` +
      // Deliberately "registered", not "supported": some listed entities are
      // not yet wired for every verb (they return EntityOperationUnsupportedError,
      // a different, already-curated signal). Don't imply all are writable here.
      // NB agent is now a registered read-only entity (pln#625 Phase 2c): a write
      // verb on it reaches the SystemManagedError boundary, not this front door.
      `Registered entities (not all are wired for every verb yet): ${ENTITY_NAMES.join(', ')}.`,
    );
    this.name = 'UnknownEntityError';
  }
}

/**
 * Front-door guard for every canonical verb: reject an entity name that is not
 * in the registry with a curated UnknownEntityError instead of letting it fall
 * through to a raw property access. `name` is typed EntityName at the call
 * sites, but the MCP layer passes an unvalidated string (entity is a free
 * string on the published surface), so this runtime check is load-bearing.
 */
function assertKnownEntity(name: string, verb: string): void {
  if (!Object.prototype.hasOwnProperty.call(ENTITY_REGISTRY, name)) {
    throw new UnknownEntityError(name, verb);
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

/**
 * Canonical declaration of the bclaw_find/get FILTER grammar — the single
 * source of truth for BOTH the MCP handler's validation and the governance
 * fingerprint. Entity reachability lives in ENTITY_NAMES; this covers the
 * filter contract, which is otherwise invisible to the published inputSchema
 * (`filter` is an unconstrained object). Folded into the governance fingerprint
 * (pln#625, Codex review of PR #82) so adding/renaming/re-scoping a filter key
 * — or changing an accepted value — forces a changelog entry, closing the same
 * blind-spot class as free-string `entity`.
 */
export const GRAMMAR_FILTER_CONTRACT = {
  /** Accepted for ANY entity. */
  common: [
    'status', 'tag', 'tags', 'author', 'plan_id', 'source', 'auto_generated',
    'limit', 'offset', 'includeLegacy', 'minAutoReflectConfidence',
  ],
  /** Keys accepted ONLY for the named entity (rejected with a validation_error elsewhere). */
  entityScoped: {
    agent_run: ['assignment_id', 'claim_id', 'message_id'],
    agent: ['scope', 'includeReputation'],
  },
  /** Filter keys whose value is constrained to a fixed set. */
  constrainedValues: {
    scope: ['project', 'global'],
  },
  /**
   * Filter keys whose value MUST be a boolean. Validated at the MCP front door
   * so a stringy `"true"` is rejected loudly instead of silently coercing to a
   * no-op (loadAgentsForRead requires a strict `=== true`). Codex review of #83.
   */
  booleanKeys: ['includeReputation'],
} as const;

export interface ListResult<T = unknown> {
  entity: EntityName;
  total: number;
  items: T[];
  /** Matches hidden by the default provenance filter. */
  excluded_legacy?: number;
  /** Auto-reflect records hidden below minAutoReflectConfidence. */
  excluded_low_confidence_auto_reflect?: number;
  /** Matches before provenance filtering, after ordinary field filters. */
  total_before_provenance_filter?: number;
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
  // Observer mode (BRAINCLAW_OBSERVER=1) suppresses the lazy reconciliation
  // pass. A dashboard reading agent_run records must never transition them —
  // that loop drove the 2026-06-10 lock storm (every poll could mutate every
  // non-terminal run, holding the mutation lock under each transition).
  if (isObserverMode()) return runs;
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
  assertKnownEntity(name, 'find');
  const all = loadAll(name, cwd, filter);
  const fieldFiltered = applyFieldFilter(all, filter);
  const excludedLegacy = filter.includeLegacy === true
    ? 0
    : fieldFiltered.filter((item) => isLegacyProvenance(item as Record<string, unknown>)).length;
  const excludedLowConfidenceAutoReflect = fieldFiltered.filter((item) =>
    isLowConfidenceAutoReflect(item as Record<string, unknown>, filter)
  ).length;
  const filtered = fieldFiltered.filter((item) => passesProvenanceFilter(item as Record<string, unknown>, filter));
  const paged = applyPaging(filtered, filter);
  return {
    entity: name,
    total: filtered.length,
    items: paged,
    excluded_legacy: excludedLegacy,
    excluded_low_confidence_auto_reflect: excludedLowConfidenceAutoReflect,
    total_before_provenance_filter: fieldFiltered.length,
  };
}

export interface BoundedListResult<T = unknown> {
  /** Entity label — an EntityName for canonical lists, any label for other bounded payloads (search results, …). */
  entity: string;
  total: number;
  items: T[];
  /** Items actually returned (≤ total; may be < page size when size-bounded). */
  returned: number;
  /** True when more items exist beyond what was returned (pagination or size-bounding). */
  has_more: boolean;
  /** Offset to pass on the next bclaw_find call to continue. Present only when has_more. */
  next_offset?: number;
  /** Items dropped from this page solely to keep the payload under the size budget. */
  omitted_for_size?: number;
  /** Hint on how to fetch the rest. Present only when has_more. */
  hint?: string;
}

/** Default serialized-items budget (chars) — keeps a bclaw_find payload well under the ~25k-token MCP cap (trp#449). */
export const DEFAULT_FIND_CHAR_BUDGET = 40000;

/**
 * pln#491 — bound a list payload so a verbose result set never overflows the MCP
 * token cap (which makes agents silently fall back to the CLI, trp#449).
 * `listEntities` already caps COUNT (default 50 via applyPaging); this additionally
 * caps SIZE: if the serialized items exceed `charBudget`, the page is shrunk until
 * it fits (always keeping at least one item). Either way the result advertises
 * has_more / next_offset / a hint so the caller paginates explicitly instead of
 * guessing or falling back to the terminal.
 */
export function boundListResult<T = unknown>(
  result: { entity: string; total: number; items: T[] },
  offset: number,
  charBudget = DEFAULT_FIND_CHAR_BUDGET,
): BoundedListResult<T> {
  let items = result.items;
  let omittedForSize = 0;
  while (items.length > 1 && JSON.stringify(items).length > charBudget) {
    const drop = Math.max(1, Math.ceil(items.length * 0.25));
    items = items.slice(0, items.length - drop);
    omittedForSize = result.items.length - items.length;
  }
  const returned = items.length;
  const hasMore = offset + returned < result.total;
  const bounded: BoundedListResult<T> = {
    ...result,
    items,
    returned,
    has_more: hasMore,
    ...(omittedForSize > 0 ? { omitted_for_size: omittedForSize } : {}),
  };
  if (hasMore) {
    bounded.next_offset = offset + returned;
    bounded.hint = omittedForSize > 0
      ? `Payload size-bounded: returned ${returned} of ${result.total} ${result.entity} item(s). Fetch more with filter.offset=${bounded.next_offset}, or narrow the filter (status/tag/author).`
      : `Returned ${returned} of ${result.total} ${result.entity} item(s). Page with filter.offset=${bounded.next_offset}, or narrow the filter.`;
  }
  return bounded;
}

/**
 * Redacted read-only projection of an agent identity (pln#625 Phase 2c;
 * refined by ideation loop lop_f8e8d18cb8c27ada). Shared by the grammar
 * (find/get) AND bclaw_list_agents so redaction has ONE source of truth.
 *
 * Strict ALLOW-LIST — any field added to AgentIdentityDocument later stays
 * hidden until someone deliberately projects it here:
 *  - identity_key (private-ish key material: the PEM public_key) is dropped.
 *  - `fingerprint` is the sha256(PEM) — the PUBLIC canonical key id, equal to
 *    the cloud's agents.key_fingerprint — so it is exposed IN FULL: truncating
 *    it added no confidentiality (a hash never reveals its preimage; the id is
 *    public) and broke the whole point (matching a local key against the
 *    256-bit remote fingerprint).
 *  - `invoke` is intentionally NOT projected: it is populated by no writer and
 *    read by no spawn path (buildInvokeCommand uses the capability profile, not
 *    identity.invoke), so exposing it was dead surface — and it would leak
 *    invoke.command (spawn flags, possibly tokens) verbatim.
 * `short_label` mirrors agent_name so the generic getEntity matcher resolves an
 * agent by id OR name (same trick as session's session_id→id alias).
 */
export function projectAgentForRead(doc: AgentIdentityDocument): Record<string, unknown> {
  return {
    id: doc.agent_id,
    short_label: doc.agent_name,
    name: doc.agent_name,
    kind: doc.kind,
    trust_level: doc.trust_level,
    capabilities: doc.capabilities,
    fingerprint: doc.identity_key?.fingerprint,
    model: doc.model,
    context_profile: doc.context_profile,
    created_at: doc.created_at,
  };
}

/**
 * Catalog-only stub for a spawnable agent that is NOT in this project's
 * registry (scope='global' only). It has no identity document, so only the
 * name + dispatchability are known.
 */
function projectCatalogAgentForRead(name: string): Record<string, unknown> {
  return {
    id: null,
    short_label: name,
    name,
    kind: null,
    trust_level: null,
    capabilities: [],
    dispatchable: true,
    registered: false,
  };
}

/**
 * Load agents for a read (pln#625 Phase 2c, hybrid scope from lop_f8e8d18cb8c27ada).
 * Default scope = the CURRENT PROJECT's registry (`.brainclaw/agents`, exactly
 * what `list-agents` reads — there is NO global registry on disk). scope='global'
 * additionally unions the static dispatchable catalog (getSpawnableAgents) and
 * annotates each entry with `dispatchable` (canBeSpawnedCli) + `registered`
 * (present in this project's registry) — the honest inventory a coordinator
 * needs, since bclaw_dispatch resolves candidates from that catalog, NOT from
 * the project registry.
 */
function loadAgentsForRead(cwd: string, filter?: EntityFilter): Record<string, unknown>[] {
  // Opt-in reputation join (pln#625 — folds the sole capability bclaw_list_agents
  // had that find(agent) lacked, so that tool can be retired). Keyed by agent_id,
  // which the projection exposes as `id`; catalog-only agents carry no reputation.
  const reputationById = filter?.includeReputation === true
    ? new Map((buildReputationSnapshot(cwd).agents ?? []).map((a) => [a.agent_id ?? a.key, toPublicReputationSummary(a)]))
    : undefined;
  const project = (doc: AgentIdentityDocument): Record<string, unknown> => {
    const row = projectAgentForRead(doc);
    if (reputationById) row.reputation = reputationById.get(String(row.id));
    return row;
  };
  const registered = listAgentIdentities(cwd).map(project);
  const scope = typeof filter?.scope === 'string' ? filter.scope : 'project';
  if (scope !== 'global') return registered;

  const byName = new Map<string, Record<string, unknown>>();
  for (const a of registered) {
    a.registered = true;
    a.dispatchable = getCapabilityProfile(String(a.name))?.runtime.canBeSpawnedCli ?? false;
    byName.set(String(a.name), a);
  }
  for (const { name } of getSpawnableAgents()) {
    const existing = byName.get(name);
    if (existing) { existing.dispatchable = true; continue; }
    byName.set(name, projectCatalogAgentForRead(name));
  }
  return [...byName.values()];
}

function loadAll(name: EntityName, cwd: string, filter?: EntityFilter): unknown[] {
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
    // pln#625 Phase 2c — agent is READ-ONLY via the grammar, redacted projection.
    // Default scope = current project's registry; filter.scope='global' unions
    // the dispatchable catalog. See loadAgentsForRead.
    case 'agent':               return loadAgentsForRead(cwd, filter);
    case 'cross_project_link':  return resolveCrossProjectLinks(cwd);
    // pln#625 Phase 2 — wire the previously-unwired reads.
    case 'step':                return loadState(cwd).plan_items.flatMap((p) => p.steps ?? []);
    // session is keyed by session_id, not id — alias it so get/find match on either.
    case 'session':             return loadAllSessions(cwd).map((s) => ({ ...s, id: s.session_id }));
    case 'instruction':         return loadInstructions(cwd);
    case 'inbox_message':
      // Messages are inherently per-agent; the canonical find/get has no agent
      // scope and there is no cross-agent aggregate loader. Route reads to the
      // dedicated per-agent tool instead of inventing a misleading global list.
      throw new EntityOperationUnsupportedError(
        name,
        'find',
        'Messages are per-agent — read them via bclaw_read_inbox(agent=…), not the canonical grammar.',
      );
    default:
      throw new EntityOperationUnsupportedError(name, 'find');
  }
}

function applyFieldFilter(items: unknown[], filter: EntityFilter): unknown[] {
  let result = items as Array<Record<string, unknown>>;
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
  assertKnownEntity(name, 'get');
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
  assertKnownEntity(name, 'create');
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
      throw writeUnsupported(name, 'create');
  }
}

// ─── UPDATE ────────────────────────────────────────────────────────────

export function updateEntity(
  name: EntityName,
  id: string,
  patch: Record<string, unknown>,
  cwd: string,
): UpdateResult {
  assertKnownEntity(name, 'update');
  const spec = ENTITY_REGISTRY[name];
  // An entity with NO updatable fields is not patchable via the grammar at all,
  // so route to the curated boundary (SystemManagedError for a system entity,
  // "not yet wired" otherwise) rather than the misleading "Fields not updatable
  // … use bclaw_transition" — which assumes a lifecycle the entity may not have
  // (e.g. agent, inbox_message have neither updatable fields nor transitions).
  // Entities with a non-empty updatable list (incl. the wired case 'assignment'
  // below) are unaffected. pln#625 Phase 2c.
  if (spec.updatable.length === 0) {
    throw writeUnsupported(name, 'update');
  }
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
    case 'claim': {
      // sprint 1.5 — description + worktree_path (manual-worktree registration).
      // Status changes still go through bclaw_transition / release flows.
      let claim;
      try {
        claim = loadClaim(id, cwd);
      } catch {
        throw new EntityNotFoundError(name, id);
      }
      const patched = { ...claim, ...patch } as typeof claim;
      saveClaim(patched, cwd);
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
    case 'handoff': {
      // pln#625 Phase 3 — wire the handoff update path (previously unwired: the
      // field check passed for narrative/tags but the switch fell to the default
      // "not yet wired"). Restores the review-state write capability lost when
      // update_handoff was removed at v1.0 — an agent can now write a review
      // verdict via bclaw_update(entity='handoff', data={review:{verdict,…}}).
      // review/contract are validated against their Zod schemas and MERGED onto
      // the record (same field-merge semantics as the review loop's core
      // applyHandoffUpdates); narrative/tags are set directly.
      // Validate on the WRITE path with .strict() so an unknown key (e.g. a
      // `review_verdict` typo that Zod would otherwise silently strip) is
      // rejected loudly, and require at least one recognized field so an empty
      // `{}` patch can't masquerade as a successful no-op (Codex review of #84).
      // The base read schema stays non-strict — historical handoffs may carry
      // extra fields.
      let parsedReview: HandoffReview | undefined;
      let parsedContract: HandoffContract | undefined;
      if (patch.review !== undefined) {
        const r = HandoffReviewSchema.strict().safeParse(patch.review);
        if (!r.success) {
          throw new Error(`Invalid handoff.review: ${r.error.issues.map((i) => i.message).join('; ')}`);
        }
        if (Object.keys(r.data).length === 0) {
          throw new Error('handoff.review patch has no recognized fields (nothing to update).');
        }
        parsedReview = r.data;
      }
      if (patch.contract !== undefined) {
        const c = HandoffContractSchema.strict().safeParse(patch.contract);
        if (!c.success) {
          throw new Error(`Invalid handoff.contract: ${c.error.issues.map((i) => i.message).join('; ')}`);
        }
        if (Object.keys(c.data).length === 0) {
          throw new Error('handoff.contract patch has no recognized fields (nothing to update).');
        }
        parsedContract = c.data;
      }
      mutateState((state) => {
        const item = state.open_handoffs.find((h) => h.id === id);
        if (!item) throw new EntityNotFoundError(name, id);
        // Tip guard (mirrors transition): a superseded handoff is a frozen
        // tombstone — refuse to mutate it, point at the tip.
        if (typeof item.superseded_by === 'string' && item.superseded_by) {
          throw new Error(
            `Handoff '${id}' was superseded by ${item.superseded_by} and is an immutable tombstone. `
            + `Update the current tip (${item.superseded_by}) instead.`,
          );
        }
        if (patch.narrative !== undefined) item.narrative = patch.narrative as string;
        if (patch.tags !== undefined) item.tags = patch.tags as string[];
        // Review merge + reviewed_at stamping via the shared core helper (single
        // source of truth with applyHandoffUpdates — no drift between paths).
        if (parsedReview !== undefined) {
          item.review = mergeHandoffReview(item.review, parsedReview);
        }
        if (parsedContract !== undefined) {
          item.contract = { ...(item.contract ?? {}), ...parsedContract };
        }
      }, cwd);
      return { entity: name, id };
    }
    default:
      throw writeUnsupported(name, 'update');
  }
}

// ─── REMOVE ────────────────────────────────────────────────────────────

export function removeEntity(
  name: EntityName,
  id: string,
  cwd: string,
  purge: boolean = false,
): RemoveResult {
  assertKnownEntity(name, 'remove');
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
      throw writeUnsupported(name, 'remove');
  }
}

// ─── TRANSITION ───────────────────────────────────────────────────────

/**
 * Optional caller identity threaded into a transitionEntity call. Currently
 * only `claim` transitions consume it (release ownership + coordinator override
 * audit trail — pln#562 step 5 / trp#928). Other entities ignore it.
 */
export interface TransitionAuth {
  agent?: string;
  agent_id?: string;
  session_id?: string;
  /** Coordinator override: allowed to release/stale another principal's claim. Audited. */
  override?: boolean;
}

export function transitionEntity(
  name: EntityName,
  id: string,
  to: string,
  cwd: string,
  _reason?: string,
  auth?: TransitionAuth,
): TransitionResult {
  assertKnownEntity(name, 'transition');
  const spec = ENTITY_REGISTRY[name];
  if (!spec.statusField) {
    throw new Error(`${name} has no lifecycle (statusField is undefined)`);
  }
  const statusField = spec.statusField;
  const current = getEntity(name, id, cwd) as Record<string, unknown>;
  const from = current[statusField] as string | undefined;
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
      // trp#928 — implement the `release_linked_claims_if_last` cascade tag.
      // Before this landing the tag was advertised by the entity registry but
      // the imperative cascade never ran, so a plan closed while its worker
      // claims stayed active (ghost claims). The cascade now:
      //  - runs only on plan → done (the tag's actual trigger)
      //  - releases each active claim linked via plan_id
      //  - LOGS per claim (released / skipped+reason / error) via the runtime
      //    event journal so `bclaw_find(entity=agent_run)` and dashboards can
      //    observe silent ownership failures instead of guessing at them.
      // Ownership check: this path runs from bclaw_transition, so it inherits
      // the caller's TransitionAuth (populated for entity='claim' but not for
      // entity='plan'). auth undefined = system convergence (bypass ownership),
      // matching the historical implicit contract for plan cascades.
      if (to === 'done') {
        const linked = findActiveClaimsForPlan(id, cwd);
        if (linked.length > 0) {
          const cascade = releaseClaimsCascade(linked.map((c) => c.id), { cwd });
          logCascadeReleaseResult({
            actor: 'system',
            trigger: 'plan_done',
            plan_id: id,
            cascade,
            cwd,
          });
        }
      }
      return { entity: name, id, from, to, side_effects: sideEffects };
    }
    case 'decision':
    case 'constraint':
    case 'trap': {
      mutateState((state) => {
        const bucket = name === 'decision' ? state.recent_decisions
          : name === 'constraint' ? state.active_constraints
          : state.known_traps;
        const item = bucket.find((x) => x.id === id);
        if (!item) throw new EntityNotFoundError(name, id);
        (item as Record<string, unknown>)[statusField] = to;
      }, cwd);
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
    case 'claim': {
      // trp#928 — the entity registry advertised `active → released|stale` but
      // transitionEntity never routed for entity=claim. The isValidTransition
      // check above passed for anyone calling `bclaw_transition(entity='claim',
      // to='released')`, but the transition then fell through to the
      // EntityOperationUnsupportedError default. Now: released hits the same
      // cascade path bclaw_release_claim uses (audit + plan-done cascade); stale
      // uses markClaimStale (audit + `stale` terminal status). Reuses ReleaseClaimAuth
      // so a trusted+ coordinator can release across ownership with override.
      const releaseAuth: ReleaseClaimAuth | undefined = auth
        ? { agent: auth.agent, agent_id: auth.agent_id, session_id: auth.session_id, override: auth.override }
        : undefined;
      if (to === 'released') {
        releaseClaimWithCascade(id, { planStatus: _reason === 'done' ? 'done' : undefined, cwd, auth: releaseAuth });
        return { entity: name, id, from, to, side_effects: sideEffects };
      }
      if (to === 'stale') {
        markClaimStale(id, cwd, releaseAuth);
        return { entity: name, id, from, to, side_effects: sideEffects };
      }
      // isValidTransition already excluded every other target — belt-and-braces:
      throw new InvalidTransitionError(name, from, to);
    }
    case 'handoff': {
      // pln#625 Phase 2a — wire the handoff lifecycle (open→accepted|closed,
      // accepted→closed; the matrix is enforced by isValidTransition above).
      // This also repairs `brainclaw stale resolve <handoff-id>`, which routes
      // through bclaw_transition(entity='handoff') and previously fell to the
      // "not yet wired" default (trp_ed1a21eb).
      //
      // Tip guard: a handoff carrying `superseded_by` is the frozen original a
      // correction replaced — correctHandoff leaves it immutable and pushes the
      // correction as the new tip (mcp-write-entities.ts:356). Transitioning a
      // superseded record would mutate frozen history, so refuse it and point at
      // the tip, mirroring correctHandoff's own guard.
      if (typeof current.superseded_by === 'string' && current.superseded_by) {
        throw new Error(
          `Handoff '${id}' was superseded by ${current.superseded_by} and is an immutable tombstone. `
          + `Transition the current tip (${current.superseded_by}) instead.`,
        );
      }
      mutateState((state) => {
        const item = state.open_handoffs.find((h) => h.id === id);
        if (!item) throw new EntityNotFoundError(name, id);
        (item as Record<string, unknown>)[statusField] = to;
      }, cwd);
      return { entity: name, id, from, to, side_effects: sideEffects };
    }
    default:
      // pln#625 Phase 2 — system-managed entities (action/agent_run) report the
      // curated "system-managed" boundary; agent-ownable-but-unwired ones keep
      // the "not yet wired" signal.
      throw writeUnsupported(name, 'transition');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Stamp provenance on a state-resident record (plan, decision, constraint, trap)
 * immediately after create.
 */
function stampProvenanceOnStateItem(
  name: 'plan' | 'decision' | 'constraint' | 'trap',
  id: string,
  provenance: Provenance,
  cwd: string,
): void {
  mutateState((state) => {
    const bucket = name === 'plan' ? state.plan_items
      : name === 'decision' ? state.recent_decisions
      : name === 'constraint' ? state.active_constraints
      : state.known_traps;
    const item = (bucket as Array<Record<string, unknown>>).find((x) => x.id === id);
    if (!item) return;
    item.provenance = provenance;
  }, cwd);
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
