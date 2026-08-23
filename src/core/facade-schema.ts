import { z } from 'zod';
import { LoopLinksSchema } from './loops/types.js';

export const ExecutionStatusSchema = z.enum(['delivered_and_started', 'command_ready_manual', 'inbox_only']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const WorkIntentSchema = z.enum(['execute', 'consult', 'resume', 'review']);
// pln#626 — coordinate intents split into three honest contracts:
//  • SPAWNING (assign / review / reroute, + multi-agent ideate): create a claim
//    + worktree and, when autoExecute is on, spawn a worker on the brief.
//    'ideate' with targetAgents advances to critique and spawns one
//    worktree-isolated critic worker per target (Phase 2, Option B); single-
//    agent ideate just opens the loop for the champion to drive manually via
//    bclaw_loop intent='turn'/'advance'.
//  • INBOX-ONLY (consult): delivers the brief to the target inbox; autoExecute
//    is a no-op here (never silently ignored).
//  • READ-ONLY (summarize): reads a thread and returns a summary — no claim,
//    no dispatch, no execution_status; autoExecute is irrelevant.
export const CoordinateIntentSchema = z.enum(['assign', 'consult', 'review', 'reroute', 'summarize', 'ideate']);

export const WorkRequestSchema = z.object({
  intent: WorkIntentSchema,
  scope: z.string().optional(),
  planId: z.string().optional(),
  task: z.string().optional(),
  messageId: z.string().optional(),
  contextTarget: z.string().optional(),
  project: z.string().optional(),
  compact: z.boolean().optional().default(true),
  /**
   * Approximate token budget for the context payload (agent-ux, pln#542).
   * Relevance-ranked fill: the highest-scoring items are kept until the
   * budget is reached (~4 chars/token heuristic). Applies to both compact
   * and full payloads.
   */
  budget_tokens: z.number().int().positive().optional(),
});

export const CoordinateRequestSchema = z.object({
  intent: CoordinateIntentSchema,
  task: z.string(),
  scope: z.string().optional(),
  targetAgents: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  threadId: z.string().optional(),
  /** Optional pipeline provenance persisted when open_loop creates a loop. */
  linked: LoopLinksSchema.optional(),
  autoExecute: z.boolean().optional(),
  /**
   * When intent=review and open_loop=true, a review Loop is opened on top of
   * the review candidate: author slot = caller, reviewer slots = targetAgents.
   * The candidate is linked as a change_summary artifact and the loop is
   * advanced to `findings`, emitting a `turn_assigned` event for each
   * reviewer slot. Default false for strict backward compatibility with
   * existing `review` callers. See docs/concepts/loop-engine.md §Automation.
   */
  open_loop: z.boolean().optional(),
  /**
   * Optional override: asymmetric (classical author→reviewer handoff) or
   * symmetric (each reviewer turn may apply fixes, halving round-trips).
   * Ignored when open_loop is false. Defaults to asymmetric.
   */
  review_mode: z.enum(['asymmetric', 'symmetric']).optional(),
  /**
   * pln#533: when opening a review Loop (open_loop=true), run a trivial
   * validation spawn against each reviewer agent first so an environment death
   * (config rejected, auth fail, model mismatch) surfaces instantly with a
   * clear reason instead of a generic loop timeout. Defaults to true for
   * open_loop reviews; set false to skip (e.g. when you have just spawn-checked
   * the agents yourself). Ignored when open_loop is false or BRAINCLAW_NO_SPAWN
   * is set.
   */
  preflight: z.boolean().optional(),
  /**
   * Caller-minted ULID/UUIDv7 for idempotent retries. Today this is observed
   * on intent='review' + open_loop=true: a retry with the same
   * client_request_id returns the cached {candidate_id, loop_id} response
   * without creating a duplicate candidate + loop. Safe to pass on other
   * intents — silently ignored.
   */
  client_request_id: z.string().min(1).optional(),
  /**
   * pln#359 phase 1b — route the dispatch into a linked project. When set,
   * claim, assignment, and inbox message all land in the target project
   * (resolved via resolveProjectCwd against cross_project_links + workspace
   * store-chain children). Auto-spawn is disabled when project is set —
   * the target agent picks up the brief async via its own bclaw_work.
   */
  project: z.string().optional(),
  /**
   * Bypass the pre-flight uncommitted-changes check (can_30c295b4 fix).
   * By default, bclaw_coordinate refuses dispatches when the source cwd
   * has uncommitted modifications, because the dispatched worker spawns
   * from HEAD and won't see them — leading to silent review on stale code.
   * Set allow_dirty=true to override (e.g. when the caller knows the
   * dispatched work doesn't depend on the dirty files, or when running
   * tests). Has no effect when the source cwd is not a git repo.
   */
  allow_dirty: z.preprocess(
    // MCP clients that don't know allow_dirty is a boolean (it was previously
    // absent from the published inputSchema) send the string "true"/"false".
    // Coerce those so the documented escape hatch actually works; leave real
    // booleans and undefined untouched.
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() === 'true' : value),
    z.boolean().optional(),
  ),
  /**
   * pln#520 Tier 2 (P2c) — explicit git ref (commit / branch / tag) the
   * dispatched worker should build its worktree from, instead of the default
   * HEAD. When set on a worktree-creating intent (assign / review / reroute),
   * the worktree is checked out at this ref, so uncommitted working-tree
   * changes in the source are intentionally out of scope and the scope-aware
   * dirty guard allows the dispatch. Passed through to
   * createCoordinatorClaim's worktreeBaseRef. Ignored by intents that don't
   * create a worktree (consult / ideate / summarize).
   */
  ref: z.string().min(1).optional(),
  /**
   * pln#511 step 2 — loop preset selector. When set on intent='ideate',
   * the handler bypasses the kind-default ideation phases and opens the
   * loop with the named preset's phases / stop_condition / protocol.
   * v1 ships a single preset ('bootstrap', see src/core/loops/presets/).
   * The handler validates the name against the preset registry and
   * rejects unknown names with `unknown_preset`. Presets are kind-
   * specific: passing `preset` with any intent other than 'ideate' is
   * rejected as `preset_kind_mismatch`.
   */
  preset: z.string().min(1).optional(),
  /**
   * pln#520 step 3 / pln#606 — model to run on the spawned worker, decoupled
   * from agent identity. Passed through to `resolveModel({ override })` and
   * injected as `<model_flag> <model>` into the invoke command for agents that
   * declare a `model_flag` (e.g. `claude-code --model sonnet`, `codex exec
   * --model …`, `copilot --model …`). No-op for agents whose template already
   * pins a model (e.g. the `claude-sonnet` pseudo-identity) or that declare no
   * `model_flag`. Highest-priority link in the model resolution chain. Ignored
   * by intents that don't spawn a worker (summarize). Mirrors the CLI
   * `brainclaw dispatch run --model <name>` flag for CLI/MCP parity.
   */
  model: z.string().min(1).optional(),
});

