/**
 * pln#492 phase 2.b — Finite state machine for ideation_loop iteration.
 *
 * The driver consults this module before mutating phase state on a loop
 * with an `iteration` block. The engine is pure: it inspects a thread +
 * its protocol shape and returns a structured decision. Applying the
 * decision (mutating thread, appending events, persisting) is the
 * advance() verb's job.
 *
 * Naming the engine an FSM in the file structure is a deliberate
 * implementation discipline (stp_af207293 in pln#492): states = phases,
 * transitions = exit_when conditions + cycle membership, guards = phase
 * advance_gate, actions = system event emissions.
 */

import type {
  LoopArtifact,
  LoopIteration,
  LoopPhase,
  LoopThread,
} from './types.js';

export interface IterationProtocol {
  phases: LoopPhase[];
  iteration?: LoopIteration;
}

/**
 * Decision returned by `decideNextPhase`. Each variant carries every field
 * the caller needs to apply the transition without re-deriving it from
 * the thread.
 *
 * - `advance_to`: linear forward step, iteration unchanged.
 * - `iterate_to`: cycle back to the first phase of the iteration.cycle,
 *   iteration += 1.
 * - `exit_cycle`: leave the cycle to the post-cycle phase because
 *   `exit_when` was satisfied.
 * - `max_iterations`: leave the cycle to the post-cycle phase because the
 *   iteration cap was reached without `exit_when` triggering. Carries
 *   the cap so the driver can emit a `max_iterations_reached` event with
 *   accurate fields.
 */
export type NextPhaseDecision =
  | { kind: 'advance_to'; target: string; iteration: number }
  | { kind: 'iterate_to'; target: string; iteration: number }
  | {
      kind: 'exit_cycle';
      target: string;
      iteration: number;
      reason: 'no_new_critique_artifacts' | 'critic_signal';
    }
  | {
      kind: 'max_iterations';
      target: string;
      iteration: number;
      max: number;
    };

/**
 * Decide the next phase given the current thread state and the protocol.
 *
 * Throws if `current_phase` is not in `protocol.phases`. Throws if there
 * is no successor (last phase + no iteration block). Callers that want
 * to handle "already at end" should check beforehand.
 */
export function decideNextPhase(
  thread: LoopThread,
  protocol: IterationProtocol,
): NextPhaseDecision {
  const phaseNames = protocol.phases.map((p) => p.name);
  const currentIndex = phaseNames.indexOf(thread.current_phase);
  if (currentIndex < 0) {
    throw new Error(
      `decideNextPhase: current_phase "${thread.current_phase}" not in protocol.phases`,
    );
  }

  const cycle = protocol.iteration?.cycle ?? [];
  const inCycle = cycle.includes(thread.current_phase);

  // Path 1 — current phase is not in the iteration cycle. Linear advance.
  if (!inCycle) {
    if (currentIndex + 1 >= phaseNames.length) {
      throw new Error(
        `advance: already at last phase "${thread.current_phase}"`,
      );
    }
    return {
      kind: 'advance_to',
      target: phaseNames[currentIndex + 1],
      iteration: thread.iteration_count,
    };
  }

  // Path 2 — current phase is inside the cycle. Two sub-cases:
  //   2a. Not at the end of the cycle yet → step within cycle.
  //   2b. At the end of the cycle → either iterate, exit by exit_when, or
  //       exit by max_iterations.
  const cycleIndex = cycle.indexOf(thread.current_phase);
  const atCycleEnd = cycleIndex === cycle.length - 1;

  if (!atCycleEnd) {
    return {
      kind: 'advance_to',
      target: cycle[cycleIndex + 1],
      iteration: thread.iteration_count,
    };
  }

  // 2b — end of cycle. Compute the post-cycle target (phase after the
  // last cycle phase in the protocol order). We use the protocol's
  // declared phase order, not the cycle, because the cycle may be a
  // sub-sequence of phases (e.g. [critique, revision] within
  // [proposal, critique, revision, synthesis]).
  const lastCyclePhaseIndex = phaseNames.indexOf(cycle[cycle.length - 1]);
  if (lastCyclePhaseIndex < 0 || lastCyclePhaseIndex + 1 >= phaseNames.length) {
    throw new Error(
      `decideNextPhase: cycle's last phase "${cycle[cycle.length - 1]}" has no post-cycle successor`,
    );
  }
  const postCycleTarget = phaseNames[lastCyclePhaseIndex + 1];

  const iterationBlock = protocol.iteration;
  if (!iterationBlock) {
    // Defensive: `inCycle` was true so iteration should be set. If we
    // got here despite that, fall through to a linear advance.
    return {
      kind: 'advance_to',
      target: postCycleTarget,
      iteration: thread.iteration_count,
    };
  }

  // Evaluate exit_when on the just-finished iteration. The current
  // iteration_count is the one that just completed (the engine has not
  // yet incremented).
  if (
    iterationBlock.exit_when === 'critic_signal' &&
    hasCriticSignalInIteration(thread, thread.iteration_count)
  ) {
    return {
      kind: 'exit_cycle',
      target: postCycleTarget,
      iteration: thread.iteration_count,
      reason: 'critic_signal',
    };
  }

  if (
    iterationBlock.exit_when === 'no_new_critique_artifacts' &&
    noNewCritiqueInIteration(thread, thread.iteration_count)
  ) {
    return {
      kind: 'exit_cycle',
      target: postCycleTarget,
      iteration: thread.iteration_count,
      reason: 'no_new_critique_artifacts',
    };
  }

  // Cap check. If incrementing iteration_count would exceed the cap,
  // exit via max_iterations. (iteration_count is 0-indexed; cap=3 means
  // iterations 0, 1, 2 are allowed; refusing iteration 3 → exit.)
  if (thread.iteration_count + 1 >= iterationBlock.max_iterations) {
    return {
      kind: 'max_iterations',
      target: postCycleTarget,
      iteration: thread.iteration_count + 1,
      max: iterationBlock.max_iterations,
    };
  }

  // Otherwise iterate: cycle back to the first phase of the cycle and
  // bump iteration_count.
  return {
    kind: 'iterate_to',
    target: cycle[0],
    iteration: thread.iteration_count + 1,
  };
}

/**
 * Returns the artifacts produced in a specific iteration window. If an
 * artifact has no `iteration` field (legacy, non-iterating loops, or
 * pre-phase-2.b data), it is treated as belonging to iteration 0 so
 * existing review_loop usage is unaffected.
 */
export function artifactsInIteration(
  thread: LoopThread,
  iteration: number,
): LoopArtifact[] {
  return thread.artifacts.filter((a) => (a.iteration ?? 0) === iteration);
}

/**
 * `exit_when='no_new_critique_artifacts'` predicate: true when the
 * just-completed iteration produced no critique-typed artifacts. Used
 * by `decideNextPhase` at the cycle boundary.
 */
export function noNewCritiqueInIteration(
  thread: LoopThread,
  iteration: number,
): boolean {
  return !thread.artifacts.some(
    (a) => (a.iteration ?? 0) === iteration && a.type === 'critique',
  );
}

/**
 * `exit_when='critic_signal'` predicate: true when the iteration
 * contains a `type='critic_signal'` artifact (any subtype/body). The
 * critic emits this when it judges the proposal sufficient.
 */
export function hasCriticSignalInIteration(
  thread: LoopThread,
  iteration: number,
): boolean {
  return thread.artifacts.some(
    (a) => (a.iteration ?? 0) === iteration && a.type === 'critic_signal',
  );
}
