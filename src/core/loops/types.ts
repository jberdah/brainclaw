import { z } from 'zod';

export const LOOP_ARTIFACT_BODY_MAX_BYTES = 4096;
/** Ideation proposals are caller-authored task contracts, not worker summaries. */
export const LOOP_PROPOSAL_BODY_MAX_BYTES = 32 * 1024;

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
 *
 * pln#508 step 1 — `waiting_input` added to support the bootstrap loop's
 * operator-question primitive. A slot in `waiting_input` is non-terminal:
 * the engine resumes it back to `working` once its open_question is
 * answered (see request_input/provide_input intents, pln#508 step 2).
 */
export const SLOT_STATUSES = ['open', 'assigned', 'working', 'waiting_input', 'done', 'failed', 'cancelled'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export const TERMINAL_SLOT_STATUSES: readonly SlotStatus[] = ['done', 'failed', 'cancelled'] as const;

export const LOOP_REF_KINDS = ['plan', 'sequence', 'claim', 'handoff', 'candidate', 'message', 'commit', 'branch'] as const;

export const LoopRefSchema = z.object({
  kind: z.enum(LOOP_REF_KINDS),
  id: z.string().min(1),
});
export type LoopRef = z.infer<typeof LoopRefSchema>;

export const LoopLinksSchema = z.object({
  plan_ids: z.array(z.string().min(1)).optional(),
  sequence_ids: z.array(z.string().min(1)).optional(),
  /** Upstream loop in an ideation → implementation → review pipeline. */
  source_loop_id: z.string().regex(/^lop_[0-9a-z]+$/).optional(),
  /** Exact upstream artifact that authorized this continuation. */
  source_artifact_id: z.string().regex(/^art_[0-9a-z]+$/).optional(),
  /** Sealed digest of source_artifact_id at continuation evaluation time. */
  source_artifact_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Durable, deterministic identity of the policy decision that created this loop. */
  continuation_key: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  exit_when: z.enum(['critic_signal', 'no_new_critique_artifacts', 'command_green']),
});
export type LoopIteration = z.infer<typeof LoopIterationSchema>;

/** pln#632 — hard ceiling + default for an engine-run verify command's wall clock. */
export const VERIFY_TIMEOUT_HARD_CAP_MS = 15 * 60 * 1000;
export const VERIFY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * pln#632 — engine-run verify command config, set by the loop OPENER at open (never by
 * the agent under test — that is the determinism guarantee). The command is an argv
 * ARRAY run with `shell:false` (no injection surface); an operator who needs a pipeline
 * passes it explicitly as `['bash','-lc','npm test && npm run lint']` and owns that.
 * When present, `bclaw_loop(intent='verify')` runs it and records a deterministic
 * `verify_report`; absent, the loop falls back to the agent-narrated report unchanged.
 */
export const LoopVerifyConfigSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  timeout_ms: z.number().int().positive().max(VERIFY_TIMEOUT_HARD_CAP_MS).optional(),
});
export type LoopVerifyConfig = z.infer<typeof LoopVerifyConfigSchema>;

export const LoopProtocolConfigSchema = z.object({
  review_mode: z.enum(REVIEW_MODES).optional(),
  /** Whether ideation participants take ordered turns or fan out together. */
  ideation_schedule: z.enum(['sequential', 'parallel']).optional(),
  iteration: LoopIterationSchema.optional(),
  /** pln#632 — engine-run verify command (opener-provided; makes command_green real). */
  verify: LoopVerifyConfigSchema.optional(),
  /**
   * pln#508 step 1 — protocol preset selector. When set (e.g. `'bootstrap'`),
   * the coordinate facade routes preset-specific behaviors (close hook,
   * phase config, dispatch eligibility) keyed off this value. Loops without
   * a preset fall back to kind-default behavior.
   */
  preset: z.string().min(1).optional(),
  /**
   * pln#508 step 1 — cap on operator_question artifacts per loop. Enforced
   * at request_input intent time (pln#508 step 2). Bootstrap preset sets
   * this to 3 to prevent the "agent defers everything to the human" failure
   * mode documented in feedback_agent_autonomy_gap.md.
   */
  max_operator_questions: z.number().int().positive().optional(),
  /**
   * pln#508 step 1 — ISO-8601 duration string (e.g. 'P7D') capping how long
   * a loop may stay in status='paused' before the timeout machinery fires.
   * Used by request_input artifacts with on_timeout policy. Bootstrap
   * preset defaults to 'P7D'.
   */
  max_pause_duration: z.string().min(1).optional(),
});
export type LoopProtocolConfig = z.infer<typeof LoopProtocolConfigSchema>;

