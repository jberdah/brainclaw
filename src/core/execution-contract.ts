import crypto from 'node:crypto';

import { z } from 'zod';

import {
  getCapabilityProfile,
  dispatchCanCommit,
  type AgentCapabilityProfile,
  type ExecutionSurface,
  type RoleCapability,
} from './agent-capability.js';
import { ExpectedArtifactSchema } from './loops/artifact-contract.js';

export const EXECUTION_CONTRACT_VERSION = 1 as const;
export const EXECUTION_CONTRACT_PROTOCOL_VERSION = 1 as const;

const RoleCapabilitySchema = z.enum(['execute', 'coordinate', 'review', 'consult']);
const ExecutionSurfaceSchema = z.enum(['cli', 'ide', 'extension', 'remote']);

export const CapabilityRequirementSchema = z.object({
  roles: z.array(RoleCapabilitySchema).default(['execute']),
  required_surfaces: z.array(z.enum([
    'mcp',
    'hooks',
    'skills',
    'rules',
    'auto_approve',
    'cli_spawn',
    'commit',
    'inbox',
  ])).default([]),
  execution_surfaces: z.array(ExecutionSurfaceSchema).default([]),
  model: z.string().min(1).optional(),
  required_tools: z.array(z.string().min(1)).default([]),
});
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;

export const CapabilityResolutionReasonSchema = z.object({
  code: z.enum([
    'agent_profile_missing',
    'role_unsupported',
    'surface_unsupported',
    'execution_surface_mismatch',
    'model_unsupported',
    'tool_catalog_unattested',
  ]),
  requirement: z.string().min(1),
  expected: z.string().optional(),
  actual: z.string().optional(),
});
export type CapabilityResolutionReason = z.infer<typeof CapabilityResolutionReasonSchema>;

export const HarnessCapabilityBindingSchema = z.object({
  adapter_id: z.string().min(1),
  adapter_version: z.string().min(1),
  requested_model: z.string().min(1).optional(),
  resolved_model: z.string().min(1).optional(),
  model_resolution: z.enum(['exact', 'defaulted', 'unattested']),
});
export type HarnessCapabilityBinding = z.infer<typeof HarnessCapabilityBindingSchema>;

export const CapabilitySnapshotSchema = z.object({
  schema_version: z.literal(1),
  agent: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  profile_name: z.string().min(1).optional(),
  accepted: z.boolean(),
  requested: CapabilityRequirementSchema,
  resolved: z.object({
    roles: z.array(RoleCapabilitySchema),
    surfaces: z.array(z.string().min(1)),
    execution_surface: ExecutionSurfaceSchema.optional(),
    model: z.string().min(1).optional(),
    invoke_binary: z.string().min(1).optional(),
    tool_catalog_attested: z.boolean(),
    harness: HarnessCapabilityBindingSchema.optional(),
  }),
  reasons: z.array(CapabilityResolutionReasonSchema),
});
export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshotSchema>;

export const ExecutionContractSchema = z.object({
  schema_version: z.literal(EXECUTION_CONTRACT_VERSION),
  minimum_reader_version: z.number().int().positive().max(EXECUTION_CONTRACT_VERSION).default(1),
  identity: z.object({
    loop_id: z.string().min(1),
    turn_id: z.string().min(1),
    logical_attempt_epoch: z.number().int().nonnegative(),
    assignment_id: z.string().min(1),
    run_id: z.string().min(1),
    kind: z.enum(['review', 'ideation', 'implementation', 'research', 'debug']),
    phase: z.string().min(1),
    iteration: z.number().int().nonnegative(),
  }),
  artifact_contract: z.object({
    completion_mode: z.enum(['file', 'mcp', 'either']),
    expected_artifacts: z.array(ExpectedArtifactSchema),
  }),
  capability_requirement: CapabilityRequirementSchema,
  workspace_policy: z.object({
    scope: z.string().min(1),
    cwd: z.string().min(1),
    worktree_path: z.string().min(1).optional(),
    isolation: z.enum(['worktree', 'shared_checkout', 'none']),
    write_access: z.enum(['read_only', 'workspace', 'unrestricted']),
  }),
  timeout_policy: z.object({
    dispatch_lease_ms: z.number().int().positive(),
    grant_lease_ms: z.number().int().positive(),
  }),
  evidence_policy: z.object({
    require_turn_id: z.literal(true),
    require_run_id: z.literal(true),
    require_nonce: z.literal(true),
    artifact_hash: z.enum(['required', 'optional']),
  }),
  protocol: z.object({
    name: z.literal('attempt-authority'),
    minimum_version: z.number().int().positive().max(EXECUTION_CONTRACT_PROTOCOL_VERSION),
  }),
});
export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;

