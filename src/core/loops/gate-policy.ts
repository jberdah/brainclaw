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
import {
  currentNonce,
  findReservationByAssignmentId,
  getReservation,
} from './attempt-reservation.js';
import {
  readLaunchDecision,
  resolveTurnGenerationChain,
} from './attempt-generations.js';

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

const NO_REVIEWER_GREEN: GateRequirement = { right: 'gate:reviewer_green', authorities: [] };
const NO_COMMAND_GREEN: GateRequirement = { right: 'gate:command_green', authorities: [] };
const NO_CRITIC_SIGNAL: GateRequirement = { right: 'gate:artifact', authorities: [] };

/** Policies refine the five protocol graphs; they do not duplicate phase order. */
export const GATE_POLICIES: Record<LoopKind, GatePolicy> = {
  review: {
    version: 'gate-policy-v1',
    kind: 'review',
    requirements: {
      artifact: OBSERVATION,
      reviewer_green: APPROVAL,
      command_green: NO_COMMAND_GREEN,
      critic_signal: NO_CRITIC_SIGNAL,
    },
  },
  ideation: {
    version: 'gate-policy-v1',
    kind: 'ideation',
    requirements: {
      artifact: OBSERVATION,
      reviewer_green: NO_REVIEWER_GREEN,
      command_green: NO_COMMAND_GREEN,
      critic_signal: CRITIC_OBSERVATION,
    },
  },
  implementation: {
    version: 'gate-policy-v1',
    kind: 'implementation',
    requirements: {
      artifact: OBSERVATION,
      reviewer_green: NO_REVIEWER_GREEN,
      command_green: VERIFICATION,
      critic_signal: NO_CRITIC_SIGNAL,
    },
  },
  research: {
    version: 'gate-policy-v1',
    kind: 'research',
    requirements: {
      artifact: OBSERVATION,
      reviewer_green: NO_REVIEWER_GREEN,
      command_green: NO_COMMAND_GREEN,
      // The shipped research FSM exits investigate↔synthesize on this signal.
      critic_signal: CRITIC_OBSERVATION,
    },
  },
  debug: {
    version: 'gate-policy-v1',
    kind: 'debug',
    requirements: {
      artifact: OBSERVATION,
      reviewer_green: NO_REVIEWER_GREEN,
      // The shipped debug FSM exits hypothesize↔isolate↔fix on command_green.
      command_green: VERIFICATION,
      critic_signal: NO_CRITIC_SIGNAL,
    },
  },
};

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
  cwd?: string,
): number {
  return legacyEligibleArtifacts(thread, artifacts, purpose, cwd).length;
}

