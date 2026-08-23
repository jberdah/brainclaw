import { z } from 'zod';

import {
  LOOP_KINDS,
  LOOP_STATUSES,
  LoopLinksSchema,
  LoopPhaseSchema,
  LoopRefSchema,
  LoopSlotSchema,
  ON_TIMEOUT_POLICIES,
  OperatorQuestionOptionSchema,
  PAUSE_SCOPES,
  RESOLVED_VIA,
  REVIEW_MODES,
  StopConditionSchema,
} from './types.js';

/**
 * `bclaw_loop(intent)` request schemas — one per intent, unioned into a
 * discriminated schema. Mirrors the BclawLoopInput type from the v8 RFC.
 */

const CallerEnvelopeFields = {
  agent: z.string().optional(),
  agentId: z.string().optional(),
  project: z.string().optional(),
  client_request_id: z.string().min(1).optional(),
};

/**
 * Slot input shape for `bclaw_loop(intent='open')`. Loosens the persisted
 * `LoopSlotSchema` (which requires server-assigned fields like `slot_id`
 * and `status`) so callers only need to supply `role` plus any optional
 * hints. Exported so it can be consumed both by `BclawLoopOpenSchema`
 * below AND by the build-time MCP schema generator (pln#494 phase 2).
 */
export const LoopSlotInputSchema = LoopSlotSchema.partial().extend({
  role: z.string().min(1),
});

