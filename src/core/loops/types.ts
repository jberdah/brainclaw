import { z } from 'zod';

export const LOOP_ARTIFACT_BODY_MAX_BYTES = 4096;

export const LOOP_KINDS = ['review', 'ideation', 'implementation', 'research', 'debug'] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];

export const LOOP_STATUSES = ['open', 'paused', 'completed', 'blocked', 'cancelled'] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export const REVIEW_MODES = ['asymmetric', 'symmetric'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/**
 * Slot lifecycle states. `done` / `failed` / `cancelled` are terminal and
 * mirror the `complete_turn` outcome so a caller reading the thread can
 * observe the per-slot outcome without replaying the event journal.
 */
export const SLOT_STATUSES = ['open', 'assigned', 'working', 'done', 'failed', 'cancelled'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export const TERMINAL_SLOT_STATUSES: readonly SlotStatus[] = ['done', 'failed', 'cancelled'] as const;

export const LOOP_REF_KINDS = ['plan', 'sequence', 'claim', 'handoff', 'candidate', 'message'] as const;

export const LoopRefSchema = z.object({
  kind: z.enum(LOOP_REF_KINDS),
  id: z.string().min(1),
});
export type LoopRef = z.infer<typeof LoopRefSchema>;

export const LoopLinksSchema = z.object({
  plan_ids: z.array(z.string().min(1)).optional(),
  sequence_ids: z.array(z.string().min(1)).optional(),
});
export type LoopLinks = z.infer<typeof LoopLinksSchema>;

export const LoopPhaseSchema = z.object({
  name: z.string().min(1),
  advance_when: z.enum(['all', 'any']).optional(),
});
export type LoopPhase = z.infer<typeof LoopPhaseSchema>;

export const LoopProtocolConfigSchema = z.object({
  review_mode: z.enum(REVIEW_MODES).optional(),
});
export type LoopProtocolConfig = z.infer<typeof LoopProtocolConfigSchema>;

export const LoopSlotSchema = z.object({
  slot_id: z.string().regex(/^lsl_[0-9a-z]+$/),
  role: z.string().min(1),
  agent: z.string().optional(),
  agent_id: z.string().optional(),
  assignment_id: z.string().optional(),
  claim_id: z.string().optional(),
  phase: z.string().optional(),
  status: z.enum(SLOT_STATUSES),
});
export type LoopSlot = z.infer<typeof LoopSlotSchema>;

export const LoopArtifactSchema = z
  .object({
    artifact_id: z.string().min(1),
    phase: z.string().min(1),
    type: z.string().min(1),
    ref: LoopRefSchema.optional(),
    body: z.string().optional(),
    produced_by: z.string().optional(),
    produced_at: z.string().datetime(),
  })
  .refine(
    (artifact) => {
      if (artifact.body === undefined) return true;
      return Buffer.byteLength(artifact.body, 'utf8') <= LOOP_ARTIFACT_BODY_MAX_BYTES;
    },
    {
      message: `LoopArtifact.body must be ≤ ${LOOP_ARTIFACT_BODY_MAX_BYTES} bytes; use a ref for larger content`,
      path: ['body'],
    },
  );
export type LoopArtifact = z.infer<typeof LoopArtifactSchema>;

export const AtomicStopConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phase_reached'), phase: z.string().min(1) }),
  z.object({ kind: z.literal('reviewer_green') }),
  z.object({ kind: z.literal('max_iterations'), n: z.number().int().positive() }),
  z.object({
    kind: z.literal('artifact_produced'),
    phase: z.string().min(1),
    type: z.string().min(1),
  }),
  z.object({ kind: z.literal('manual') }),
]);
export type AtomicStopCondition = z.infer<typeof AtomicStopConditionSchema>;

export type StopCondition =
  | AtomicStopCondition
  | { kind: 'any'; conditions: StopCondition[] }
  | { kind: 'all'; conditions: StopCondition[] };

export const StopConditionSchema: z.ZodType<StopCondition> = z.lazy(() =>
  z.union([
    AtomicStopConditionSchema,
    z.object({ kind: z.literal('any'), conditions: z.array(StopConditionSchema).min(1) }),
    z.object({ kind: z.literal('all'), conditions: z.array(StopConditionSchema).min(1) }),
  ]),
);

