import { z } from 'zod';

import {
  LOOP_KINDS,
  LOOP_STATUSES,
  LoopLinksSchema,
  LoopPhaseSchema,
  LoopRefSchema,
  LoopSlotSchema,
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
  client_request_id: z.string().min(1).optional(),
};

export const BclawLoopOpenSchema = z.object({
  intent: z.literal('open'),
  kind: z.enum(LOOP_KINDS),
  title: z.string().min(1),
  goal: z.string().optional(),
  phases: z.array(LoopPhaseSchema).optional(),
  slots: z
    .array(
      LoopSlotSchema.partial().extend({
        role: z.string().min(1),
      }),
    )
    .optional(),
  linked: LoopLinksSchema.optional(),
  stop_condition: StopConditionSchema.optional(),
  mode: z.enum(REVIEW_MODES).optional(),
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
    produced_by: z.string().optional(),
    ref: LoopRefSchema.optional(),
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
] as const;