export const ExecutionContractRefSchema = z.object({
  version: z.literal(EXECUTION_CONTRACT_VERSION),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  turn_id: z.string().min(1),
});
export type ExecutionContractRef = z.infer<typeof ExecutionContractRefSchema>;

export const RuntimeCapabilityObservationSchema = z.object({
  contract_hash: z.string().regex(/^[a-f0-9]{64}$/),
  capability_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  adapter_id: z.string().min(1).optional(),
  adapter_version: z.string().min(1).optional(),
  observed_surfaces: z.array(z.string().min(1)).default([]),
  observed_model: z.string().min(1).optional(),
  accepted_contract_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  accepted_capability_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type RuntimeCapabilityObservation = z.infer<typeof RuntimeCapabilityObservationSchema>;

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const normalized = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key.normalize('NFC'), canonicalValue(item)] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (new Set(normalized.map(([key]) => key)).size !== normalized.length) {
      throw new Error('canonical execution contract contains duplicate NFC-normalized keys');
    }
    return Object.fromEntries(normalized);
  }
  return value;
}

export function canonicalExecutionContract(contract: ExecutionContract): string {
  return JSON.stringify(canonicalValue(ExecutionContractSchema.parse(contract)));
}

export function executionContractHash(contract: ExecutionContract): string {
  return crypto.createHash('sha256').update(canonicalExecutionContract(contract), 'utf8').digest('hex');
}

