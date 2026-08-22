import { DEFAULT_PROTOCOLS, LOOP_KINDS, type LoopKind } from './types.js';
import type { ExpectedArtifact } from './attempt-reservation.js';

export type PhaseExecution = 'worker' | 'engine' | 'manual';
export type AttemptCompletionMode = 'file' | 'mcp' | 'either';

export interface LoopPhaseExecutionPolicy {
  execution: PhaseExecution;
  completion_mode?: AttemptCompletionMode;
  expected_artifacts?: ExpectedArtifact[];
  /** Earliest harvest path allowed to settle the attempt and release its claim. */
  finalization?: 'report' | 'integrate';
}

export interface LoopKindPolicy {
  phases: Record<string, LoopPhaseExecutionPolicy>;
}

const expected = (logicalName: string, loopArtifactType = logicalName): ExpectedArtifact => ({
  logical_name: logicalName,
  worker_path: 'LANE-RESULT.json',
  loop_artifact_type: loopArtifactType,
  completion_policy: 'required',
});

/**
 * Execution metadata only. DEFAULT_PROTOCOLS remains canonical for phase
 * graphs, advance gates, iteration and stop conditions.
 */
export const LOOP_KIND_POLICIES: Record<LoopKind, LoopKindPolicy> = {
  review: {
    phases: {
      change_summary: { execution: 'manual' },
      findings: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('review_verdict', 'verdict')], finalization: 'report' },
      author_response: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('author_response')], finalization: 'integrate' },
      followup_review: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('review_verdict', 'verdict')], finalization: 'report' },
      verdict: { execution: 'engine' },
    },
  },
  ideation: {
    phases: {
      proposal: { execution: 'manual' },
      critique: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('critique')], finalization: 'report' },
      // The coordinator currently auto-dispatches critics only. Champion
      // revision/synthesis remain explicit loop turns until a dedicated driver
      // can allocate phase-safe attempt identities without changing turn_id.
      revision: { execution: 'manual' },
      synthesis: { execution: 'manual' },
    },
  },
  implementation: {
    phases: {
      bind: { execution: 'engine' },
      execute: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('execute_report')], finalization: 'integrate' },
      verify: { execution: 'engine' },
      handoff_ready: { execution: 'manual' },
    },
  },
  research: {
    phases: {
      investigate: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('finding')], finalization: 'report' },
      synthesize: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('synthesis')], finalization: 'report' },
      conclude: { execution: 'engine' },
    },
  },
  debug: {
    phases: {
      reproduce: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('repro')], finalization: 'report' },
      hypothesize: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('hypothesis')], finalization: 'report' },
      isolate: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('isolation_report')], finalization: 'report' },
      fix: { execution: 'worker', completion_mode: 'either', expected_artifacts: [expected('verify_report')], finalization: 'integrate' },
      handoff: { execution: 'manual' },
    },
  },
};

export function policyForKind(kind: LoopKind): LoopKindPolicy {
  return LOOP_KIND_POLICIES[kind];
}

export function phasePolicy(kind: LoopKind, phase: string): LoopPhaseExecutionPolicy | undefined {
  return LOOP_KIND_POLICIES[kind].phases[phase];
}

export function isWorkerPhase(kind: LoopKind, phase: string): boolean {
  return phasePolicy(kind, phase)?.execution === 'worker';
}

/** Runtime assertion used by conformance tests and startup diagnostics. */
export function assertLoopKindPoliciesComplete(): void {
  for (const kind of LOOP_KINDS) {
    const policy = LOOP_KIND_POLICIES[kind];
    if (!policy) throw new Error(`missing LoopKindPolicy for ${kind}`);
    const protocolPhases = DEFAULT_PROTOCOLS[kind].phases.map((phase) => phase.name).sort();
    const policyPhases = Object.keys(policy.phases).sort();
    if (JSON.stringify(protocolPhases) !== JSON.stringify(policyPhases)) {
      throw new Error(`${kind} policy phases diverge from DEFAULT_PROTOCOLS: policy=${policyPhases.join(',')} protocol=${protocolPhases.join(',')}`);
    }
    for (const [phase, phaseExecution] of Object.entries(policy.phases)) {
      if (phaseExecution.execution === 'worker') {
        if (!phaseExecution.completion_mode || !phaseExecution.expected_artifacts?.length || !phaseExecution.finalization) {
          throw new Error(`${kind}.${phase} worker policy is incomplete`);
        }
      } else if (phaseExecution.completion_mode || phaseExecution.expected_artifacts?.length || phaseExecution.finalization) {
        throw new Error(`${kind}.${phase} ${phaseExecution.execution} policy must not declare worker execution metadata`);
      }
    }
  }
}