function legacyEligibleArtifacts(
  thread: LoopThread,
  artifacts: LoopArtifact[],
  purpose: EvidencePurpose,
  cwd?: string,
): LoopArtifact[] {
  // Kind-specialized purposes stay fail-closed even for persisted legacy
  // loops. Legacy relaxes envelope presence; it does not invent an authority
  // that the kind's policy explicitly forbids.
  if (GATE_POLICIES[thread.kind].requirements[purpose].authorities.length === 0) return [];
  return artifacts.filter((artifact) => {
    if (purpose !== 'critic_signal' && !hasUsableContent(artifact)) return false;
    if (!artifact.evidence) return true;
    return validateArtifactEvidence(thread, artifact).valid
      && reconciledV2AuthorityRejection(thread, artifact, cwd) === undefined;
  });
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

/**
 * A reconciled v2 envelope is only a claim about an attempt until the gate
 * compares it with immutable AttemptAuthority. The persisted nonce is a digest
 * (never the bearer token), so compare it with a server-derived digest of the
 * current generation nonce.
 *
 * No v2 chain enters an explicit restrictive legacy verifier backed by the
 * committed reservation. Missing/unverifiable authority and every tuple
 * mismatch are fail-closed in both modes.
 */
function reconciledV2AuthorityRejection(
  thread: LoopThread,
  artifact: LoopArtifact,
  cwd?: string,
): string | undefined {
  const envelope = artifact.evidence;
  if (!envelope || envelope.producer.channel !== 'reconcile_turn') return undefined;

  const subject = envelope.subject;
  const reservation = subject.assignment_id
    ? findReservationByAssignmentId(subject.assignment_id, cwd)
    : undefined;
  const resolvedReservation = reservation ?? (subject.turn_id ? getReservation(subject.turn_id, cwd) : undefined);
  if (!resolvedReservation) return 'reconciled_authority_missing';

  let chain: ReturnType<typeof resolveTurnGenerationChain>;
  try {
    chain = resolveTurnGenerationChain(resolvedReservation.store_root, resolvedReservation.turn_id);
  } catch {
    return 'reconciled_authority_unreadable';
  }
  if (!chain) {
    // Legacy is deliberately narrow, not permissive: every binding is
    // reconstructed from the committed, crossed reservation. Pre-P1 records
    // have no stored ExecutionContract, so use the same deterministic
    // compatibility identities the reconciler seals. This preserves dual-read
    // without accepting a caller-chosen hash.
    const nonce = currentNonce(resolvedReservation);
    if (
      resolvedReservation.decision !== 'committed'
      || resolvedReservation.launch?.status !== 'crossed'
      || !nonce
    ) {
      return 'reconciled_legacy_authority_unverifiable';
    }
    const contractHash = resolvedReservation.execution_contract_ref?.hash ?? evidenceDigest({
      version: 'legacy-uncontracted-reservation-v1',
      turn_id: resolvedReservation.turn_id,
      run_id: resolvedReservation.child_ids.run_id,
      epoch: resolvedReservation.epoch,
      phase: resolvedReservation.phase,
      iteration: resolvedReservation.iteration,
      cwd: resolvedReservation.cwd,
    });
    const workspaceDigest = evidenceDigest({
      workspace_policy: resolvedReservation.execution_contract?.workspace_policy,
      cwd: resolvedReservation.cwd,
      store_root: resolvedReservation.store_root,
    });
    const expectedLegacy = {
      loop_id: resolvedReservation.loop_id,
      slot_id: resolvedReservation.slot_id,
      turn_id: resolvedReservation.turn_id,
      assignment_id: resolvedReservation.child_ids.assignment_id,
      run_id: resolvedReservation.child_ids.run_id,
      nonce_digest: evidenceDigest({ launch_nonce: nonce }),
      attempt_epoch: resolvedReservation.epoch,
      execution_contract_hash: contractHash,
      workspace_digest: workspaceDigest,
    } as const;
    const actualLegacy = {
      loop_id: thread.id,
      slot_id: subject.slot_id,
      turn_id: subject.turn_id,
      assignment_id: subject.assignment_id,
      run_id: subject.run_id,
      nonce_digest: subject.nonce_digest,
      attempt_epoch: subject.attempt_epoch,
      execution_contract_hash: subject.execution_contract_hash,
      workspace_digest: subject.workspace_digest,
    } as const;
    const mismatch = (Object.keys(expectedLegacy) as Array<keyof typeof expectedLegacy>)
      .find((field) => actualLegacy[field] !== expectedLegacy[field]);
    return mismatch ? `reconciled_legacy_authority_mismatch:${mismatch}` : undefined;
  }
  if (chain.status !== 'active' && chain.status !== 'settled') {
    return `reconciled_authority_not_usable:${chain.status}`;
  }

  const generation = chain.latest_generation;
  let launch: ReturnType<typeof readLaunchDecision>;
  try {
    launch = readLaunchDecision(
      resolvedReservation.store_root,
      generation.turn_id,
      generation.attempt_epoch,
    );
  } catch {
    return 'reconciled_authority_unreadable';
  }
  if (launch?.decision !== 'crossed') return 'reconciled_authority_launch_not_crossed';

  const expected = {
    loop_id: resolvedReservation.loop_id,
    slot_id: resolvedReservation.slot_id,
    turn_id: generation.turn_id,
    assignment_id: generation.assignment_id,
    run_id: generation.run_id,
    nonce_digest: evidenceDigest({ launch_nonce: generation.launch_nonce }),
    attempt_epoch: generation.attempt_epoch,
    execution_contract_hash: generation.contract_hash,
    workspace_digest: generation.workspace_digest,
  } as const;
  const actual = {
    loop_id: thread.id,
    slot_id: subject.slot_id,
    turn_id: subject.turn_id,
    assignment_id: subject.assignment_id,
    run_id: subject.run_id,
    nonce_digest: subject.nonce_digest,
    attempt_epoch: subject.attempt_epoch,
    execution_contract_hash: subject.execution_contract_hash,
    workspace_digest: subject.workspace_digest,
  } as const;
  const mismatch = (Object.keys(expected) as Array<keyof typeof expected>)
    .find((field) => actual[field] !== expected[field]);
  return mismatch ? `reconciled_authority_mismatch:${mismatch}` : undefined;
}

function selectEligible(
  thread: LoopThread,
  artifacts: LoopArtifact[],
  purpose: EvidencePurpose,
  cwd?: string,
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
      const authorityRejection = reconciledV2AuthorityRejection(thread, artifact, cwd);
      if (authorityRejection) {
        rejected.push({ artifact_id: artifact.artifact_id, reason: authorityRejection });
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
export function evaluateGateCondition(thread: LoopThread, condition?: StopCondition, cwd?: string): GateDecision {
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
      const set = selectEligible(thread, candidates, 'reviewer_green', cwd);
      return decision(thread, condition, set.eligible.length > 0, legacyEligibleCount(thread, candidates, 'reviewer_green', cwd) > 0, set);
    }
    case 'artifact_produced': {
      const candidates = artifactCandidates(thread, condition);
      const set = selectEligible(thread, candidates, 'artifact', cwd);
      return decision(thread, condition, set.eligible.length > 0, legacyEligibleCount(thread, candidates, 'artifact', cwd) > 0, set);
    }
    case 'min_artifacts_by_type': {
      const candidates = artifactCandidates(thread, condition);
      const set = selectEligible(thread, candidates, 'artifact', cwd);
      const requiredLanes = thread.kind === 'implementation' && condition.type === 'verify_report'
        ? [...new Set(thread.slots.map((slot) => slot.lane).filter((lane): lane is string => Boolean(lane)))]
        : [];
      const covers = (artifacts: LoopArtifact[]): boolean => {
        if (requiredLanes.length === 0) return artifacts.length >= condition.n;
        const reported = new Set(artifacts.flatMap((artifact) => {
          try {
            const lane = (JSON.parse(artifact.body ?? '{}') as { lane?: string }).lane;
            return lane ? [lane] : [];
          } catch { return []; }
        }));
        return requiredLanes.every((lane) => reported.has(lane));
      };
      return decision(
        thread,
        condition,
        covers(set.eligible),
        covers(legacyEligibleArtifacts(thread, candidates, 'artifact', cwd)),
        set,
      );
    }
    case 'any': {
      const children = condition.conditions.map((child) => evaluateGateCondition(thread, child, cwd));
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
      const children = condition.conditions.map((child) => evaluateGateCondition(thread, child, cwd));
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
  cwd?: string,
): EligibilitySet {
  return selectEligible(thread, artifacts, purpose, cwd);
}

export function evaluateCommandGreen(thread: LoopThread, iteration: number, cwd?: string): GateDecision {
  const candidates = thread.artifacts.filter((artifact) => {
    if (artifact.type !== 'verify_report' || (artifact.iteration ?? 0) !== iteration) return false;
    try {
      return (JSON.parse(artifact.body ?? '{}') as { passed?: unknown }).passed === true;
    } catch {
      return false;
    }
  });
  const set = selectEligible(thread, candidates, 'command_green', cwd);
  const requiredLanes = thread.kind === 'implementation'
    ? [...new Set(thread.slots.map((slot) => slot.lane).filter((lane): lane is string => Boolean(lane)))]
    : [];
  const greenLanes = new Set(set.eligible.flatMap((artifact) => {
    try {
      const lane = (JSON.parse(artifact.body ?? '{}') as { lane?: string }).lane;
      return lane ? [lane] : [];
    } catch { return []; }
  }));
  const allLanesGreen = requiredLanes.length === 0
    ? set.eligible.length > 0
    : requiredLanes.every((lane) => greenLanes.has(lane));
  const legacyCandidates = legacyEligibleArtifacts(thread, candidates, 'command_green', cwd);
  const legacyGreenLanes = new Set(legacyCandidates.flatMap((artifact) => {
    try {
      const lane = (JSON.parse(artifact.body ?? '{}') as { lane?: string }).lane;
      return lane ? [lane] : [];
    } catch { return []; }
  }));
  const legacyAllLanesGreen = requiredLanes.length === 0
    ? legacyCandidates.length > 0
    : requiredLanes.every((lane) => legacyGreenLanes.has(lane));
  return decision(thread, { kind: 'command_green', iteration }, allLanesGreen, legacyAllLanesGreen, set);
}

export function evaluateCriticSignal(thread: LoopThread, iteration: number, cwd?: string): GateDecision {
  const candidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critic_signal' && (artifact.iteration ?? 0) === iteration,
  );
  const set = selectEligible(thread, candidates, 'critic_signal', cwd);
  return decision(thread, { kind: 'critic_signal', iteration }, set.eligible.length > 0, legacyEligibleCount(thread, candidates, 'critic_signal', cwd) > 0, set);
}

export function evaluateNoNewCritique(thread: LoopThread, iteration: number, cwd?: string): GateDecision {
  const candidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critique' && (artifact.iteration ?? 0) === iteration,
  );
  const set = selectEligible(thread, candidates, 'artifact', cwd);
  const closureCandidates = thread.artifacts.filter(
    (artifact) => artifact.type === 'critique_window_closed' && (artifact.iteration ?? 0) === iteration,
  );
  const closure = selectEligible(thread, closureCandidates, 'artifact', cwd);
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
