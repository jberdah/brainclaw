import type { LoopPhase, LoopProtocolConfig, StopCondition } from '../types.js';

/**
 * pln#511 step 1 — typed shape for a loop preset.
 *
 * A preset bundles the phase chain, the loop-level stop condition, and the
 * protocol config the coordinate facade reads at open time. Future presets
 * (review, ideation, ...) can adopt this shape so callers have one consistent
 * mental model regardless of which preset they pick.
 */
export interface LoopPreset {
  phases: LoopPhase[];
  stop_condition: StopCondition;
  protocol: LoopProtocolConfig;
}

/**
 * pln#511 step 1 — bootstrap preset.
 *
 * Phase chain (Phase 0 spec):
 *   survey      → produce signals_report from existing project memory.
 *   propose     → first-draft PROJECT.md from survey + freeform context.
 *   clarify     → at most one round of operator questions; advance once
 *                  open_questions drains OR the cap fires.
 *   review_draft→ wait for the operator's verdict / answers.
 *   converge    → emit the final project_md_final and close.
 *
 * `max_operator_questions=3` and `max_pause_duration='P7D'` match the
 * Phase 0 spec defaults (mitigates feedback_agent_autonomy_gap.md — agents
 * must not defer everything to the human).
 */
export const BOOTSTRAP_PRESET: LoopPreset = {
  phases: [
    // pln#516 step 1 — survey reads source. The bootstrap champion SHOULD
    // call `readSurveySources(cwd)` (exported from ../hooks/survey-source-reader.js)
    // to populate the source_excerpts portion of its signals_report. The engine
    // does NOT invoke this automatically; the champion drives it (RefBasedArtifactBody
    // is unchanged — see types.ts). Empirical motivation: TranslaVox cold-start
    // missed the actual GCP Speech+Translate pipeline because survey scanned only
    // topology + manifests (can_0160d6c4).
    //
    // pln#557 step 4 — the deterministic scanner (runBootstrapProfile) now
    // seeds this phase: acquireBootstrapLoop attaches a `signals_baseline`
    // artifact (toolchain, topology, native rules, top seeds) at open time.
    // The champion enriches that baseline into its signals_report — survey
    // quality stops depending on per-agent re-discovery, and bclaw_bootstrap
    // becomes an internal helper of the loop rather than a competing door.
    {
      name: 'survey',
      context_filter: ['project_vision', 'decisions', 'plans', 'feedback'],
      advance_gate: { kind: 'artifact_produced', phase: 'survey', type: 'signals_report' },
    },
    {
      name: 'propose',
      context_filter: ['*'],
      advance_gate: { kind: 'artifact_produced', phase: 'propose', type: 'project_md_draft' },
    },
    {
      name: 'clarify',
      context_filter: ['critique_history', 'runtime_notes', 'feedback'],
      // pln#516 step 2 — wrap the original `any` exit condition under a
      // `min_iterations >= 1` floor so the gate refuses to auto-traverse at
      // entry. Without the floor `no_open_questions` is trivially true while
      // `open_questions` is still `[]` (it only fills once the champion calls
      // requestInput), and `advance(propose→clarify)` slid straight into
      // review_draft (can_d5a41770, run_4b0500c6).
      advance_gate: {
        kind: 'all',
        conditions: [
          { kind: 'min_iterations', n: 1 },
          {
            kind: 'any',
            conditions: [
              { kind: 'no_open_questions' },
              { kind: 'max_iterations', n: 1 },
            ],
          },
        ],
      },
    },
    {
      name: 'review_draft',
      context_filter: ['*'],
      advance_gate: { kind: 'artifact_produced', phase: 'review_draft', type: 'operator_answer' },
    },
    {
      name: 'converge',
      context_filter: ['*'],
    },
  ],
  stop_condition: { kind: 'artifact_produced', phase: 'converge', type: 'project_md_final' },
  protocol: {
    preset: 'bootstrap',
    max_operator_questions: 3,
    max_pause_duration: 'P7D',
  },
};
