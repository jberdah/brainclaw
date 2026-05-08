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
});

export type WorkIntent = z.infer<typeof WorkIntentSchema>;
export type CoordinateIntent = z.infer<typeof CoordinateIntentSchema>;
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export type CoordinateRequest = z.infer<typeof CoordinateRequestSchema>;
export type FacadeArtifact = z.infer<typeof FacadeArtifactSchema>;
export type FacadeSideEffect = z.infer<typeof FacadeSideEffectSchema>;
export type FacadeResponse = z.infer<typeof FacadeResponseSchema>;