export const FacadeArtifactSchema = z.object({
  type: z.string(),
  id: z.string(),
  path: z.string().optional(),
});

export const FacadeSideEffectSchema = z.object({
  action: z.string(),
  entity: z.string(),
  id: z.string(),
});

/**
 * Self-documenting verification hint attached to dispatch responses (pln#503
 * phase 3.3). Tells the caller exactly which canonical-grammar call to make
 * next to verify the spawn is actually doing work — `delivered_and_started`
 * is a brief-ack signal, not proof of life. See dispatch-lifecycle.md.
 */
export const VerifyWithSchema = z.object({
  action: z.literal('bclaw_find'),
  entity: z.literal('agent_run'),
  filter: z.object({ assignment_id: z.string() }),
  /** Human-readable description of what to look for in the result. */
  expected_when_alive: z.string(),
  /** Doc pointer for the diagnostic flow when the check fails. */
  see_also: z.string(),
});
export type VerifyWith = z.infer<typeof VerifyWithSchema>;

/**
 * Self-teaching affordance (agent-ux, pln#542): each response carries the
 * recommended next call(s) with exact shapes, generalizing the verify_with
 * pattern. Protocol teaching lives in responses, not the instruction file.
 */
export const NextActionSchema = z.object({
  /** Tool to call next, e.g. "bclaw_release_claim". */
  tool: z.string(),
  /** Exact argument shape for the call (literal values where known, <placeholders> otherwise). */
  args: z.record(z.string(), z.unknown()).optional(),
  /** When this action applies, e.g. "when implementation is complete". */
  when: z.string().optional(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

/**
 * pln#635 — structured warning. ADDITIVE sibling of `warnings: string[]`, which
 * keeps its type and its exact historical contents (the legacy string is
 * derived from this record — see core/warnings.ts). Five handler sites were
 * already encoding structure into a string via JSON.stringify because there was
 * nowhere else to put it; this is that nowhere.
 *
 * `next_actions` is what the string channel could never carry: the recovery
 * path. A warning an agent cannot act on is just noise it learns to skip.
 */
export const WarningDetailSchema = z.object({
  /** Stable machine-readable identifier, e.g. "scope_already_claimed". */
  code: z.string(),
  /** Human-readable prose. Also the legacy string for non-JSON codes. */
  message: z.string(),
  /** Structured payload (ids, agents, scopes) the prose mentions. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** How to resolve it — same contract as the response-level next_actions. */
  next_actions: z.array(NextActionSchema).optional(),
});
export type WarningDetail = z.infer<typeof WarningDetailSchema>;

export const FacadeResponseSchema = z.object({
  status: z.enum(['ok', 'error', 'partial']),
  intent: z.string(),
  result: z.unknown(),
  artifacts: z.array(FacadeArtifactSchema),
  side_effects: z.array(FacadeSideEffectSchema),
  error: z.string().optional(),
  duration_ms: z.number().optional(),
  claim_status: z.enum(['created', 'existing', 'none']).optional(),
  session_id: z.string().optional(),
  warnings: z.array(z.string()),
  execution_status: ExecutionStatusSchema.optional(),
  /**
   * pln#626 Phase 1 — machine-readable reason accompanying execution_status
   * when it is not `delivered_and_started`: auto_execute_disabled (manual
   * handoff), not_spawnable, spawn_no_worktree/capacity/no_handshake/failed,
   * or intent_inbox_only (consult/ideate). Absent when everything spawned.
   */
  execution_reason: z.string().optional(),
  /** pln#503 phase 3.3: present when execution_status === 'delivered_and_started'. */
  verify_with: VerifyWithSchema.optional(),
  /**
   * pln#513 step 1 — bclaw_work hint surfaced when the project lacks a usable
   * PROJECT.md (absent or zero bytes). True means the agent should consider
   * opening a bootstrap loop before assuming context; the literal call to
   * make is in `next_action`. False or absent means the project already has
   * a PROJECT.md and the bootstrap entry-point should not be offered.
   * Additive: existing callers that don't read it are unaffected.
   */
  bootstrap_recommended: z.boolean().optional(),
  /**
   * pln#557 step 3 — composite verdict behind `bootstrap_recommended`:
   *   'bootstrap' → no PROJECT.md AND sparse store: from-scratch entry-point
   *     (extract route or bootstrap loop per the shared empty-memory rule);
   *   'refresh'   → PROJECT.md missing on a RICH store, or fossil relative
   *     to recent commit/store activity: regenerate via
   *     bclaw_bootstrap(refresh: true), never from-scratch;
   *   'none'      → PROJECT.md present and current.
   * `bootstrap_recommended` stays the boolean projection (verdict !== 'none')
   * for backward compatibility.
   */
  bootstrap_verdict: z.enum(['bootstrap', 'refresh', 'none']).optional(),
  /**
   * pln#513 step 1 — literal MCP call to surface as the bootstrap entry-point
   * when `bootstrap_recommended` is true. Carries the canonical-grammar text
   * (`bclaw_coordinate(intent='ideate', preset='bootstrap')`) verbatim so the
   * CLI doesn't have to reconstruct it.
   */
  next_action: z.string().optional(),
  /**
   * agent-ux (pln#542): recommended follow-up calls with exact shapes —
   * the generalized affordance channel. `next_action` (singular, string)
   * remains for the bootstrap hint; new consumers should read this array.
   */
  next_actions: z.array(NextActionSchema).optional(),
  /**
   * pln#635 — structured warnings carrying a stable `code`, the `data` the prose
   * refers to, and the recovery `next_actions`. Optional and additive:
   * `warnings` keeps byte-identical contents, so a consumer ignoring this field
   * is unaffected.
   *
   * This is a structured **SUBSET**, not a mirror — `warnings` remains the
   * complete channel (see core/warnings.ts for why: handlers thread the string
   * array into helpers by reference). Read `warnings` for completeness; read
   * `warning_details` for the codes that carry a recovery path.
   */
  warning_details: z.array(WarningDetailSchema).optional(),
  /**
   * Code Map P0 (spec §10): opt-in, present ONLY when the project's Code Map
   * manifest carries `code_map_enabled: true`. Absent for every project that
   * has not turned Code Map on (the P0 default), so existing bclaw_work callers
   * are unaffected and the off-path adds no work. Shape mirrors
   * CodeMapWorkSection: { enabled, matches, freshness_badge, missing_index?,
   * lock_wait_ms? }. Passthrough so the section can evolve without a schema bump.
   */
  code_map: z.object({}).passthrough().optional(),
});

export type WorkIntent = z.infer<typeof WorkIntentSchema>;
export type CoordinateIntent = z.infer<typeof CoordinateIntentSchema>;
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export type CoordinateRequest = z.infer<typeof CoordinateRequestSchema>;
export type FacadeArtifact = z.infer<typeof FacadeArtifactSchema>;
export type FacadeSideEffect = z.infer<typeof FacadeSideEffectSchema>;
export type FacadeResponse = z.infer<typeof FacadeResponseSchema>;
