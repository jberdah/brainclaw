import { z } from 'zod';

export const ExecutionStatusSchema = z.enum(['delivered_and_started', 'command_ready_manual', 'inbox_only']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const WorkIntentSchema = z.enum(['execute', 'consult', 'resume', 'review']);
// pln#492 phase 2.c — 'ideate' opens an ideation loop with a proposal seed
// artifact. The handler does NOT yet dispatch turns (driver wire-up is
// phase 2.d). Callers receive loop_id and may drive the loop manually via
// bclaw_loop intent='turn' / 'advance' until the dispatch path lands.
export const CoordinateIntentSchema = z.enum(['assign', 'consult', 'review', 'reroute', 'summarize', 'ideate']);

export const WorkRequestSchema = z.object({
  intent: WorkIntentSchema,
  scope: z.string().optional(),
  planId: z.string().optional(),
  task: z.string().optional(),
  messageId: z.string().optional(),
  contextTarget: z.string().optional(),
  compact: z.boolean().optional().default(true),
});

export const CoordinateRequestSchema = z.object({
  intent: CoordinateIntentSchema,
  task: z.string(),
  scope: z.string().optional(),
  targetAgents: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  threadId: z.string().optional(),
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
  allow_dirty: z.boolean().optional(),
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
   * pln#513 step 1 — literal MCP call to surface as the bootstrap entry-point
   * when `bootstrap_recommended` is true. Carries the canonical-grammar text
   * (`bclaw_coordinate(intent='ideate', preset='bootstrap')`) verbatim so the
   * CLI doesn't have to reconstruct it.
   */
  next_action: z.string().optional(),
});

export type WorkIntent = z.infer<typeof WorkIntentSchema>;
export type CoordinateIntent = z.infer<typeof CoordinateIntentSchema>;
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export type CoordinateRequest = z.infer<typeof CoordinateRequestSchema>;
export type FacadeArtifact = z.infer<typeof FacadeArtifactSchema>;
export type FacadeSideEffect = z.infer<typeof FacadeSideEffectSchema>;
export type FacadeResponse = z.infer<typeof FacadeResponseSchema>;