export const LoopThreadSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^lop_[0-9a-z]+$/),
    version: z.number().int().nonnegative(),
    mutation_id: z.string().min(1),

    kind: z.enum(LOOP_KINDS),
    title: z.string().min(1),
    goal: z.string().optional(),
    protocol: LoopProtocolConfigSchema.optional(),

    status: z.enum(LOOP_STATUSES),
    phases: z.array(LoopPhaseSchema).min(1),
    current_phase: z.string().min(1),
    iteration_count: z.number().int().nonnegative(),

    slots: z.array(LoopSlotSchema),
    artifacts: z.array(LoopArtifactSchema),
    linked: LoopLinksSchema.optional(),
    stop_condition: StopConditionSchema.optional(),

    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    closed_at: z.string().datetime().optional(),
    created_by: z.string().min(1),
  })
  .superRefine((thread, ctx) => {
    const names = thread.phases.map((p) => p.name);
    const uniqueNames = new Set(names);
    if (uniqueNames.size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LoopThread.phases names must be unique',
        path: ['phases'],
      });
    }
    if (!uniqueNames.has(thread.current_phase)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LoopThread.current_phase "${thread.current_phase}" is not in phases`,
        path: ['current_phase'],
      });
    }
  });
export type LoopThread = z.infer<typeof LoopThreadSchema>;

const LoopEventBaseShape = {
  event_id: z.string().min(1),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  seq: z.number().int().positive(),
  at: z.string().datetime(),
  by: z.string().optional(),
  mutation_id: z.string().min(1),
};

export const LoopEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('opened'),
    initial_phase: z.string().min(1),
    created_by: z.string().min(1),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('phase_advanced'),
    from_phase: z.string().min(1),
    to_phase: z.string().min(1),
    iteration: z.number().int().nonnegative(),
    reason: z.string().optional(),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('turn_assigned'),
    slot_id: z.string().min(1),
    phase: z.string().min(1),
    assignment_id: z.string().optional(),
    input: z.string().optional(),
    retry_of: z.string().optional(),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('turn_completed'),
    slot_id: z.string().min(1),
    phase: z.string().min(1),
    artifact_id: z.string().optional(),
    outcome: z.enum(['done', 'failed', 'cancelled']),
    failure_reason: z.string().optional(),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('artifact_added'),
    artifact_id: z.string().min(1),
    phase: z.string().min(1),
    type: z.string().min(1),
    produced_by: z.string().optional(),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('linked'),
    target: LoopRefSchema,
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('paused'),
    reason: z.string().optional(),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('resumed'),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('closed'),
    final_status: z.enum(['completed', 'cancelled', 'blocked']),
    reason: z.string().optional(),
  }),
]);
export type LoopEvent = z.infer<typeof LoopEventSchema>;

export const LoopConflictRecordSchema = z.object({
  conflict_id: z.string().min(1),
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  at: z.string().datetime(),
  attempted_by: z.string().min(1),
  expected_version: z.number().int().nonnegative(),
  actual_version: z.number().int().nonnegative(),
  rejected_intent: z.string().min(1),
  client_request_id: z.string().optional(),
});
export type LoopConflictRecord = z.infer<typeof LoopConflictRecordSchema>;

export const DEFAULT_PROTOCOLS: Record<LoopKind, { phases: LoopPhase[]; stop_condition: StopCondition }> = {
  review: {
    phases: [
      { name: 'change_summary' },
      { name: 'findings' },
      { name: 'author_response' },
      { name: 'followup_review' },
      { name: 'verdict' },
    ],
    stop_condition: {
      kind: 'any',
      conditions: [{ kind: 'reviewer_green' }, { kind: 'max_iterations', n: 3 }],
    },
  },
  ideation: {
    phases: [
      { name: 'proposal' },
      { name: 'critique' },
      { name: 'revision' },
      { name: 'synthesis' },
    ],
    stop_condition: { kind: 'artifact_produced', phase: 'synthesis', type: 'plan_draft' },
  },
  implementation: {
    phases: [
      { name: 'sequence_build' },
      { name: 'dispatch' },
      { name: 'execute' },
      { name: 'self_check' },
      { name: 'handoff_ready' },
    ],
    stop_condition: { kind: 'artifact_produced', phase: 'handoff_ready', type: 'handoff' },
  },
  research: {
    phases: [{ name: 'investigate' }, { name: 'synthesize' }],
    stop_condition: { kind: 'manual' },
  },
  debug: {
    phases: [{ name: 'reproduce' }, { name: 'hypothesize' }, { name: 'isolate' }, { name: 'fix' }],
    stop_condition: { kind: 'manual' },
  },
};
