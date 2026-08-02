/**
 * pln#638 PR-5 — the worker reply contract: what a loop worker must produce for
 * its work to COUNT, derived from the gate and frozen at dispatch.
 *
 * THE INCIDENT THIS EXISTS FOR (pln#638 proof #1): a codex critic typed its
 * artifact `coverage_gap` instead of `critique`. Schema-valid, invisible to the
 * phase gate `min_artifacts_by_type(critique, n:3)` — the loop stalled and the
 * champion re-registered the artifact by hand. The expected type was KNOWN at
 * dispatch; it simply never travelled. During the pln#638 ideation itself the
 * coordinator hand-wrote the type into each brief as a workaround, and the round
 * where it did so is the only round where every artifact landed correctly typed.
 * This module makes that manual fix structural.
 *
 * PLACEMENT — deliberately here, NOT in core/next-actions.ts. The design's first
 * draft said "render from the same builders as next_actions"; the adversarial
 * critique killed that: those builders describe the PILOT's after-outcome
 * (dispatch_status, loop get), while completing a turn is the WORKER's protocol.
 * Two audiences, two modules. The prose and the NextAction adapter below are
 * both derived from the same contract object, which is the actual single-source
 * requirement the draft was reaching for.
 *
 * FROZEN AT DISPATCH. The contract carries the phase and loop version at the
 * moment the brief is built. A lane that returns after the loop advanced keeps
 * its dispatch-phase attribution (pln#639 BUG-2), so the contract must name THAT
 * phase — not whatever the loop reaches later.
 *
 * @module
 */
import type { LoopThread, StopCondition } from './types.js';
import { LOOP_ARTIFACT_BODY_MAX_BYTES } from './types.js';

/** One artifact requirement extracted from a gate. */
export interface ArtifactRequirement {
  type: string;
  /** Minimum count when the gate states one (min_artifacts_by_type). */
  n?: number;
  scope?: 'phase' | 'loop';
}

export interface WorkerReplyContract {
  loop_id: string;
  /** The phase the worker is dispatched IN — frozen, never re-read at close. */
  phase: string;
  /** Artifact types the gate counts. Empty never happens (no contract instead). */
  requirements: ArtifactRequirement[];
  /**
   * How multiple requirements compose: every one needed ('all'), any one
   * suffices ('any'), or there is exactly one. The adversarial critique's
   * correction — "tous les types, aucun seul ne suffit" is WRONG for `any` —
   * so the composition is preserved rather than flattened.
   */
  composition: 'single' | 'all' | 'any';
  /**
   * Gate predicates that are NOT artifact-typed (reviewer_green,
   * no_open_questions, …), named so the prose can say honestly that producing
   * artifacts alone may not open the gate.
   */
  other_conditions: string[];
  /** Loop version at dispatch — a conflict on submit means the world moved. */
  loop_version: number;
  /** Inline body cap; larger content goes to a worktree file + dense summary. */
  body_max_bytes: number;
}

interface Extraction {
  requirements: ArtifactRequirement[];
  other: string[];
  composition: 'single' | 'all' | 'any';
}

/** Recursively extract artifact requirements from a gate, preserving all/any. */
function extractFromGate(gate: StopCondition): Extraction {
  switch (gate.kind) {
    case 'min_artifacts_by_type':
      return { requirements: [{ type: gate.type, n: gate.n, scope: gate.scope }], other: [], composition: 'single' };
    case 'artifact_produced':
      return { requirements: [{ type: gate.type }], other: [], composition: 'single' };
    case 'all':
    case 'any': {
      const parts = gate.conditions.map(extractFromGate);
      const requirements = parts.flatMap((p) => p.requirements);
      const other = parts.flatMap((p) => p.other);
      // Nested compositions collapse to the OUTER combinator for prose purposes;
      // the exact tree is the engine's business, the worker only needs to know
      // whether one deliverable suffices or all are needed.
      return {
        requirements,
        other,
        composition: requirements.length > 1 ? gate.kind : 'single',
      };
    }
    default:
      // reviewer_green, no_open_questions, iterations, manual, phase_reached —
      // conditions a worker cannot satisfy by typing an artifact correctly.
      return { requirements: [], other: [gate.kind], composition: 'single' };
  }
}

/**
 * Derive the contract for the loop's CURRENT phase, or undefined when the phase
 * has no artifact-typed gate — in which case no section is emitted and no
 * obligation is invented (silence over fabrication, as everywhere else).
 */
export function deriveWorkerReplyContract(thread: LoopThread): WorkerReplyContract | undefined {
  const phaseDef = thread.phases.find((p) => p.name === thread.current_phase);
  const gate = phaseDef?.advance_gate;
  if (!gate) return undefined;
  const { requirements, other, composition } = extractFromGate(gate);
  if (requirements.length === 0) return undefined;
  return {
    loop_id: thread.id,
    phase: thread.current_phase,
    requirements,
    composition,
    other_conditions: [...new Set(other)],
    loop_version: thread.version,
    body_max_bytes: LOOP_ARTIFACT_BODY_MAX_BYTES,
  };
}

/**
 * The {tool, args, when} a worker with MCP should call — derived from the SAME
 * contract the prose renders, so the two cannot disagree.
 */
export function workerReplyNextAction(contract: WorkerReplyContract): { tool: string; args: Record<string, unknown>; when: string } {
  const primary = contract.requirements[0];
  return {
    tool: 'bclaw_loop',
    args: {
      intent: 'add_artifact',
      loop_id: contract.loop_id,
      artifact: {
        phase: contract.phase,
        type: primary.type,
        body: '<your full output — non-empty, or it does not count toward the gate>',
      },
    },
    when: `your ${primary.type} is ready — the phase gate only counts artifacts of this exact type`,
  };
}

/** Render the brief section. Every value comes off the contract object. */
export function renderWorkerReplyProse(contract: WorkerReplyContract): string {
  const action = workerReplyNextAction(contract);
  const typeList = contract.requirements
    .map((r) => `\`${r.type}\`${r.n ? ` (n≥${r.n}, ${r.scope ?? 'phase'} scope)` : ''}`)
    .join(contract.composition === 'any' ? ' OR ' : ' AND ');

  const lines = [
    `## Deliverable contract — loop ${contract.loop_id}, phase "${contract.phase}"`,
    `The phase gate counts artifact type(s): ${typeList}. Any other type — however good the content — is INVISIBLE to the gate and stalls the loop.`,
    `- MCP path: call \`${action.tool}\` with ${JSON.stringify(action.args)}`,
    `- The body must be NON-EMPTY: an artifact without usable content does not count toward the gate.`,
    `- Body cap: ${contract.body_max_bytes} bytes. If your output is larger, write the full version to a markdown file in your worktree and put a dense summary plus the file path in the body.`,
    `- File fallback (no MCP): in LANE-RESULT.json set "artifact_type":"${contract.requirements[0].type}" and put your full output in "body" — the harvester records it under this contract.`,
    `- This contract is FROZEN for loop version ${contract.loop_version}, phase "${contract.phase}". If your submit reports a version conflict or the loop has advanced, your work is still recorded under phase "${contract.phase}" — do not re-target a newer phase.`,
  ];
  if (contract.other_conditions.length > 0) {
    lines.push(`- Note: the gate also requires ${contract.other_conditions.join(', ')} — producing artifacts alone may not advance the phase; that part is the coordinator's to satisfy.`);
  }
  lines.push('');
  return lines.join('\n');
}