export const LoopSlotSchema = z.object({
  slot_id: z.string().regex(/^lsl_[0-9a-z]+$/),
  role: z.string().min(1),
  agent: z.string().optional(),
  agent_id: z.string().optional(),
  /** Stable point of view/instruction for this participant across rounds. */
  perspective: z.string().min(1).max(1000).optional(),
  assignment_id: z.string().optional(),
  claim_id: z.string().optional(),
  phase: z.string().optional(),
  /** Implementation-loop lane bound from the linked sequence at bind time. */
  lane: z.string().optional(),
  /** File/path scope carried by the bound sequence lane. */
  scope_hint: z.string().optional(),
  /** Plans and steps executed by this lane (derived, never worker-authored). */
  plan_ids: z.array(z.string().min(1)).optional(),
  step_ids: z.array(z.string().min(1)).optional(),
  status: z.enum(SLOT_STATUSES),
  /**
   * pln#630 PR2b-a (§13 R1) — pointer to the immutable turn-attempt record for
   * the slot's CURRENT dispatch. Identity/evidence live on the attempt
   * (`.brainclaw/loops/reservations/<turn_id>.json`), never overwritten on the
   * reusable slot. Additive; wired onto the dispatch path in a later PR.
   */
  current_turn_id: z.string().optional(),
  /** Last successful contribution, used to rotate reusable slots each round. */
  last_completed_phase: z.string().optional(),
  last_completed_iteration: z.number().int().nonnegative().optional(),
});
export type LoopSlot = z.infer<typeof LoopSlotSchema>;

// ───────────────────────────────────────────────────────────────────────
// pln#508 step 1 — bootstrap loop foundation: operator-interaction schemas
// ───────────────────────────────────────────────────────────────────────
//
// These body schemas validate the JSON payload encoded in LoopArtifact.body
// for the artifact types introduced by the bootstrap loop preset and
// generally reusable for any human-in-the-loop primitive. Step 2's
// request_input / provide_input handlers parse and validate via
// `KNOWN_ARTIFACT_BODY_SCHEMAS[type]`.

/** Where the operator pause applies: just the asking slot, or the whole loop. */
export const PAUSE_SCOPES = ['slot', 'loop'] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];

/** What the engine should do when an operator_question times out (Phase 0 spec §6). */
export const ON_TIMEOUT_POLICIES = ['use_default', 'cancel_loop', 'continue_incomplete'] as const;
export type OnTimeoutPolicy = (typeof ON_TIMEOUT_POLICIES)[number];

/** How an operator_answer arrived (Phase 0 spec §2). */
export const RESOLVED_VIA = ['answer', 'choose', 'skip', 'timeout_default'] as const;
export type ResolvedVia = (typeof RESOLVED_VIA)[number];

/** Reasons a loop may be paused. Maintained alongside LoopThread.pause_reason. */
export const PAUSE_REASONS = ['awaiting_operator', 'awaiting_file_apply'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const OperatorQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tradeoff: z.string().optional(),
});
export type OperatorQuestionOption = z.infer<typeof OperatorQuestionOptionSchema>;

/**
 * Operator question artifact body. The Champion records the question the
 * operator must answer, with `evidence` (anti-autonomy-gap: the slot must
 * show it tried), an optional `suggested_default` (used by skip / timeout
 * resolution), and an optional `options` set (2..4) that enables structured
 * `--choose` replies via the CLI.
 */
