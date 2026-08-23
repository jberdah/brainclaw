import type {
  GateDecision,
  LoopArtifact,
  LoopKind,
  LoopThread,
  StopCondition,
} from './types.js';
import { evidenceDigest, validateArtifactEvidence } from './evidence.js';

export type EvidencePurpose = 'artifact' | 'reviewer_green' | 'command_green' | 'critic_signal';

export interface GateRequirement {
  right: 'gate:artifact' | 'gate:reviewer_green' | 'gate:command_green';
  attestation: 'observation' | 'approval' | 'verification';
  producer_kinds: readonly ('engine' | 'slot' | 'coordinator' | 'operator')[];
}

export interface GatePolicy {
  version: 'gate-policy-v1';
  kind: LoopKind;
  requirements: Record<EvidencePurpose, GateRequirement>;
}

const OBSERVATION: GateRequirement = {
  right: 'gate:artifact',
  attestation: 'observation',
  producer_kinds: ['slot', 'coordinator', 'operator', 'engine'],
};
const APPROVAL: GateRequirement = {
  right: 'gate:reviewer_green',
  attestation: 'approval',
  producer_kinds: ['slot'],
};
const VERIFICATION: GateRequirement = {
  right: 'gate:command_green',
  attestation: 'verification',
  producer_kinds: ['engine'],
};

/** Policies refine the five protocol graphs; they do not duplicate phase order. */
export const GATE_POLICIES: Record<LoopKind, GatePolicy> = Object.fromEntries(
  (['review', 'ideation', 'implementation', 'research', 'debug'] as const).map((kind) => [
    kind,
    {
      version: 'gate-policy-v1' as const,
      kind,
      requirements: {
        artifact: OBSERVATION,
        reviewer_green: APPROVAL,
        command_green: VERIFICATION,
        critic_signal: OBSERVATION,
      },
    },
  ]),
) as Record<LoopKind, GatePolicy>;

interface EligibilitySet {
  eligible: LoopArtifact[];
  accepted_evidence_ids: string[];
  rejected: Array<{ artifact_id: string; reason: string }>;
}

function hasUsableContent(artifact: LoopArtifact): boolean {
  return (artifact.body ?? '').trim().length > 0 || artifact.ref !== undefined;
}

function payloadFingerprint(artifact: LoopArtifact): string {
  return evidenceDigest({
    phase: artifact.phase,
    type: artifact.type,
    body: artifact.body,
    ref: artifact.ref,
    iteration: artifact.iteration ?? 0,
    producer: artifact.evidence?.subject.slot_id ?? artifact.evidence?.producer.id ?? artifact.produced_by,
  });
}

function selectEligible(
  thread: LoopThread,
  artifacts: LoopArtifact[],
  purpose: EvidencePurpose,
): EligibilitySet {
  const mode = thread.evidence_policy?.mode ?? 'legacy';
  const requirement = GATE_POLICIES[thread.kind].requirements[purpose];
  const eligible: LoopArtifact[] = [];
  const accepted_evidence_ids: string[] = [];
  const rejected: Array<{ artifact_id: string; reason: string }> = [];
  const fingerprints = new Set<string>();

  for (const artifact of artifacts) {
    // critic_signal is intentionally a typed marker; unlike deliverable
    // artifacts it does not require an inline/ref payload.
    if (purpose !== 'critic_signal' && !hasUsableContent(artifact)) {
      rejected.push({ artifact_id: artifact.artifact_id, reason: 'no_usable_content' });
      continue;
    }

    // A present envelope is always validated, including on legacy threads.
    if (artifact.evidence) {
      const validity = validateArtifactEvidence(thread, artifact);
      if (!validity.valid) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: validity.reasons.join(',') });
        continue;
      }
    } else if (mode === 'strict' || mode === 'shadow') {
      rejected.push({ artifact_id: artifact.artifact_id, reason: 'missing_evidence' });
      continue;
    }

    if (mode !== 'legacy') {
      const envelope = artifact.evidence!;
      if (!requirement.producer_kinds.includes(envelope.producer.kind)) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: `producer_not_allowed:${envelope.producer.kind}` });
        continue;
      }
      const attestation = envelope.attestations.find(
        (item) => item.kind === requirement.attestation && item.rights.includes(requirement.right),
      );
      if (!attestation) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: `missing_${requirement.attestation}_attestation` });
        continue;
      }
    }

    const fingerprint = payloadFingerprint(artifact);
    if (fingerprints.has(fingerprint)) {
      rejected.push({ artifact_id: artifact.artifact_id, reason: 'duplicate_payload' });
      continue;
    }
    fingerprints.add(fingerprint);
    eligible.push(artifact);
    if (artifact.evidence) accepted_evidence_ids.push(artifact.evidence.evidence_id);
  }
  return { eligible, accepted_evidence_ids, rejected };
}

function modeFor(thread: LoopThread): GateDecision['mode'] {
  return thread.evidence_policy?.mode ?? 'legacy';
}

