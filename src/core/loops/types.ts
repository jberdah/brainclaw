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

/**
 * Memory categories a loop phase can request via `context_filter` (pln#492).
 *
 * The driver uses this list to assemble the context bundle handed to a slot
 * for a given phase. Brainclaw entity categories are user-facing memory the
 * slot may consult; loop-internal categories ('critique_history',
 * 'revision_history', 'synthesis_artifact') refer to artifacts produced
 * earlier in the same loop.
 *
 * The wildcard '*' means "all categories" — used by phases that need
 * unconstrained context (proposal seed, revision after critique, synthesis).
 *
 * 'feedback' is a logical grouping for user auto-memory feedback notes;
 * it is intentionally separate from 'runtime_notes' because the driver
 * may source them from different stores.
 */
export const LOOP_CONTEXT_CATEGORIES = [
  'traps',
  'feedback',
  'runtime_notes',
  'decisions',
  'constraints',
  'handoffs',
  'plans',
  'candidates',
  'project_vision',
  'critique_history',
  'revision_history',
  'synthesis_artifact',
  '*',
] as const;
export type LoopContextCategory = (typeof LOOP_CONTEXT_CATEGORIES)[number];

/**
 * Critique artifact subtypes for the ideation_loop critic phase (pln#492).
 *
 * Collapsed from 6 to 3 per the reframer findings on pln#492's own design
 * (runtime_note 'reframer_phase_simulation_transcript', 2026-05-03):
 * finer subtype taxonomy adds schema and test surface without buying any
 * behavioural differentiation in v1.0. Defer to v1.1 only if downstream
 * UX or routing turns out to need it.
 */
export const CRITIQUE_ARTIFACT_SUBTYPES = ['memory_conflict', 'coverage_gap', 'scope_creep'] as const;
export type CritiqueArtifactSubtype = (typeof CRITIQUE_ARTIFACT_SUBTYPES)[number];

export const LoopPhaseSchema = z.object({
  name: z.string().min(1),
  advance_when: z.enum(['all', 'any']).optional(),
  /**
   * Memory categories visible to the slot when this phase runs (pln#492).
   * If omitted, the driver applies its kind-default context bundle.
   * Use ['*'] to request the full bundle explicitly.
   */
  context_filter: z.array(z.enum(LOOP_CONTEXT_CATEGORIES)).min(1).optional(),
  /**
   * Optional condition that must hold for the driver to advance OUT of
   * this phase (pln#492). Re-uses the StopCondition shape so callers can
   * compose any/all/min_artifacts_by_type/etc. When the gate fails the
   * driver emits a `phase_advance_blocked` system event with a structured
   * gate_reason; it does NOT silently hang.
   *
   * z.lazy because StopConditionSchema is defined further down in this
   * file and references LoopPhase indirectly; the lazy wrapper avoids
   * the temporal-dead-zone.
   */
  advance_gate: z.lazy(() => StopConditionSchema).optional(),
});
export type LoopPhase = z.infer<typeof LoopPhaseSchema> & {
  advance_gate?: StopCondition;
};

/**
 * Iteration block for protocols with an inner cycle (e.g. ideation_loop's
 * critique↔revision). Defines which phases form the cycle, the cap, and
 * the exit criterion.
 *
 * - `cycle` lists phase names that repeat. The driver advances through
 *   them in order, then loops back until exit_when is satisfied or
 *   max_iterations is reached.
 * - `exit_when` selects the convergence criterion:
 *     'critic_signal' — critic explicitly produced a 'sufficient' marker.
 *     'no_new_critique_artifacts' — a full cycle completed without adding
 *       any new critique artifact. Stable convergence by saturation.
 */
export const LoopIterationSchema = z.object({
  cycle: z.array(z.string().min(1)).min(1),
  max_iterations: z.number().int().positive(),
  exit_when: z.enum(['critic_signal', 'no_new_critique_artifacts']),
});
export type LoopIteration = z.infer<typeof LoopIterationSchema>;