export const OperatorQuestionBodySchema = z
  .object({
    question_id: z.string().regex(/^qst_[0-9a-z]+$/),
    question_text: z.string().min(1).max(500),
    evidence: z.array(z.string().min(1)).min(1),
    suggested_default: z.string().optional(),
    options: z.array(OperatorQuestionOptionSchema).min(2).max(4).optional(),
    pause_scope: z.enum(PAUSE_SCOPES),
    on_timeout: z.enum(ON_TIMEOUT_POLICIES),
    timeout_at: z.string().datetime().optional(),
    /**
     * pln#508 step 2 — slot that asked the question. Set by the
     * `request_input` handler from its `slot_id` parameter so the
     * `provide_input` handler can find the right slot to resume when
     * `pause_scope='slot'`. Optional for forward compatibility with
     * questions created from non-slot contexts (e.g. timeout-synthesized
     * answers don't need it; pause_scope='loop' doesn't need it either).
     */
    by_slot_id: z.string().min(1).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.options && q.suggested_default !== undefined) {
      const optionIds = new Set(q.options.map((o) => o.id));
      if (!optionIds.has(q.suggested_default)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `OperatorQuestion.suggested_default "${q.suggested_default}" must match an options[].id when options is present`,
          path: ['suggested_default'],
        });
      }
    }
    if (q.on_timeout === 'use_default' && q.suggested_default === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OperatorQuestion.on_timeout=use_default requires suggested_default to be set',
        path: ['on_timeout'],
      });
    }
  });
export type OperatorQuestionBody = z.infer<typeof OperatorQuestionBodySchema>;

/**
 * Operator answer artifact body. `replies_to` correlates to a question_id
 * tracked in `LoopThread.open_questions`. `by` distinguishes human-provided
 * answers from system-synthesized ones (timeout default fallback); synthetic
 * answers MUST be flagged so audit can identify them.
 */
export const OperatorAnswerBodySchema = z
  .object({
    replies_to: z.string().regex(/^qst_[0-9a-z]+$/),
    resolved_via: z.enum(RESOLVED_VIA),
    answer_text: z.string().optional(),
    chosen_option_id: z.string().optional(),
    by: z.enum(['operator', 'system']),
    synthetic: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    if (a.by === 'system' && a.resolved_via !== 'timeout_default') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OperatorAnswer.by="system" requires resolved_via="timeout_default" (synthetic answers can only be timeout-induced)',
        path: ['resolved_via'],
      });
    }
    if (a.resolved_via === 'timeout_default' && a.by !== 'system') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OperatorAnswer.resolved_via="timeout_default" requires by="system"',
        path: ['by'],
      });
    }
    if (a.by === 'system' && a.synthetic !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OperatorAnswer.by="system" must have synthetic=true for audit clarity',
        path: ['synthetic'],
      });
    }
    const hasText = a.answer_text !== undefined;
    const hasChosen = a.chosen_option_id !== undefined;
    if (hasText && hasChosen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OperatorAnswer must have exactly one of {answer_text, chosen_option_id}, not both',
        path: ['answer_text'],
      });
    }
    if (!hasText && !hasChosen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OperatorAnswer must have exactly one of {answer_text, chosen_option_id}',
        path: ['answer_text'],
      });
    }
  });
export type OperatorAnswerBody = z.infer<typeof OperatorAnswerBodySchema>;

/**
 * Ref-based artifact body — used by project_md_draft, project_md_final,
 * signals_report, file_diff. The artifact's actual content lives at
 * `.brainclaw/coordination/loops/<loop_id>/artifacts/<ref>`. The body
 * JSON itself carries only metadata: path, size, content hash. This sidesteps
 * the 4 KiB LOOP_ARTIFACT_BODY_MAX_BYTES limit empirically hit during the
 * pln#508 design session (PROJECT.md + AGENTS.md = 6,714 bytes; unified
 * diffs are bigger).
 */