function decision(
  thread: LoopThread,
  condition: unknown,
  strictPassed: boolean,
  legacyPassed: boolean,
  set: EligibilitySet = { eligible: [], accepted_evidence_ids: [], rejected: [] },
): GateDecision {
  const mode = modeFor(thread);
  return {
    passed: mode === 'shadow' ? legacyPassed : strictPassed,
    policy_version: mode === 'legacy' ? 'legacy' : 'gate-policy-v1',
    mode,
    condition_digest: evidenceDigest(condition),
    accepted_evidence_ids: [...new Set(set.accepted_evidence_ids)],
    rejected: set.rejected,
  };
}

function artifactCandidates(thread: LoopThread, condition: Extract<StopCondition, { kind: 'artifact_produced' | 'min_artifacts_by_type' }>): LoopArtifact[] {
  return thread.artifacts.filter((artifact) => {
    if (artifact.type !== condition.type) return false;
    if (condition.kind === 'artifact_produced') return artifact.phase === condition.phase;
    if (condition.scope !== 'phase') return true;
    if (artifact.phase !== thread.current_phase) return false;
    const iterationAware = thread.iteration_count > 0 || thread.artifacts.some((item) => item.iteration !== undefined);
    return !iterationAware || (artifact.iteration ?? 0) === thread.iteration_count;
  });
}

/** One evaluator owns both terminal stop conditions and phase gates. */
export function evaluateGateCondition(thread: LoopThread, condition?: StopCondition): GateDecision {
  if (!condition) return decision(thread, { kind: 'absent' }, false, false);
  switch (condition.kind) {
    case 'phase_reached': {
      const passed = thread.current_phase === condition.phase;
      return decision(thread, condition, passed, passed);
    }
    case 'max_iterations':
    case 'min_iterations': {
      const passed = thread.iteration_count >= condition.n;
      return decision(thread, condition, passed, passed);
    }
    case 'no_open_questions': {
      const passed = thread.open_questions.length === 0;
      return decision(thread, condition, passed, passed);
    }
    case 'manual':
      return decision(thread, condition, false, false);
    case 'reviewer_green': {
      const candidates = thread.artifacts.filter((artifact) =>
        artifact.type === 'verdict' && /^accepted(?:\b|[:\s])/.test((artifact.body ?? '').trim().toLowerCase()),
      );
      const set = selectEligible(thread, candidates, 'reviewer_green');
      return decision(thread, condition, set.eligible.length > 0, candidates.some(hasUsableContent), set);
    }
    case 'artifact_produced': {
      const candidates = artifactCandidates(thread, condition);
      const set = selectEligible(thread, candidates, 'artifact');
      return decision(thread, condition, set.eligible.length > 0, candidates.some(hasUsableContent), set);
    }
    case 'min_artifacts_by_type': {
      const candidates = artifactCandidates(thread, condition);
      const set = selectEligible(thread, candidates, 'artifact');
      return decision(thread, condition, set.eligible.length >= condition.n, candidates.filter(hasUsableContent).length >= condition.n, set);
    }
    case 'any': {
      const children = condition.conditions.map((child) => evaluateGateCondition(thread, child));
      return decision(
        thread,
        condition,
        children.some((child) => child.passed),
        children.some((child) => child.passed),
        {
          eligible: [],
          accepted_evidence_ids: children.flatMap((child) => child.accepted_evidence_ids),
          rejected: children.flatMap((child) => child.rejected),
        },
      );
    }
    case 'all': {
      const children = condition.conditions.map((child) => evaluateGateCondition(thread, child));
      return decision(
        thread,
        condition,
        children.every((child) => child.passed),
        children.every((child) => child.passed),
        {
          eligible: [],
          accepted_evidence_ids: children.flatMap((child) => child.accepted_evidence_ids),
          rejected: children.flatMap((child) => child.rejected),
        },
      );
    }
  }
}

export function eligibleArtifactsForPurpose(
  thread: LoopThread,
  artifacts: LoopArtifact[],
  purpose: EvidencePurpose,
): EligibilitySet {
  return selectEligible(thread, artifacts, purpose);
}

export function evaluateCommandGreen(thread: LoopThread, iteration: number): GateDecision {
  const candidates = thread.artifacts.filter((artifact) => {
    if (artifact.type !== 'verify_report' || (artifact.iteration ?? 0) !== iteration) return false;
    try {
      return (JSON.parse(artifact.body ?? '{}') as { passed?: unknown }).passed === true;
    } catch {
      return false;
    }
  });
  const set = selectEligible(thread, candidates, 'command_green');
  return decision(thread, { kind: 'command_green', iteration }, set.eligible.length > 0, candidates.length > 0, set);
}

export function evaluateCriticSignal(thread: LoopThread, iteration: number): GateDecision {
  const candidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critic_signal' && (artifact.iteration ?? 0) === iteration,
  );
  const set = selectEligible(thread, candidates, 'critic_signal');
  return decision(thread, { kind: 'critic_signal', iteration }, set.eligible.length > 0, candidates.length > 0, set);
}

export function evaluateNoNewCritique(thread: LoopThread, iteration: number): GateDecision {
  const candidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critique' && (artifact.iteration ?? 0) === iteration,
  );
  const set = selectEligible(thread, candidates, 'artifact');
  // Invalid/replayed critiques cannot be used to manufacture a negative convergence signal.
  const strictPassed = set.eligible.length === 0 && set.rejected.length === 0;
  return decision(thread, { kind: 'no_new_critique_artifacts', iteration }, strictPassed, candidates.length === 0, set);
}
