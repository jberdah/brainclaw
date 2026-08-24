import { listAgentIdentities } from './agent-registry.js';
import { resolveExecutionCandidate, type ExecutionCandidateEvaluation } from './execution-contract.js';
import type { LoopThread } from './loops/types.js';

export const REVIEWER_SELECTION_POLICY_VERSION = 'reviewer-selection-v1' as const;

export interface ReviewerSelection {
  policy_version: typeof REVIEWER_SELECTION_POLICY_VERSION;
  agent: string;
  agent_id: string;
  evaluated: ExecutionCandidateEvaluation[];
  excluded_implementers: Array<{ agent: string; agent_id?: string }>;
}

/**
 * Select a concrete review worker from project-registered identities.
 *
 * The shared execution-contract resolver supplies capability checks and stable
 * ordering. The policy additionally enforces reviewer independence by
 * excluding every identity frozen onto an implementation slot.
 */
export function selectImplementationReviewer(source: LoopThread, cwd?: string): ReviewerSelection {
  if (source.kind !== 'implementation') {
    throw new Error(`reviewer_selection_source_invalid: loop ${source.id} is ${source.kind}`);
  }
  const excludedImplementers = source.slots
    .filter((slot) => Boolean(slot.agent))
    .map((slot) => ({ agent: slot.agent!, ...(slot.agent_id ? { agent_id: slot.agent_id } : {}) }));
  const excludedNames = new Set(excludedImplementers.map((identity) => identity.agent.normalize('NFC')));
  const excludedIds = new Set(excludedImplementers.flatMap((identity) => identity.agent_id ? [identity.agent_id.normalize('NFC')] : []));
  const identities = listAgentIdentities(cwd)
    .filter((identity) => identity.kind !== 'human')
    .filter((identity) => !excludedNames.has(identity.agent_name.normalize('NFC')) && !excludedIds.has(identity.agent_id.normalize('NFC')))
    .map((identity) => ({ agent: identity.agent_name, agent_id: identity.agent_id }));
  const resolution = resolveExecutionCandidate(
    identities,
    { roles: ['review'], required_surfaces: ['cli_spawn'], execution_surfaces: [], required_tools: [] },
  );
  if (resolution.kind !== 'selected') {
    const reasons = resolution.evaluated
      .map((candidate) => `${candidate.agent}:${candidate.snapshot.reasons.map((reason) => reason.code).join('+') || 'excluded'}`)
      .join(', ');
    throw new Error(`continuation_reviewer_unavailable: no independent spawnable reviewer${reasons ? ` (${reasons})` : ''}`);
  }
  return {
    policy_version: REVIEWER_SELECTION_POLICY_VERSION,
    agent: resolution.selected.agent,
    agent_id: resolution.selected.agent_id!,
    evaluated: resolution.evaluated,
    excluded_implementers: excludedImplementers,
  };
}
