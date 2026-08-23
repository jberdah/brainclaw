import type {
  GateDecision,
  EvidenceAttestationKind,
  EvidenceChannel,
  EvidenceProducerKind,
  LoopArtifact,
  LoopKind,
  LoopThread,
  StopCondition,
} from './types.js';
import { evidenceDigest, validateArtifactEvidence } from './evidence.js';
import { captureWorkspaceDigest } from './workspace-digest.js';

export type EvidencePurpose = 'artifact' | 'reviewer_green' | 'command_green' | 'critic_signal';

export interface GateRequirement {
  right: 'gate:artifact' | 'gate:reviewer_green' | 'gate:command_green';
  authorities: readonly GateAuthority[];
}

interface GateAuthority {
  channel: EvidenceChannel;
  producer_kind: EvidenceProducerKind;
  attestation: EvidenceAttestationKind;
  issuer: 'brainclaw:artifact-commit' | 'brainclaw:review-slot' | 'brainclaw:verify-command';
  required_subject_fields?: readonly SubjectBinding[];
}

type SubjectBinding =
  | 'slot_id'
  | 'turn_id'
  | 'run_id'
  | 'nonce_digest'
  | 'attempt_epoch'
  | 'execution_contract_hash'
  | 'command_digest'
  | 'workspace_digest';

export interface GatePolicy {
  version: 'gate-policy-v1';
  kind: LoopKind;
  requirements: Record<EvidencePurpose, GateRequirement>;
}

const OBSERVATION: GateRequirement = {
  right: 'gate:artifact',
  authorities: [
    { channel: 'complete_turn', producer_kind: 'slot', attestation: 'observation', issuer: 'brainclaw:artifact-commit', required_subject_fields: ['slot_id'] },
    { channel: 'reconcile_turn', producer_kind: 'slot', attestation: 'observation', issuer: 'brainclaw:artifact-commit', required_subject_fields: ['slot_id', 'turn_id', 'run_id', 'nonce_digest', 'attempt_epoch', 'execution_contract_hash', 'workspace_digest'] },
    { channel: 'operator_input', producer_kind: 'slot', attestation: 'observation', issuer: 'brainclaw:artifact-commit', required_subject_fields: ['slot_id'] },
    { channel: 'operator_input', producer_kind: 'operator', attestation: 'observation', issuer: 'brainclaw:artifact-commit' },
    { channel: 'operator_input', producer_kind: 'engine', attestation: 'observation', issuer: 'brainclaw:artifact-commit' },
    { channel: 'system_hook', producer_kind: 'engine', attestation: 'observation', issuer: 'brainclaw:artifact-commit' },
    { channel: 'verify_command', producer_kind: 'engine', attestation: 'verification', issuer: 'brainclaw:verify-command', required_subject_fields: ['command_digest', 'workspace_digest'] },
  ],
};
const APPROVAL: GateRequirement = {
  right: 'gate:reviewer_green',
  authorities: [
    { channel: 'complete_turn', producer_kind: 'slot', attestation: 'approval', issuer: 'brainclaw:review-slot', required_subject_fields: ['slot_id'] },
    { channel: 'reconcile_turn', producer_kind: 'slot', attestation: 'approval', issuer: 'brainclaw:review-slot', required_subject_fields: ['slot_id', 'turn_id', 'run_id', 'nonce_digest', 'attempt_epoch', 'execution_contract_hash', 'workspace_digest'] },
  ],
};
const VERIFICATION: GateRequirement = {
  right: 'gate:command_green',
  authorities: [
    { channel: 'verify_command', producer_kind: 'engine', attestation: 'verification', issuer: 'brainclaw:verify-command', required_subject_fields: ['command_digest', 'workspace_digest'] },
  ],
};