export const BclawLoopOpenSchema = z.object({
  intent: z.literal('open'),
  kind: z.enum(LOOP_KINDS),
  title: z.string().min(1),
  goal: z.string().optional(),
  phases: z.array(LoopPhaseSchema).optional(),
  slots: z.array(LoopSlotInputSchema).optional(),
  linked: LoopLinksSchema.optional(),
  stop_condition: StopConditionSchema.optional(),
  mode: z.enum(REVIEW_MODES).optional(),
  /** pln#632 — engine-run verify command (opener-provided). Argv array, run shell:false;
   *  set once at open, drives the deterministic command_green gate via bclaw_loop(verify). */
  verify: z
    .object({
      command: z.array(z.string().min(1)).min(1),
      timeout_ms: z.number().int().positive().optional(),
    })
    .optional(),
  // Opt-in acknowledgement that the caller will drive dispatch manually.
  // Absent (or false) → handler rejects with a pointer to bclaw_coordinate,
  // because a loop opened without a follow-up turn/claim/inbox never runs.
  // See pln#461.
  allow_orphan: z.boolean().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopGetSchema = z.object({
  intent: z.literal('get'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  include_events: z.boolean().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopListSchema = z.object({
  intent: z.literal('list'),
  kind: z.enum(LOOP_KINDS).optional(),
  status: z.enum(LOOP_STATUSES).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopTurnSchema = z.object({
  intent: z.literal('turn'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  slot_id: z.string().optional(),
  role: z.string().optional(),
  input: z.string().optional(),
  assignment_id: z.string().optional(),
  /** pln#562 step 4 — claim binding the turn's slot to a dispatched instance. */
  claim_id: z.string().optional(),
  dispatch: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopCompleteTurnSchema = z.object({
  intent: z.literal('complete_turn'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  slot_id: z.string().min(1),
  outcome: z.enum(['done', 'failed', 'cancelled']).optional(),
  failure_reason: z.string().optional(),
  artifact: z
    .object({
      phase: z.string().min(1),
      type: z.string().min(1),
      body: z.string().optional(),
      ref: LoopRefSchema.optional(),
      /** pln#492 synthesis audit trail. Required when type === 'plan_draft'. */
      addresses_critique: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopAdvanceSchema = z.object({
  intent: z.literal('advance'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  to_phase: z.string().optional(),
  reason: z.string().optional(),
  force: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopAddArtifactSchema = z.object({
  intent: z.literal('add_artifact'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  artifact: z.object({
    phase: z.string().min(1),
    type: z.string().min(1),
    body: z.string().optional(),
    ref: LoopRefSchema.optional(),
    /** pln#492 synthesis audit trail. Required when type === 'plan_draft'. */
    addresses_critique: z.array(z.string().min(1)).optional(),
  }),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopPauseSchema = z.object({
  intent: z.literal('pause'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  reason: z.string().optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopResumeSchema = z.object({
  intent: z.literal('resume'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopCloseSchema = z.object({
  intent: z.literal('close'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  status: z.enum(['completed', 'cancelled', 'blocked']),
  reason: z.string().optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

/**
 * pln#632 — `bclaw_loop(intent='verify')`: run the loop's opener-configured verify
 * command (tests/build/lint) and record a deterministic `verify_report` for the current
 * iteration. Does NOT advance. No command in the request — provenance is the loop's
 * `protocol.verify`, never the caller (the determinism guarantee).
 */
export const BclawLoopVerifySchema = z.object({
  intent: z.literal('verify'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  // No expected_version: runVerify is idempotent by (loop, iteration) via its own
  // two-lock re-check, not optimistic-concurrency CAS (review F3).
  ...CallerEnvelopeFields,
});

/**
 * pln#632 — `bclaw_loop(intent='bind')`: the ENGINE action for an implementation loop's
 * `bind` phase. Dispatches the loop's linked sequence (by id, no active-sequence hijack)
 * and advances `bind → execute`. Idempotent (a loop past `bind` → noop). `dry_run`
 * previews what would dispatch without spawning or advancing. Implementation loops only —
 * review/ideation loops dispatch via bclaw_coordinate.
 */
export const BclawLoopBindSchema = z.object({
  intent: z.literal('bind'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  /** Analyze + report what would dispatch; no spawn, no advance. */
  dry_run: z.boolean().optional(),
  /** Restrict the bind dispatch to specific lanes. */
  lanes: z.array(z.string().min(1)).optional(),
  /** Deliver briefs without spawning (→ manual launch commands). */
  auto_execute: z.boolean().optional(),
  /** Model override for the dispatched agents. */
  model: z.string().min(1).optional(),
  /** Cap assignments made in this bind. */
  max_assignments: z.number().int().positive().optional(),
  // No expected_version: bind is idempotent by loop phase (past `bind` → noop), not CAS.
  ...CallerEnvelopeFields,
});

/**
 * pln#508 step 2 — `bclaw_loop(intent='request_input')`.
 *
 * A slot pauses on an operator question. The handler generates a fresh
 * `question_id`, JSON-encodes the OperatorQuestionBody, attaches it as an
 * `operator_question` artifact, appends the id to `LoopThread.open_questions`,
 * and transitions either the slot (`pause_scope='slot'` → status=waiting_input)
 * or the whole loop (`pause_scope='loop'` → status=paused, pause_reason='awaiting_operator').
 *
 * Refused when the loop is not in status='open' (no compounding pauses) and
 * when `loop.protocol.max_operator_questions` is already reached (anti
 * autonomy-gap cap, e.g. the bootstrap preset sets max=3).
 */
export const BclawLoopRequestInputSchema = z.object({
  intent: z.literal('request_input'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  slot_id: z.string().min(1),
  phase: z.string().min(1),
  question_text: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1)).min(1),
  suggested_default: z.string().optional(),
  options: z.array(OperatorQuestionOptionSchema).min(2).max(4).optional(),
  pause_scope: z.enum(PAUSE_SCOPES),
  on_timeout: z.enum(ON_TIMEOUT_POLICIES),
  timeout_at: z.string().datetime().optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

/**
 * pln#508 step 2 — `bclaw_loop(intent='provide_input')`.
 *
 * Resolves an open operator_question. Idempotency: if `replies_to` is no
 * longer in `loop.open_questions` but an existing operator_answer artifact
 * references it, the existing answer is returned (no new artifact created).
 * Unknown `replies_to` → `unknown_question` error.
 *
 * Resume logic:
 * - If the source question had `pause_scope='slot'`, the asking slot
 *   (`by_slot_id`) transitions from `waiting_input` back to `working`.
 * - If `pause_scope='loop'` AND `open_questions` becomes empty AND the
 *   loop is paused on `awaiting_operator`, the loop resumes to status='open'.
 */
export const BclawLoopProvideInputSchema = z.object({
  intent: z.literal('provide_input'),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  replies_to: z.string().regex(/^qst_[0-9a-z]+$/),
  resolved_via: z.enum(RESOLVED_VIA),
  answer_text: z.string().optional(),
  chosen_option_id: z.string().optional(),
  /**
   * Defaults to 'operator'. The timeout machinery (pln#508 step 3) calls
   * the underlying verb with `by='system'` to create synthetic answers,
   * but external callers should leave this absent.
   */
  by: z.enum(['operator', 'system']).optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...CallerEnvelopeFields,
});

export const BclawLoopRequestSchema = z.discriminatedUnion('intent', [
  BclawLoopOpenSchema,
  BclawLoopGetSchema,
  BclawLoopListSchema,
  BclawLoopTurnSchema,
  BclawLoopCompleteTurnSchema,
  BclawLoopAdvanceSchema,
  BclawLoopAddArtifactSchema,
  BclawLoopPauseSchema,
  BclawLoopResumeSchema,
  BclawLoopCloseSchema,
  BclawLoopVerifySchema,
  BclawLoopBindSchema,
  BclawLoopRequestInputSchema,
  BclawLoopProvideInputSchema,
]);

export type BclawLoopRequest = z.infer<typeof BclawLoopRequestSchema>;
export type BclawLoopIntent = BclawLoopRequest['intent'];

export const BCLAW_LOOP_INTENTS = [
  'open',
  'get',
  'list',
  'turn',
  'complete_turn',
  'advance',
  'add_artifact',
  'pause',
  'resume',
  'close',
  'verify',
  'bind',
  'request_input',
  'provide_input',
] as const;
