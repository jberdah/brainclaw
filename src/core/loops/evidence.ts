import crypto from 'node:crypto';

import type {
  EvidenceAttestation,
  EvidenceChannel,
  EvidenceEnvelope,
  EvidencePolicyBinding,
  EvidenceProducerKind,
  LoopArtifact,
  LoopThread,
} from './types.js';

export const GATE_POLICY_VERSION = 'gate-policy-v1' as const;

export interface EvidenceCommitContext {
  channel: EvidenceChannel;
  producer_kind: EvidenceProducerKind;
  producer_id: string;
  agent_id?: string;
  slot_id?: string;
  slot_role?: string;
  turn_id?: string;
  assignment_id?: string;
  claim_id?: string;
  run_id?: string;
  nonce?: string;
  attempt_epoch?: number;
  execution_contract_hash?: string;
  command_digest?: string;
  workspace_digest?: string;
}

export interface EvidenceValidationResult {
  valid: boolean;
  reasons: string[];
  evidence_id?: string;
}

export interface ThreadEvidenceDiagnostic {
  artifact_id: string;
  reasons: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function evidenceDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function artifactEvidenceDigest(artifact: Omit<LoopArtifact, 'evidence'>): string {
  return evidenceDigest({
    artifact_id: artifact.artifact_id,
    phase: artifact.phase,
    type: artifact.type,
    ref: artifact.ref,
    body: artifact.body,
    produced_by: artifact.produced_by,
    produced_at: artifact.produced_at,
    addresses_critique: artifact.addresses_critique,
    implementation_verify: artifact.implementation_verify,
    iteration: artifact.iteration ?? 0,
  });
}

/**
 * Classify both new and historical artifacts without a migration rewrite.
 * Old sealed envelopes predate the explicit field but are still attested;
 * old unsealed records remain legacy. The marker is intentionally excluded
 * from artifactEvidenceDigest so adding it cannot invalidate a v1 seal.
 */
export function artifactEvidenceProvenance(artifact: LoopArtifact): 'legacy' | 'attested' {
  return artifact.provenance ?? (artifact.evidence ? 'attested' : 'legacy');
}

function isAcceptedVerdict(artifact: Omit<LoopArtifact, 'evidence'>): boolean {
  return artifact.type === 'verdict' && /^accepted(?:\b|[:\s])/.test((artifact.body ?? '').trim().toLowerCase());
}

function attestation(
  kind: EvidenceAttestation['kind'],
  issuer: string,
  issued_at: string,
  subject_digest: string,
  rights: string[],
): EvidenceAttestation {
  return { kind, issuer, issued_at, subject_digest, rights };
}

/**
 * Bind evidence at the server-controlled artifact commit boundary. Callers
 * provide identity context, never an envelope or rights.
 */
export function sealArtifactEvidence(
  thread: LoopThread,
  artifact: Omit<LoopArtifact, 'evidence'>,
  context: EvidenceCommitContext,
): LoopArtifact {
  const committedArtifact: Omit<LoopArtifact, 'evidence'> = {
    ...artifact,
    produced_by: context.producer_id,
    iteration: artifact.iteration ?? thread.iteration_count,
  };
  const iteration = committedArtifact.iteration ?? thread.iteration_count;
  const subject = {
    loop_id: thread.id,
    artifact_id: artifact.artifact_id,
    phase: artifact.phase,
    iteration,
    slot_id: context.slot_id,
    turn_id: context.turn_id,
    assignment_id: context.assignment_id,
    claim_id: context.claim_id,
    run_id: context.run_id,
    nonce_digest: context.nonce ? evidenceDigest({ launch_nonce: context.nonce }) : undefined,
    attempt_epoch: context.attempt_epoch,
    execution_contract_hash: context.execution_contract_hash,
    command_digest: context.command_digest,
    workspace_digest: context.workspace_digest,
  };
  const subjectDigest = evidenceDigest(subject);
  const attestations: EvidenceAttestation[] = [];

  if (context.claim_id) {
    attestations.push(attestation('claim', 'brainclaw:claim-binding', committedArtifact.produced_at, subjectDigest, ['subject:claim']));
  }
  if (context.channel === 'verify_command' && context.producer_kind === 'engine') {
    attestations.push(attestation('verification', 'brainclaw:verify-command', committedArtifact.produced_at, subjectDigest, ['artifact:write', 'gate:artifact', 'gate:command_green']));
  } else {
    const rights = context.channel === 'add_artifact'
      ? ['artifact:write']
      : ['artifact:write', 'gate:artifact'];
    attestations.push(attestation('observation', 'brainclaw:artifact-commit', committedArtifact.produced_at, subjectDigest, rights));
  }
  if (
    isAcceptedVerdict(committedArtifact) &&
    (context.channel === 'complete_turn' || context.channel === 'reconcile_turn') &&
    /review/i.test(context.slot_role ?? '')
  ) {
    attestations.push(attestation('approval', 'brainclaw:review-slot', committedArtifact.produced_at, subjectDigest, ['gate:reviewer_green']));
  }

  const unsigned: Omit<EvidenceEnvelope, 'seal'> = {
    version: 1,
    evidence_id: `evd_${crypto.randomBytes(8).toString('hex')}`,
    evidence_type: 'artifact_commit',
    policy_version: GATE_POLICY_VERSION,
    subject,
    producer: {
      kind: context.producer_kind,
      id: context.producer_id,
      agent_id: context.agent_id,
      channel: context.channel,
    },
    artifact_digest: artifactEvidenceDigest(committedArtifact),
    issued_at: committedArtifact.produced_at,
    observed_at: committedArtifact.produced_at,
    validity: { not_before: committedArtifact.produced_at },
    attestations,
  };
  const envelope: EvidenceEnvelope = {
    ...unsigned,
    seal: { algorithm: 'sha256', digest: evidenceDigest(unsigned) },
  };
  return { ...committedArtifact, provenance: 'attested', evidence: envelope };
}

/** Validate every binding before an envelope may influence a gate. */
export function validateArtifactEvidence(
  thread: LoopThread,
  artifact: LoopArtifact,
  now = new Date(),
): EvidenceValidationResult {
  const envelope = artifact.evidence;
  if (!envelope) return { valid: false, reasons: ['missing_evidence'] };
  const reasons: string[] = [];
  const { seal, ...unsigned } = envelope;
  if (seal.algorithm !== 'sha256' || evidenceDigest(unsigned) !== seal.digest) reasons.push('invalid_seal');

  const { evidence: _ignored, ...unsignedArtifact } = artifact;
  void _ignored;
  if (artifactEvidenceDigest(unsignedArtifact) !== envelope.artifact_digest) reasons.push('artifact_digest_mismatch');
  if (envelope.subject.loop_id !== thread.id) reasons.push('wrong_loop_subject');
  if (envelope.subject.artifact_id !== artifact.artifact_id) reasons.push('wrong_artifact_subject');
  if (envelope.subject.phase !== artifact.phase) reasons.push('wrong_phase_subject');
  if (envelope.subject.iteration !== (artifact.iteration ?? 0)) reasons.push('wrong_iteration_subject');
  if (envelope.issued_at !== artifact.produced_at) reasons.push('issued_at_mismatch');
  if (envelope.observed_at !== artifact.produced_at) reasons.push('observed_at_mismatch');

  const issued = Date.parse(envelope.issued_at);
  const loopCreated = Date.parse(thread.created_at);
  if (!Number.isFinite(issued)) reasons.push('invalid_issued_at');
  if (Number.isFinite(issued) && Number.isFinite(loopCreated) && issued < loopCreated - 5 * 60_000) reasons.push('stale_before_loop');
  if (Number.isFinite(issued) && issued > now.getTime() + 5 * 60_000) reasons.push('issued_in_future');
  const notBefore = Date.parse(envelope.validity.not_before);
  const notAfter = envelope.validity.not_after ? Date.parse(envelope.validity.not_after) : undefined;
  if (!Number.isFinite(notBefore) || issued < notBefore) reasons.push('outside_validity_window');
  if (notAfter !== undefined && (!Number.isFinite(notAfter) || now.getTime() > notAfter)) reasons.push('outside_validity_window');
  if (notAfter !== undefined && Number.isFinite(notBefore) && Number.isFinite(notAfter) && notAfter < notBefore) reasons.push('invalid_validity_window');
  if (artifact.produced_by !== envelope.producer.id) reasons.push('producer_binding_mismatch');

  const subjectDigest = evidenceDigest(envelope.subject);
  for (const item of envelope.attestations) {
    if (item.subject_digest !== subjectDigest) reasons.push(`attestation_subject_mismatch:${item.kind}`);
    if (item.issued_at !== envelope.issued_at) reasons.push(`attestation_time_mismatch:${item.kind}`);
  }
  return { valid: reasons.length === 0, reasons, evidence_id: envelope.evidence_id };
}

export function validateThreadEvidence(thread: LoopThread): ThreadEvidenceDiagnostic[] {
  return thread.artifacts.flatMap((artifact) => {
    if (!artifact.evidence) return [];
    const result = validateArtifactEvidence(thread, artifact);
    return result.valid ? [] : [{ artifact_id: artifact.artifact_id, reasons: result.reasons }];
  });
}

/** Feature rollout: new loops are strict unless the writer is explicitly disabled or shadowed. */
export function evidencePolicyForNewLoop(env: NodeJS.ProcessEnv = process.env): EvidencePolicyBinding | undefined {
  const configured = env.BRAINCLAW_EVIDENCE_ENVELOPES?.trim().toLowerCase();
  if (configured === 'off') return undefined;
  if (configured === 'shadow') return { version: GATE_POLICY_VERSION, mode: 'shadow' };
  return { version: GATE_POLICY_VERSION, mode: 'strict' };
}

export function evidenceWriterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRAINCLAW_EVIDENCE_ENVELOPES?.trim().toLowerCase() !== 'off';
}