export function capabilitySnapshotHash(snapshot: CapabilitySnapshot): string {
  const canonical = JSON.stringify(canonicalValue(CapabilitySnapshotSchema.parse(snapshot)));
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function profileSurfaces(profile: AgentCapabilityProfile): string[] {
  const surfaces = [
    profile.hasMcp && 'mcp',
    profile.hasHooks && 'hooks',
    profile.hasSkills && 'skills',
    profile.hasRules && 'rules',
    profile.hasAutoApprove && 'auto_approve',
    profile.runtime.canBeSpawnedCli && 'cli_spawn',
    profile.runtime.inbox && 'inbox',
    dispatchCanCommit(profile) && 'commit',
  ].filter((value): value is string => Boolean(value));
  return [...new Set(surfaces)].sort();
}

function resolvedModel(profile: AgentCapabilityProfile, requested?: string): string | undefined {
  if (!requested) return profile.default_model;
  if (profile.model_flag || profile.default_model === requested) return requested;
  return undefined;
}

export function resolveCapabilitySnapshot(
  agent: string,
  requirementInput: CapabilityRequirement,
  agentId?: string,
  harness?: HarnessCapabilityBinding,
): CapabilitySnapshot {
  const requested = CapabilityRequirementSchema.parse(requirementInput);
  const harnessBinding = harness ? HarnessCapabilityBindingSchema.parse(harness) : undefined;
  const profile = getCapabilityProfile(agent);
  const reasons: CapabilityResolutionReason[] = [];
  if (!profile) {
    reasons.push({ code: 'agent_profile_missing', requirement: 'agent_profile', expected: agent });
    return CapabilitySnapshotSchema.parse({
      schema_version: 1,
      agent,
      agent_id: agentId,
      accepted: false,
      requested,
      resolved: { roles: [], surfaces: [], tool_catalog_attested: false },
      reasons,
    });
  }

  const surfaces = profileSurfaces(profile);
  for (const role of requested.roles) {
    if (!profile.role_capabilities.includes(role as RoleCapability)) {
      reasons.push({
        code: 'role_unsupported',
        requirement: `role:${role}`,
        expected: role,
        actual: profile.role_capabilities.join(','),
      });
    }
  }
  for (const surface of requested.required_surfaces) {
    if (!surfaces.includes(surface)) {
      reasons.push({
        code: 'surface_unsupported',
        requirement: `surface:${surface}`,
        expected: surface,
        actual: surfaces.join(','),
      });
    }
  }
  if (
    requested.execution_surfaces.length > 0
    && !requested.execution_surfaces.includes(profile.execution_env.surface as ExecutionSurface)
  ) {
    reasons.push({
      code: 'execution_surface_mismatch',
      requirement: 'execution_surface',
      expected: requested.execution_surfaces.join(','),
      actual: profile.execution_env.surface,
    });
  }
  const model = resolvedModel(profile, requested.model);
  if (requested.model && !model) {
    reasons.push({
      code: 'model_unsupported',
      requirement: 'model',
      expected: requested.model,
      actual: profile.default_model,
    });
  }
  // Current profiles attest transport surfaces, not per-tool catalogs. Refuse
  // named tools rather than guessing from hasMcp/hasSkills.
  if (requested.required_tools.length > 0) {
    reasons.push({
      code: 'tool_catalog_unattested',
      requirement: 'required_tools',
      expected: requested.required_tools.join(','),
      actual: 'unattested',
    });
  }

  return CapabilitySnapshotSchema.parse({
    schema_version: 1,
    agent,
    agent_id: agentId,
    profile_name: profile.name,
    accepted: reasons.length === 0,
    requested,
    resolved: {
      roles: profile.role_capabilities,
      surfaces,
      execution_surface: profile.execution_env.surface,
      model,
      invoke_binary: profile.invoke_binary,
      tool_catalog_attested: false,
      harness: harnessBinding,
    },
    reasons,
  });
}

export function executionContractRef(contract: ExecutionContract, snapshot: CapabilitySnapshot): ExecutionContractRef {
  return {
    version: contract.schema_version,
    hash: executionContractHash(contract),
    snapshot_hash: capabilitySnapshotHash(snapshot),
    turn_id: contract.identity.turn_id,
  };
}

export function assertExecutionContractIntegrity(
  contract: ExecutionContract,
  ref: ExecutionContractRef,
  snapshot: CapabilitySnapshot,
  selectedAgent?: { agent: string; agent_id?: string },
): void {
  const parsedContract = ExecutionContractSchema.parse(contract);
  const parsedRef = ExecutionContractRefSchema.parse(ref);
  const parsedSnapshot = CapabilitySnapshotSchema.parse(snapshot);
  if (parsedRef.turn_id !== parsedContract.identity.turn_id) {
    throw new Error(`execution contract turn mismatch: ${parsedRef.turn_id} != ${parsedContract.identity.turn_id}`);
  }
  const actualHash = executionContractHash(parsedContract);
  if (parsedRef.hash !== actualHash) {
    throw new Error(`execution contract hash mismatch: ${parsedRef.hash} != ${actualHash}`);
  }
  const actualSnapshotHash = capabilitySnapshotHash(parsedSnapshot);
  if (parsedRef.snapshot_hash !== actualSnapshotHash) {
    throw new Error(`capability snapshot hash mismatch: ${parsedRef.snapshot_hash} != ${actualSnapshotHash}`);
  }
  if (!parsedSnapshot.accepted) {
    throw new Error('execution contract capability snapshot was not accepted');
  }
  if (JSON.stringify(parsedSnapshot.requested) !== JSON.stringify(parsedContract.capability_requirement)) {
    throw new Error('execution contract capability requirement differs from its resolved snapshot');
  }
  if (selectedAgent && parsedSnapshot.agent !== selectedAgent.agent) {
    throw new Error(`capability snapshot agent mismatch: ${parsedSnapshot.agent} != ${selectedAgent.agent}`);
  }
  if (selectedAgent && parsedSnapshot.agent_id !== selectedAgent.agent_id) {
    throw new Error(`capability snapshot agent_id mismatch: ${parsedSnapshot.agent_id ?? 'none'} != ${selectedAgent.agent_id ?? 'none'}`);
  }
}

export interface AcceptedExecutionContractRef {
  contract_hash: string;
  capability_snapshot_hash: string;
}

/**
 * Pre-crossing acceptance emitted by the frozen harness adapter. The child
 * process still confirms the effective environment in its bootstrap ACK after
 * spawn; this attestation proves, before authority crosses, that the selected
 * adapter accepted the exact immutable contract it is about to deliver.
 */
export function attestHarnessContractAcceptance(
  expectedRef: ExecutionContractRef,
  snapshot: CapabilitySnapshot,
  binding: HarnessCapabilityBinding,
): AcceptedExecutionContractRef {
  const parsedSnapshot = CapabilitySnapshotSchema.parse(snapshot);
  const parsedBinding = HarnessCapabilityBindingSchema.parse(binding);
  if (!parsedSnapshot.accepted) {
    throw new Error('harness cannot accept a rejected capability snapshot');
  }
  const frozen = parsedSnapshot.resolved.harness;
  if (!frozen) throw new Error('capability snapshot has no frozen harness binding');
  if (
    frozen.adapter_id !== parsedBinding.adapter_id
    || frozen.adapter_version !== parsedBinding.adapter_version
    || frozen.requested_model !== parsedBinding.requested_model
    || frozen.resolved_model !== parsedBinding.resolved_model
  ) {
    throw new Error(
      `harness acceptance mismatch: frozen ${frozen.adapter_id}@${frozen.adapter_version}, `
      + `selected ${parsedBinding.adapter_id}@${parsedBinding.adapter_version}`,
    );
  }
  return {
    contract_hash: expectedRef.hash,
    capability_snapshot_hash: expectedRef.snapshot_hash,
  };
}

export interface ExecutionCandidate {
  agent: string;
  agent_id?: string;
  /** Higher values win; ties are resolved by normalized identity. */
  preference?: number;
}

export interface ExecutionCandidateEvaluation extends ExecutionCandidate {
  snapshot: CapabilitySnapshot;
}

export type ExecutionCandidateResolution =
  | { kind: 'selected'; selected: ExecutionCandidateEvaluation; evaluated: ExecutionCandidateEvaluation[] }
  | { kind: 'rejected'; evaluated: ExecutionCandidateEvaluation[] };

/**
 * Deterministic capability selection/reselection. Input order is deliberately
 * irrelevant so replaying the same candidate set produces the same worker.
 * Callers can exclude a failed pre-cross candidate and run the resolver again.
 */
export function resolveExecutionCandidate(
  candidates: ExecutionCandidate[],
  requirementInput: CapabilityRequirement,
  options: { exclude?: Array<{ agent: string; agent_id?: string }> } = {},
): ExecutionCandidateResolution {
  const requirement = CapabilityRequirementSchema.parse(requirementInput);
  const excluded = new Set((options.exclude ?? []).map(({ agent, agent_id }) =>
    `${agent.normalize('NFC')}\0${(agent_id ?? '').normalize('NFC')}`));
  const ordered = candidates
    .filter(({ agent, agent_id }) => !excluded.has(`${agent.normalize('NFC')}\0${(agent_id ?? '').normalize('NFC')}`))
    .map((candidate) => ({ ...candidate, agent: candidate.agent.normalize('NFC'), agent_id: candidate.agent_id?.normalize('NFC') }))
    .sort((left, right) =>
      (right.preference ?? 0) - (left.preference ?? 0)
      || left.agent.localeCompare(right.agent, 'en')
      || (left.agent_id ?? '').localeCompare(right.agent_id ?? '', 'en'));
  const evaluated = ordered.map((candidate) => ({
    ...candidate,
    snapshot: resolveCapabilitySnapshot(candidate.agent, requirement, candidate.agent_id),
  }));
  const selected = evaluated.find((candidate) => candidate.snapshot.accepted);
  return selected ? { kind: 'selected', selected, evaluated } : { kind: 'rejected', evaluated };
}

export type ContractAcceptanceVerdict =
  | { kind: 'accepted' }
  | { kind: 'abort_and_reselect'; expected: AcceptedExecutionContractRef; accepted: AcceptedExecutionContractRef }
  | { kind: 'post_crossing_anomaly'; expected: AcceptedExecutionContractRef; accepted: AcceptedExecutionContractRef; respawn: false };

export function validateWorkerContractAcceptance(
  expectedRef: ExecutionContractRef,
  acceptedRef: AcceptedExecutionContractRef,
  launchStatus: 'armed' | 'crossed' | 'revoked' | undefined,
): ContractAcceptanceVerdict {
  const expected = { contract_hash: expectedRef.hash, capability_snapshot_hash: expectedRef.snapshot_hash };
  if (
    expected.contract_hash === acceptedRef.contract_hash
    && expected.capability_snapshot_hash === acceptedRef.capability_snapshot_hash
  ) return { kind: 'accepted' };
  if (launchStatus === 'crossed') {
    return { kind: 'post_crossing_anomaly', expected, accepted: acceptedRef, respawn: false };
  }
  return { kind: 'abort_and_reselect', expected, accepted: acceptedRef };
}