const CRITIC_OBSERVATION: GateRequirement = {
  right: 'gate:artifact',
  authorities: OBSERVATION.authorities.filter((authority) =>
    authority.channel === 'complete_turn' || authority.channel === 'reconcile_turn'),
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
        critic_signal: CRITIC_OBSERVATION,
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

function legacyEligibleCount(
  thread: LoopThread,
  artifacts: LoopArtifact[],
  purpose: EvidencePurpose,
): number {
  return artifacts.filter((artifact) => {
    if (purpose !== 'critic_signal' && !hasUsableContent(artifact)) return false;
    return !artifact.evidence || validateArtifactEvidence(thread, artifact).valid;
  }).length;
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
      if (purpose === 'reviewer_green' && (artifact.iteration ?? 0) !== thread.iteration_count) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: 'stale_subject_iteration' });
        continue;
      }
      const channelAuthorities = requirement.authorities.filter((authority) => authority.channel === envelope.producer.channel);
      if (channelAuthorities.length === 0) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: `channel_not_allowed:${envelope.producer.channel}` });
        continue;
      }
      const producerAuthorities = channelAuthorities.filter((authority) => authority.producer_kind === envelope.producer.kind);
      if (producerAuthorities.length === 0) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: `producer_channel_mismatch:${envelope.producer.kind}:${envelope.producer.channel}` });
        continue;
      }
      const authority = producerAuthorities.find((candidate) => envelope.attestations.some(
        (item) => item.kind === candidate.attestation
          && item.issuer === candidate.issuer
          && item.rights.includes(requirement.right),
      ));
      if (!authority) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: `missing_authorized_attestation:${requirement.right}` });
        continue;
      }
      const missingSubject = authority.required_subject_fields?.find(
        (field) => envelope.subject[field] === undefined || envelope.subject[field] === '',
      );
      if (missingSubject) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: `missing_subject_binding:${missingSubject}` });
        continue;
      }
      if (envelope.subject.slot_id) {
        const slot = thread.slots.find((candidate) => candidate.slot_id === envelope.subject.slot_id);
        if (!slot) {
          rejected.push({ artifact_id: artifact.artifact_id, reason: 'unknown_subject_slot' });
          continue;
        }
        if (slot.current_turn_id && envelope.subject.turn_id !== slot.current_turn_id) {
          rejected.push({ artifact_id: artifact.artifact_id, reason: 'wrong_subject_turn' });
          continue;
        }
        if (slot.assignment_id && envelope.subject.assignment_id !== slot.assignment_id) {
          rejected.push({ artifact_id: artifact.artifact_id, reason: 'wrong_subject_assignment' });
          continue;
        }
        if (slot.claim_id && envelope.subject.claim_id !== slot.claim_id) {
          rejected.push({ artifact_id: artifact.artifact_id, reason: 'wrong_subject_claim' });
          continue;
        }
      }
      if (envelope.producer.channel === 'verify_command') {
        let report: {
          command_argv?: string[];
          command_digest?: string;
          cwd?: string;
          workspace_digest?: string;
          workspace_stable?: boolean;
        };
        try {
          report = JSON.parse(artifact.body ?? '{}') as typeof report;
        } catch {
          report = {};
        }
        if (
          report.workspace_stable !== true
          || !report.command_argv
          || evidenceDigest({ command: report.command_argv }) !== report.command_digest
          || (thread.protocol?.verify
            && evidenceDigest({ command: thread.protocol.verify.command }) !== report.command_digest)
          || report.command_digest !== envelope.subject.command_digest
          || report.workspace_digest !== envelope.subject.workspace_digest
        ) {
          rejected.push({ artifact_id: artifact.artifact_id, reason: 'verification_subject_mismatch' });
          continue;
        }
        try {
          if (!report.cwd || captureWorkspaceDigest(report.cwd) !== envelope.subject.workspace_digest) {
            rejected.push({ artifact_id: artifact.artifact_id, reason: 'workspace_changed_after_verification' });
            continue;
          }
        } catch {
          rejected.push({ artifact_id: artifact.artifact_id, reason: 'workspace_freshness_unavailable' });
          continue;
        }
      }
      if (envelope.producer.channel === 'reconcile_turn' && envelope.subject.execution_contract_hash === undefined) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: 'missing_subject_binding:execution_contract_hash' });
        continue;
      }
    }

    if (mode !== 'legacy') {
      const fingerprint = payloadFingerprint(artifact);
      if (fingerprints.has(fingerprint)) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: 'duplicate_payload' });
        continue;
      }
      fingerprints.add(fingerprint);
    }
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
    passed: mode === 'legacy' || mode === 'shadow' ? legacyPassed : strictPassed,
    strict_passed: strictPassed,
    legacy_passed: legacyPassed,
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
      return decision(thread, condition, set.eligible.length > 0, legacyEligibleCount(thread, candidates, 'reviewer_green') > 0, set);
    }
    case 'artifact_produced': {
      const candidates = artifactCandidates(thread, condition);
      const set = selectEligible(thread, candidates, 'artifact');
      return decision(thread, condition, set.eligible.length > 0, legacyEligibleCount(thread, candidates, 'artifact') > 0, set);
    }
    case 'min_artifacts_by_type': {
      const candidates = artifactCandidates(thread, condition);
      const set = selectEligible(thread, candidates, 'artifact');
      return decision(thread, condition, set.eligible.length >= condition.n, legacyEligibleCount(thread, candidates, 'artifact') >= condition.n, set);
    }
    case 'any': {
      const children = condition.conditions.map((child) => evaluateGateCondition(thread, child));
      return decision(
        thread,
        condition,
        children.some((child) => child.strict_passed ?? child.passed),
        children.some((child) => child.legacy_passed ?? child.passed),
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
        children.every((child) => child.strict_passed ?? child.passed),
        children.every((child) => child.legacy_passed ?? child.passed),
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
  return decision(thread, { kind: 'command_green', iteration }, set.eligible.length > 0, legacyEligibleCount(thread, candidates, 'command_green') > 0, set);
}

export function evaluateCriticSignal(thread: LoopThread, iteration: number): GateDecision {
  const candidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critic_signal' && (artifact.iteration ?? 0) === iteration,
  );
  const set = selectEligible(thread, candidates, 'critic_signal');
  return decision(thread, { kind: 'critic_signal', iteration }, set.eligible.length > 0, legacyEligibleCount(thread, candidates, 'critic_signal') > 0, set);
}

export function evaluateNoNewCritique(thread: LoopThread, iteration: number): GateDecision {
  const candidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critique' && (artifact.iteration ?? 0) === iteration,
  );
  const set = selectEligible(thread, candidates, 'artifact');
  const closureCandidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critique_window_closed' && (artifact.iteration ?? 0) === iteration,
  );
  const closure = selectEligible(thread, closureCandidates, 'artifact');
  // Invalid/replayed critiques cannot be used to manufacture a negative convergence signal.
  const strictPassed = set.eligible.length === 0
    && set.rejected.length === 0
    && closure.eligible.length > 0;
  return decision(thread, { kind: 'no_new_critique_artifacts', iteration }, strictPassed, candidates.length === 0, {
    eligible: closure.eligible,
    accepted_evidence_ids: [...set.accepted_evidence_ids, ...closure.accepted_evidence_ids],
    rejected: [...set.rejected, ...closure.rejected],
  });
}