export const RefBasedArtifactBodySchema = z.object({
  ref: z.string().min(1),
  byte_count: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RefBasedArtifactBody = z.infer<typeof RefBasedArtifactBodySchema>;

/**
 * Set of artifact `type` strings whose `body` MUST be a JSON-encoded
 * RefBasedArtifactBody. Validation lives in LoopArtifactSchema's
 * superRefine below — older artifact types (proposal, critique, plan_draft,
 * etc.) keep freeform-string body semantics for backward compatibility.
 */
export const REF_BASED_ARTIFACT_TYPES = new Set<string>([
  'project_md_draft',
  'project_md_final',
  'signals_report',
  'file_diff',
]);

export const EVIDENCE_ATTESTATION_KINDS = ['claim', 'observation', 'verification', 'approval'] as const;
export type EvidenceAttestationKind = (typeof EVIDENCE_ATTESTATION_KINDS)[number];

export const EVIDENCE_PRODUCER_KINDS = ['engine', 'slot', 'coordinator', 'operator'] as const;
export type EvidenceProducerKind = (typeof EVIDENCE_PRODUCER_KINDS)[number];

export const EVIDENCE_CHANNELS = [
  'complete_turn',
  'reconcile_turn',
  'verify_command',
  'add_artifact',
  'operator_input',
  'system_hook',
] as const;
export type EvidenceChannel = (typeof EVIDENCE_CHANNELS)[number];

export const EvidenceSubjectSchema = z.object({
  loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  artifact_id: z.string().min(1),
  phase: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  slot_id: z.string().optional(),
  turn_id: z.string().optional(),
  assignment_id: z.string().optional(),
  claim_id: z.string().optional(),
  run_id: z.string().optional(),
  nonce_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  attempt_epoch: z.number().int().nonnegative().optional(),
  execution_contract_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  command_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  workspace_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type EvidenceSubject = z.infer<typeof EvidenceSubjectSchema>;

export const EvidenceProducerSchema = z.object({
  kind: z.enum(EVIDENCE_PRODUCER_KINDS),
  id: z.string().min(1),
  agent_id: z.string().optional(),
  channel: z.enum(EVIDENCE_CHANNELS),
});
export type EvidenceProducer = z.infer<typeof EvidenceProducerSchema>;

export const EvidenceAttestationSchema = z.object({
  kind: z.enum(EVIDENCE_ATTESTATION_KINDS),
  issuer: z.string().min(1),
  issued_at: z.string().datetime(),
  subject_digest: z.string().regex(/^[0-9a-f]{64}$/),
  rights: z.array(z.string().min(1)).min(1),
});
export type EvidenceAttestation = z.infer<typeof EvidenceAttestationSchema>;

/**
 * EvidenceEnvelope v1 is sealed by the loop engine at the artifact commit
 * boundary. The seal is an integrity checksum, not a remote identity
 * signature: ingress schemas never accept this object from a caller.
 */
export const EvidenceEnvelopeSchema = z.object({
  version: z.literal(1),
  evidence_id: z.string().regex(/^evd_[0-9a-z]+$/),
  evidence_type: z.literal('artifact_commit'),
  policy_version: z.literal('gate-policy-v1'),
  subject: EvidenceSubjectSchema,
  producer: EvidenceProducerSchema,
  artifact_digest: z.string().regex(/^[0-9a-f]{64}$/),
  issued_at: z.string().datetime(),
  observed_at: z.string().datetime(),
  validity: z.object({
    not_before: z.string().datetime(),
    not_after: z.string().datetime().optional(),
  }),
  attestations: z.array(EvidenceAttestationSchema).min(1),
  seal: z.object({
    algorithm: z.literal('sha256'),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

export const EvidencePolicyBindingSchema = z.object({
  version: z.literal('gate-policy-v1'),
  mode: z.enum(['shadow', 'strict']),
});
export type EvidencePolicyBinding = z.infer<typeof EvidencePolicyBindingSchema>;

/**
 * Lookup table mapping known artifact types to their body Zod schemas.
 * Step 2 handlers (request_input/provide_input) parse `artifact.body` as
 * JSON and call `safeParse` on `KNOWN_ARTIFACT_BODY_SCHEMAS[type]`.
 *
 * Body shapes fall into two categories:
 * - RefBasedArtifactBodySchema: `body` is JSON metadata for a file written
 *   under `.brainclaw/loops/threads/<loop_id>/artifacts/<ref>`.
 * - Inline body schemas: `body` is the complete small JSON payload.
 *
 * Schema definitions live above in this file. Keep this table explicit so
 * attach-call errors can name the expected shape for each known type.
 *
 * Types not listed keep the legacy freeform-body behavior — no body schema
 * is enforced. This preserves backward compatibility with proposal / critique
 * / revision / plan_draft / change_summary artifacts produced before pln#508.
 */
/**
 * pln#609 — implementation loop `verify_report` artifact body. Records the
 * outcome of a verify command (tests/build/lint) for one execute↔verify
 * iteration. `passed` is the single field the `command_green` iteration exit
 * reads. Kept small (tails only) to fit LOOP_ARTIFACT_BODY_MAX_BYTES. In
 * Increment 1 the report is produced by the verify turn (add_artifact); the
 * engine-run execution seam (spawnSync, out of the loop lock) is Increment 2.
 */
export const VerifyReportBodySchema = z.object({
  command: z.string().min(1),
  command_argv: z.array(z.string()).min(1).optional(),
  exit_code: z.number().int().nullable(),
  passed: z.boolean(),
  duration_ms: z.number().int().nonnegative().optional(),
  cwd: z.string().optional(),
  timed_out: z.boolean().optional(),
  stdout_tail: z.string().max(1024).optional(),
  stderr_tail: z.string().max(1024).optional(),
  command_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  workspace_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  workspace_stable: z.boolean().optional(),
  /** Implementation lane whose worktree was verified. */
  lane: z.string().optional(),
});
export type VerifyReportBody = z.infer<typeof VerifyReportBodySchema>;

export const KNOWN_ARTIFACT_BODY_SCHEMAS = {
  // inline JSON body: body = JSON.stringify({ ...fields per OperatorQuestionBodySchema })
  operator_question: OperatorQuestionBodySchema,
  // inline JSON body: body = JSON.stringify({ ...fields per VerifyReportBodySchema })
  verify_report: VerifyReportBodySchema,

  // inline JSON body: body = JSON.stringify({ ...fields per OperatorAnswerBodySchema })
  operator_answer: OperatorAnswerBodySchema,

  // ref-based: body = JSON.stringify({ ref, byte_count, sha256 })
  // Ref file lives at .brainclaw/loops/threads/<loop_id>/artifacts/<ref>
  project_md_draft: RefBasedArtifactBodySchema,

  // ref-based: body = JSON.stringify({ ref, byte_count, sha256 })
  // Ref file lives at .brainclaw/loops/threads/<loop_id>/artifacts/<ref>
  project_md_final: RefBasedArtifactBodySchema,

  // ref-based: body = JSON.stringify({ ref, byte_count, sha256 })
  // Ref file lives at .brainclaw/loops/threads/<loop_id>/artifacts/<ref>
  signals_report: RefBasedArtifactBodySchema,

  // ref-based: body = JSON.stringify({ ref, byte_count, sha256 })
  // Ref file lives at .brainclaw/loops/threads/<loop_id>/artifacts/<ref>
  file_diff: RefBasedArtifactBodySchema,
} as const;
export type KnownArtifactType = keyof typeof KNOWN_ARTIFACT_BODY_SCHEMAS;

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
    /** Executable acceptance command carried from synthesis into implementation. */
    implementation_verify: LoopVerifyConfigSchema.optional(),
    /**
     * pln#492 phase 2.b — iteration window the artifact was produced in.
     * 0-indexed (proposal/early phases produce iteration=0). Optional for
     * backward compatibility with non-iterating loops (review): when
     * absent, gate evaluators fall back to "all artifacts in this phase".
     * The iteration engine populates this from `thread.iteration_count`
     * at artifact creation time so callers don't have to track it.
     */
    iteration: z.number().int().nonnegative().optional(),
    /**
     * Explicit migration provenance. Optional on read so artifacts persisted
     * before P2 remain valid; use artifactEvidenceProvenance() to infer their
     * effective value without rewriting historical records.
     */
    provenance: z.enum(['legacy', 'attested']).optional(),
    /** Server-sealed provenance and independent attestations (P2). */
    evidence: EvidenceEnvelopeSchema.optional(),
  })
  .superRefine((artifact, ctx) => {
    const bodyLimit = artifact.type === 'proposal'
      ? LOOP_PROPOSAL_BODY_MAX_BYTES
      : LOOP_ARTIFACT_BODY_MAX_BYTES;
    if (artifact.body !== undefined && Buffer.byteLength(artifact.body, 'utf8') > bodyLimit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LoopArtifact.body must be ≤ ${bodyLimit} bytes; use a ref for larger content`,
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
    // pln#508 step 1 — validate the body of known-typed artifacts against
    // their schema. For ref-based types (project_md_*, signals_report,
    // file_diff) this enforces metadata-only bodies (ref + sha256 + byte_count)
    // and rejects raw markdown/diff content inline. For operator_question /
    // operator_answer it validates the structured fields used by the
    // request_input/provide_input intents (step 2). Older artifact types
    // (proposal, critique, revision, change_summary, plan_draft, ...) are
    // not in KNOWN_ARTIFACT_BODY_SCHEMAS and keep freeform body semantics.
    if (artifact.body !== undefined && artifact.type in KNOWN_ARTIFACT_BODY_SCHEMAS) {
      const schema = KNOWN_ARTIFACT_BODY_SCHEMAS[artifact.type as KnownArtifactType];
      let parsed: unknown;
      try {
        parsed = JSON.parse(artifact.body);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `LoopArtifact type="${artifact.type}" requires body to be a JSON-encoded payload; got non-JSON content`,
          path: ['body'],
        });
        return;
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `LoopArtifact type="${artifact.type}" body failed schema validation: ` +
            result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          path: ['body'],
        });
      }
    }
  });
export type LoopArtifact = z.infer<typeof LoopArtifactSchema>;

export const AtomicStopConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phase_reached'), phase: z.string().min(1) }),
  z.object({ kind: z.literal('reviewer_green') }),
  z.object({ kind: z.literal('max_iterations'), n: z.number().int().positive() }),
  // pln#516 step 2 — minimum-iteration floor. Used by the bootstrap preset's
  // clarify gate (composed inside `all`) to refuse exiting the phase before
  // the champion has had at least one iteration tick to call requestInput.
  // Symmetric to `max_iterations`: matches when `iteration_count >= n`.
  z.object({ kind: z.literal('min_iterations'), n: z.number().int().positive() }),
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
  // pln#511 step 1 — bootstrap preset's clarify phase advances when the
  // operator has no pending questions. Composed with `max_iterations=1`
  // under an `any` gate so the loop never blocks the operator forever.
  z.object({ kind: z.literal('no_open_questions') }),
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
    /** Absent means a pre-policy/legacy thread. New loops bind this at open. */
    evidence_policy: EvidencePolicyBindingSchema.optional(),

    /**
     * pln#508 step 1 — set of unresolved operator_question artifact ids.
     * The engine maintains this on every request_input / provide_input
     * intent (step 2). Default `[]` for backward compatibility with loops
     * created before this schema field landed.
     */
    open_questions: z.array(z.string().regex(/^qst_[0-9a-z]+$/)).default([]),
    /**
     * pln#508 step 1 — why the loop is paused, when status='paused'. The
     * two valid reasons cover the bootstrap loop's operator-question and
     * file-overwrite-approval primitives. Old paused loops without this
     * field continue to load; only newly-paused loops are required to set it.
     */
    pause_reason: z.enum(PAUSE_REASONS).optional(),
    /**
     * pln#508 step 1 — set when `pause_reason='awaiting_file_apply'`.
     * Carries the source artifact (project_md_final), target file path,
     * and the diff artifact the operator is approving. The file is only
     * written once an operator_answer with resolved_via in
     * {answer, choose} lands AND the answer indicates approval.
     */
    pending_file_apply: z
      .object({
        artifact_id: z.string().min(1),
        target_path: z.string().min(1),
        diff_artifact_id: z.string().min(1),
      })
      .optional(),

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
    // pln#508 step 1 — pause_reason / pending_file_apply invariants.
    // We intentionally do NOT enforce "status=paused requires pause_reason"
    // because pre-existing paused loops on disk may lack it; that bidirectional
    // invariant is enforced by the request_input handler in step 2 at write
    // time, not by the load-time schema.
    if (thread.pause_reason !== undefined && thread.status !== 'paused') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LoopThread.pause_reason is set ("${thread.pause_reason}") but status is "${thread.status}" — pause_reason requires status="paused"`,
        path: ['pause_reason'],
      });
    }
    if (thread.pending_file_apply !== undefined && thread.pause_reason !== 'awaiting_file_apply') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `LoopThread.pending_file_apply is set but pause_reason is ` +
          `${thread.pause_reason === undefined ? 'undefined' : `"${thread.pause_reason}"`}` +
          ' — pending_file_apply requires pause_reason="awaiting_file_apply"',
        path: ['pending_file_apply'],
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

export const GateDecisionSchema = z.object({
  passed: z.boolean(),
  /** Strict and legacy dimensions remain observable during a shadow rollout. */
  strict_passed: z.boolean().optional(),
  legacy_passed: z.boolean().optional(),
  policy_version: z.enum(['legacy', 'gate-policy-v1']),
  mode: z.enum(['legacy', 'shadow', 'strict']),
  condition_digest: z.string().regex(/^[0-9a-f]{64}$/),
  accepted_evidence_ids: z.array(z.string()),
  rejected: z.array(z.object({ artifact_id: z.string(), reason: z.string() })),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

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
    gate_decision: GateDecisionSchema.optional(),
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
  // pln#630 PR2b-a (§13 R1/Q1) — journal breadcrumb that an immutable
  // turn-attempt record was reserved for this dispatch. The authoritative
  // record lives in `loops/reservations/<turn_id>.json`; this event lets a
  // thread reader see the attempt existed without scanning that dir.
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('turn_reserved'),
    slot_id: z.string().min(1),
    phase: z.string().min(1),
    turn_id: z.string().min(1),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('attempt_generation_changed'),
    slot_id: z.string().min(1),
    turn_id: z.string().min(1),
    assignment_id: z.string().min(1),
    claim_id: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    from_epoch: z.number().int().nonnegative(),
    to_epoch: z.number().int().positive(),
    from_run_id: z.string().min(1),
    to_run_id: z.string().min(1),
    close_digest: z.string().regex(/^[a-f0-9]{64}$/),
    cause: z.string().min(1),
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
    evidence_id: z.string().optional(),
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
    gate_decision: GateDecisionSchema.optional(),
  }),
  // pln#492 — system events emitted by the iteration / phase-advance gate.
  // Carried in the same event journal rather than as artifacts so consumers
  // do not have to filter is_system before processing artifact content.
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('phase_advance_blocked'),
    phase: z.string().min(1),
    gate_reason: z.string().min(1),
    gate_decision: GateDecisionSchema.optional(),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('max_iterations_reached'),
    phase: z.string().min(1),
    iteration: z.number().int().nonnegative(),
    max_iterations: z.number().int().positive(),
  }),
  // pln#508 step 2 — bootstrap loop operator-interaction events.
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('input_requested'),
    question_id: z.string().regex(/^qst_[0-9a-z]+$/),
    pause_scope: z.enum(PAUSE_SCOPES),
    by_slot_id: z.string().min(1),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('input_provided'),
    question_id: z.string().regex(/^qst_[0-9a-z]+$/),
    resolved_via: z.enum(RESOLVED_VIA),
    /**
     * Whose answer this is — `'operator'` for human-provided, `'system'`
     * for engine-synthesized (timeout default). Named `answered_by` to
     * avoid clashing with `LoopEventBaseShape.by` (event actor / source).
     */
    answered_by: z.enum(['operator', 'system']),
    synthetic: z.boolean(),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('slot_status_changed'),
    slot_id: z.string().min(1),
    from_status: z.enum(SLOT_STATUSES),
    to_status: z.enum(SLOT_STATUSES),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('pause_timeout'),
    question_id: z.string().regex(/^qst_[0-9a-z]+$/),
    action_taken: z.enum(ON_TIMEOUT_POLICIES),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('file_apply_requested'),
    artifact_id: z.string().min(1),
    target_path: z.string().min(1),
  }),
  z.object({
    ...LoopEventBaseShape,
    kind: z.literal('file_apply_resolved'),
    artifact_id: z.string().min(1),
    approved: z.boolean(),
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
  // pln#609 — implementation loop v2. The loop ADDS to the dispatch pipeline
  // what it lacked: a deterministic command_green gate + a bounded fix↔verify
  // cycle + per-phase context sculpting. `bind` is an engine-only link
  // validation/advance; worker launch belongs to turn(dispatch=true).
  // execute↔verify iterates until
  // the verify command is green (a passing verify_report this iteration) or
  // the cycle cap is hit (→ handoff_ready with the red report → blocked).
  implementation: {
    phases: [
      { name: 'bind', context_filter: ['plans', 'decisions', 'constraints', 'project_vision'] },
      { name: 'execute', context_filter: ['decisions', 'constraints', 'traps', 'runtime_notes'] },
      {
        name: 'verify',
        context_filter: ['traps', 'runtime_notes'],
        // Cannot leave verify without having produced a verify_report THIS
        // iteration — guards "narrated verify, didn't run it". Reuses the
        // iteration-aware min_artifacts_by_type evaluator.
        advance_gate: { kind: 'min_artifacts_by_type', type: 'verify_report', n: 1, scope: 'phase' },
      },
      { name: 'handoff_ready', context_filter: ['handoffs', 'plans'] },
    ],
    // execute ↔ verify bounded cycle; exit early when a passing verify_report
    // exists in the current iteration (command_green).
    iteration: {
      cycle: ['execute', 'verify'],
      max_iterations: 3,
      exit_when: 'command_green',
    },
    // Mirrors review: handoff within budget → completed; cap exhausted without
    // green → blocked (stopHitsMaxIterations).
    stop_condition: {
      kind: 'any',
      conditions: [
        { kind: 'artifact_produced', phase: 'handoff_ready', type: 'handoff' },
        { kind: 'max_iterations', n: 3 },
      ],
    },
  },
  // pln#628 PART 3 — research loop, ideation-shaped: investigate ↔ synthesize
  // converges on a deliverable. NO max_iterations in the stop → research ALWAYS
  // lands in `conclude` and completes with a synthesis (there is no "blocked"
  // research outcome). exit_when=critic_signal: `synthesize` emits it when the
  // question is judged answered (explicit sufficiency beats saturation-by-absence
  // for open-ended research). Reuses existing machinery only.
  research: {
    phases: [
      {
        name: 'investigate',
        context_filter: ['plans', 'decisions', 'constraints', 'project_vision', 'candidates', 'runtime_notes', 'traps'],
        // Don't synthesize an empty round: ≥1 finding gathered THIS iteration
        // (iteration-aware phase scope) before advancing.
        advance_gate: { kind: 'min_artifacts_by_type', type: 'finding', n: 1, scope: 'phase' },
      },
      { name: 'synthesize', context_filter: ['*'] },
      { name: 'conclude', context_filter: ['*'] },
    ],
    iteration: { cycle: ['investigate', 'synthesize'], max_iterations: 3, exit_when: 'critic_signal' },
    stop_condition: { kind: 'artifact_produced', phase: 'conclude', type: 'synthesis' },
  },
  // pln#628 PART 3 — debug loop, implementation-shaped: "bug fixed" ⟺ "the
  // reproducing command is now green" ⟺ a passing verify_report. hypothesize →
  // isolate → fix repeats until the repro no longer reproduces (command_green)
  // or the cycle cap is hit (→ handoff with the red report → blocked). Reuses
  // command_green + verify_report; no new engine machinery.
  debug: {
    phases: [
      {
        name: 'reproduce',
        context_filter: ['traps', 'runtime_notes', 'handoffs', 'plans'],
        // Cannot start hypothesizing until a reliable repro exists.
        advance_gate: { kind: 'artifact_produced', phase: 'reproduce', type: 'repro' },
      },
      { name: 'hypothesize', context_filter: ['decisions', 'constraints', 'traps', 'runtime_notes'] },
      { name: 'isolate', context_filter: ['decisions', 'constraints', 'traps', 'runtime_notes'] },
      {
        name: 'fix',
        context_filter: ['traps', 'runtime_notes', 'constraints'],
        // Mirrors implementation's verify gate: cannot leave fix without having
        // re-run the repro THIS iteration (iteration-aware phase scope).
        advance_gate: { kind: 'min_artifacts_by_type', type: 'verify_report', n: 1, scope: 'phase' },
      },
      { name: 'handoff', context_filter: ['handoffs', 'plans'] },
    ],
    iteration: { cycle: ['hypothesize', 'isolate', 'fix'], max_iterations: 3, exit_when: 'command_green' },
    stop_condition: {
      kind: 'any',
      conditions: [
        { kind: 'artifact_produced', phase: 'handoff', type: 'handoff' },
        { kind: 'max_iterations', n: 3 },
      ],
    },
  },
};