export const LoopProtocolConfigSchema = z.object({
  review_mode: z.enum(REVIEW_MODES).optional(),
  iteration: LoopIterationSchema.optional(),
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
    /**
     * pln#492 — synthesis schema. When the synthesis phase emits a
     * `plan_draft` artifact, it MUST cite the critique artifact_ids it
     * addresses (or explicitly waives) so a reviewer can audit which
     * critiques were folded in vs dropped. Field-presence enforced by
     * `superRefine` below; semantic validation (each id maps to a real
     * critique artifact) is deferred to v1.1 per the plan.
     */
    addresses_critique: z.array(z.string().min(1)).optional(),
  })
  .superRefine((artifact, ctx) => {
    if (artifact.body !== undefined && Buffer.byteLength(artifact.body, 'utf8') > LOOP_ARTIFACT_BODY_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LoopArtifact.body must be ≤ ${LOOP_ARTIFACT_BODY_MAX_BYTES} bytes; use a ref for larger content`,
        path: ['body'],
      });
    }
    if (artifact.type === 'plan_draft') {
      if (!artifact.addresses_critique || artifact.addresses_critique.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "LoopArtifact of type 'plan_draft' must include addresses_critique:[ids] " +
            '(at least one) so synthesis can be audited against the critiques it folded in',
          path: ['addresses_critique'],
        });
      }
    }
  });
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
  // pln#492 — saturate by artifact count. `scope: 'phase'` counts only
  // artifacts produced in the current phase; `scope: 'loop'` counts across
  // every phase in the loop (used by the ideation gate to require ≥3
  // critique artifacts in the current critique round before allowing the
  // critique→revision advance).
  z.object({
    kind: z.literal('min_artifacts_by_type'),
    type: z.string().min(1),
    n: z.number().int().positive(),
    scope: z.enum(['phase', 'loop']),
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
  // pln#492 — system events emitted by the iteration / phase-advance gate.
  // Carried in the same event journal rather than as artifacts so consumers
  // do not have to filter is_system before processing artifact content.
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('phase_advance_blocked'),
    phase: z.string().min(1),
    gate_reason: z.string().min(1),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('max_iterations_reached'),
    phase: z.string().min(1),
    iteration: z.number().int().nonnegative(),
    max_iterations: z.number().int().positive(),
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

/**
 * Default protocol per LoopKind. The loop driver reads this when a thread
 * is opened without an explicit protocol override.
 *
 * `iteration` is optional — only ideation_loop uses it in v1 (pln#492);
 * other kinds remain linear-with-stop-condition.
 */
export const DEFAULT_PROTOCOLS: Record<
  LoopKind,
  { phases: LoopPhase[]; stop_condition: StopCondition; iteration?: LoopIteration }
> = {
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
  // pln#492 — ideation_loop: memory-confrontation protocol with inner
  // critique↔revision cycle. `context_filter` per phase makes critic see
  // adversarial memory only (traps + feedback + runtime_notes), while
  // proposal sees positive context and revision/synthesis see everything.
  ideation: {
    phases: [
      {
        name: 'proposal',
        context_filter: ['decisions', 'constraints', 'plans', 'project_vision'],
      },
      {
        name: 'critique',
        context_filter: ['traps', 'feedback', 'runtime_notes', 'critique_history'],
        // pln#492 — gate: cannot advance critique→revision until ≥3 critique
        // artifacts have been produced in the current critique phase. Below
        // that floor, the loop hasn't accumulated enough adversarial pressure
        // to make revision useful. Phase 2.b iteration engine will refine
        // this to per-iteration scope; phase 2.a counts across the phase.
        advance_gate: {
          kind: 'min_artifacts_by_type',
          type: 'critique',
          n: 3,
          scope: 'phase',
        },
      },
      { name: 'revision', context_filter: ['*'] },
      { name: 'synthesis', context_filter: ['*'] },
    ],
    iteration: {
      cycle: ['critique', 'revision'],
      max_iterations: 3,
      exit_when: 'no_new_critique_artifacts',
    },
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
