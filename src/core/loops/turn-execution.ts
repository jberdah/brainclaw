/** Common projections-before-crossing contract for every worker-backed LoopKind phase. */
import { ensureAgentRunProjection } from '../agentruns.js';
import { ensureAssignmentProjection } from '../assignments.js';
import { ensureClaimAssignmentBinding, loadClaim } from '../claims.js';
import {
  CapabilityRequirementSchema,
  ExecutionContractSchema,
  executionContractRef,
  resolveCapabilitySnapshot,
  validateWorkerContractAcceptance,
  type AcceptedExecutionContractRef,
  type CapabilityRequirement,
  type CapabilitySnapshot,
  type ExecutionContractRef,
  HarnessCapabilityBindingSchema,
  type HarnessCapabilityBinding,
} from '../execution-contract.js';
import { resolveHarnessBinding } from '../harness-adapters/index.js';
import { bindTurnProjection } from './verbs.js';
import { deriveChildIds, deriveTurnId, getReservation, launchGrant, type TurnReservation } from './attempt-reservation.js';
import {
  bootstrapAttemptAuthorityV2,
  crossActiveAttemptGenerationV2,
  executionContractForGeneration,
  prepareAttempt,
  projectAndCross,
} from './attempt-authority.js';
import { resolveTurnGenerationChain } from './attempt-generations.js';
import { readLocalAuthorityHome, resolveActiveAttemptRollout } from './attempt-rollout.js';
import { getLoop } from './store.js';
import { phasePolicy } from './kind-policies.js';
import type { LoopKind } from './types.js';

export type TurnProjectionStage = 'assignment' | 'run' | 'claim_binding' | 'slot_binding' | 'before_crossing';

export interface TurnExecutionProjectionInput {
  loop_id: string;
  slot_id: string;
  turn_id: string;
  assignment_id: string;
  run_id: string;
  agent: string;
  agent_id?: string;
  dispatcher_agent: string;
  dispatcher_agent_id?: string;
  dispatcher_session_id?: string;
  scope: string;
  description: string;
  task: string;
  worktree_path?: string;
  assignment_tags?: string[];
  run_tags?: string[];
  /** Physical generation index (1-based AgentRun projection). */
  attempt_index?: number;
  execution_contract_ref?: ExecutionContractRef;
  capability_snapshot?: CapabilitySnapshot;
  on_projection?: (stage: TurnProjectionStage) => void;
}

/** Idempotently materialize every child projection required before launch. */
export function ensureTurnExecutionProjections(
  reservation: TurnReservation,
  input: TurnExecutionProjectionInput,
  cwd?: string,
): void {
  if (reservation.claim_id === '') throw new Error('attempt reservation has no claim');
  ensureAssignmentProjection({
    id: input.assignment_id,
    short_label: input.assignment_id,
    claim_id: reservation.claim_id,
    agent: input.agent,
    agent_id: input.agent_id,
    dispatcher_agent: input.dispatcher_agent,
    dispatcher_session_id: input.dispatcher_session_id,
    scope: input.scope,
    description: input.description,
    // Assignment is the stable logical attempt. Its contract projection stays
    // generation-zero; each physical AgentRun below carries its own contract.
    execution_contract_ref: reservation.execution_contract_ref,
    capability_snapshot: reservation.capability_snapshot,
    tags: input.assignment_tags ?? ['coordinate', 'loop', 'turn-owned'],
  }, cwd);
  input.on_projection?.('assignment');

  ensureAgentRunProjection({
    id: input.run_id,
    short_label: input.run_id,
    assignment_id: input.assignment_id,
    claim_id: reservation.claim_id,
    attempt_index: input.attempt_index ?? 1,
    agent: input.agent,
    agent_id: input.agent_id,
    transport: 'cli_spawn',
    status: 'created',
    scope: input.scope,
    description: input.description,
    worktree_path: input.worktree_path,
    execution_contract_ref: input.execution_contract_ref ?? reservation.execution_contract_ref,
    capability_snapshot: input.capability_snapshot ?? reservation.capability_snapshot,
    tags: input.run_tags ?? ['turn-owned', 'loop'],
  }, cwd);
  input.on_projection?.('run');

  ensureClaimAssignmentBinding(reservation.claim_id, input.assignment_id, cwd);
  input.on_projection?.('claim_binding');

  bindTurnProjection({
    id: input.loop_id,
    slot_id: input.slot_id,
    actor: input.dispatcher_agent_id ?? input.dispatcher_agent,
    input: input.task,
    turn_id: input.turn_id,
    assignment_id: input.assignment_id,
    claim_id: reservation.claim_id,
  }, cwd);
  input.on_projection?.('slot_binding');
  input.on_projection?.('before_crossing');
}

export interface PrepareTurnExecutionInput {
  kind: LoopKind;
  loop_id: string;
  slot_id: string;
  phase: string;
  agent: string;
  agent_id?: string;
  claim_id: string;
  dispatcher_agent: string;
  dispatcher_agent_id?: string;
  dispatcher_session_id?: string;
  scope: string;
  description: string;
  task: string;
  cwd: string;
  worktree_path?: string;
  assignment_tags?: string[];
  run_tags?: string[];
  dispatch_lease_ms?: number;
  grant_lease_ms?: number;
  /** Resolved/requested model identity to freeze in the capability contract. */
  model?: string;
  /** Required runtime capabilities; defaults to a CLI-spawnable executor. */
  capability_requirement?: CapabilityRequirement;
  /** Harness identity resolved before crossing and frozen into the capability snapshot. */
  harness_binding?: HarnessCapabilityBinding;
  /** Contract + snapshot hashes accepted by a pre-crossing worker adapter. */
  accepted_execution_contract?: AcceptedExecutionContractRef;
  /** Optional policy overrides captured immutably in the contract. */
  workspace_policy?: {
    isolation?: 'worktree' | 'shared_checkout' | 'none';
    write_access?: 'read_only' | 'workspace' | 'unrestricted';
  };
  on_authority_stage?: (stage: 'reserved' | 'committed' | 'armed') => void;
  on_projection?: (stage: TurnProjectionStage) => void;
  /** Fault-injection/telemetry seam around the one-time v1→v2 cutover. */
  on_cutover_stage?: (stage: 'legacy_crossed' | 'initial_anchored' | 'v2_anchored') => void;
}

export type PrepareTurnExecutionResult =
  | {
    kind: 'won';
    turn_id: string;
    assignment_id: string;
    run_id: string;
    nonce: string;
    contract_status: 'contracted' | 'legacy_uncontracted';
    execution_contract_ref?: ExecutionContractRef;
    capability_snapshot?: CapabilitySnapshot;
    attempt_epoch?: number;
    workspace_digest?: string;
    /** Authoritative physical workspace for this generation. */
    workspace_path: string;
  }
  | {
    kind: 'denied';
    reason: string;
    code: 'precondition' | 'authority_conflict' | 'repairable' | 'already_crossed';
    /** Whether this caller's claim owns durable attempt identity and must be retained. */
    authority_claimed: boolean;
    claim_disposition: 'release' | 'retain';
    turn_id?: string;
  };

function preconditionDenied(reason: string): PrepareTurnExecutionResult {
  return { kind: 'denied', reason, code: 'precondition', authority_claimed: false, claim_disposition: 'release' };
}

function authorityDenied(
  input: PrepareTurnExecutionInput,
  turnId: string,
  reason: string,
): PrepareTurnExecutionResult {
  const reservation = getReservation(turnId, input.cwd);
  const ownsAuthority = reservation?.claim_id === input.claim_id;
  const crossed = reservation?.launch?.status === 'crossed';
  return {
    kind: 'denied',
    reason,
    code: ownsAuthority ? (crossed ? 'already_crossed' : 'repairable') : 'authority_conflict',
    authority_claimed: ownsAuthority,
    claim_disposition: ownsAuthority ? 'retain' : 'release',
    turn_id: turnId,
  };
}

function defaultRequiredRole(kind: LoopKind, phase: string): 'execute' | 'review' | 'consult' {
  if (kind === 'review') return phase === 'author_response' ? 'execute' : 'review';
  if (kind === 'ideation') return 'review';
  if (kind === 'research') return 'consult';
  return 'execute';
}

/**
 * Common worker-attempt path. It refuses engine/manual phases and never advances
 * a phase or evaluates a gate; those decisions stay in the Loop Engine.
 * Because the persisted turn id intentionally remains `(loop, slot, iteration)`
 * for compatibility, a driver must use distinct role slots (or a new iteration)
 * when two worker phases would otherwise reuse the same slot.
 */
export function prepareTurnExecution(input: PrepareTurnExecutionInput): PrepareTurnExecutionResult {
  const loop = getLoop(input.loop_id, input.cwd);
  if (!loop) return preconditionDenied(`loop ${input.loop_id} not found`);
  if (loop.kind !== input.kind) return preconditionDenied(`loop kind mismatch: ${loop.kind} != ${input.kind}`);
  if (loop.status !== 'open') return preconditionDenied(`loop ${loop.id} is ${loop.status}, not open`);
  if (loop.current_phase !== input.phase) {
    return preconditionDenied(`phase mismatch: loop is '${loop.current_phase}', attempt requested '${input.phase}'`);
  }
  const execution = phasePolicy(input.kind, input.phase);
  if (!execution) return preconditionDenied(`unknown ${input.kind} phase '${input.phase}'`);
  if (execution.execution !== 'worker') {
    return preconditionDenied(`${input.kind}.${input.phase} is ${execution.execution}, not a worker phase`);
  }

  const iteration = loop.iteration_count;
  const turnId = deriveTurnId(loop.id, input.slot_id, iteration);
  const childIds = deriveChildIds(turnId);
  const existingReservation = getReservation(turnId, input.cwd);
  const slot = loop.slots.find((candidate) => candidate.slot_id === input.slot_id);
  if (!slot) return preconditionDenied(`slot ${input.slot_id} not found in loop ${loop.id}`);
  if (slot.agent !== undefined && slot.agent !== input.agent) {
    return preconditionDenied(`slot ${input.slot_id} belongs to agent '${slot.agent}', not '${input.agent}'`);
  }
  if (slot.agent_id !== undefined && slot.agent_id !== input.agent_id) {
    return preconditionDenied(`slot ${input.slot_id} belongs to agent_id '${slot.agent_id}', not '${input.agent_id ?? 'none'}'`);
  }
  if (slot.claim_id !== undefined && slot.claim_id !== input.claim_id) {
    return preconditionDenied(`slot ${input.slot_id} is bound to claim ${slot.claim_id}, not ${input.claim_id}`);
  }
  if (
    slot.current_turn_id !== undefined
    && slot.current_turn_id !== turnId
    && ['assigned', 'working', 'waiting_input'].includes(slot.status)
  ) {
    return preconditionDenied(`slot ${input.slot_id} has active turn ${slot.current_turn_id}, not ${turnId}`);
  }
  const claim = (() => {
    try { return loadClaim(input.claim_id, input.cwd); } catch { return undefined; }
  })();
  if (!claim) return preconditionDenied(`claim ${input.claim_id} not found`);
  if (claim.status !== 'active') return preconditionDenied(`claim ${input.claim_id} is ${claim.status}, not active`);
  if (claim.agent !== input.agent) {
    return preconditionDenied(`claim ${input.claim_id} belongs to agent '${claim.agent}', not '${input.agent}'`);
  }
  if (claim.scope !== input.scope) {
    return preconditionDenied(`claim ${input.claim_id} covers '${claim.scope}', not '${input.scope}'`);
  }
  if (claim.worktree_path && input.worktree_path && claim.worktree_path !== input.worktree_path) {
    return preconditionDenied(`claim ${input.claim_id} worktree does not match the dispatch worktree`);
  }
  const dispatchLeaseMs = input.dispatch_lease_ms ?? 30 * 60_000;
  const grantLeaseMs = input.grant_lease_ms ?? 10 * 60_000;
  const hasCompleteExistingContract = Boolean(
    existingReservation?.execution_contract
    && existingReservation.execution_contract_ref
    && existingReservation.capability_snapshot,
  );
  const hasPartialExistingContract = Boolean(existingReservation) && !hasCompleteExistingContract && Boolean(
    existingReservation?.execution_contract
    || existingReservation?.execution_contract_ref
    || existingReservation?.capability_snapshot,
  );
  if (hasPartialExistingContract) {
    return preconditionDenied('existing reservation has an incomplete execution-contract triplet');
  }
  const legacyUncontracted = Boolean(existingReservation) && !hasCompleteExistingContract;
  const capabilityRequirement = CapabilityRequirementSchema.parse(
    input.capability_requirement
    ?? existingReservation?.execution_contract?.capability_requirement
    ?? {
    roles: [defaultRequiredRole(input.kind, input.phase)],
    required_surfaces: ['cli_spawn'],
    // The transport requirement is CLI spawnability. Some integrations (for
    // example Cline) expose a spawnable CLI while their native interaction
    // surface remains an extension; callers can still constrain that native
    // surface explicitly through capability_requirement.execution_surfaces.
    execution_surfaces: [],
    model: input.model,
    required_tools: [],
  });
  if (
    input.capability_requirement
    && existingReservation?.execution_contract
    && JSON.stringify(capabilityRequirement) !== JSON.stringify(existingReservation.execution_contract.capability_requirement)
  ) {
    return preconditionDenied('capability requirement differs from the immutable existing execution contract');
  }
  let requestedHarnessBinding: HarnessCapabilityBinding;
  try {
    const resolved = input.harness_binding ?? resolveHarnessBinding(input.agent, input.model);
    requestedHarnessBinding = HarnessCapabilityBindingSchema.parse(resolved);
  } catch (error) {
    return preconditionDenied(error instanceof Error ? error.message : String(error));
  }
  const frozenHarnessBinding = existingReservation?.capability_snapshot?.resolved.harness;
  if (frozenHarnessBinding && JSON.stringify(frozenHarnessBinding) !== JSON.stringify(requestedHarnessBinding)) {
    return preconditionDenied(
      `harness binding differs from immutable capability snapshot: frozen `
      + `${frozenHarnessBinding.adapter_id}@${frozenHarnessBinding.adapter_version}, requested `
      + `${requestedHarnessBinding.adapter_id}@${requestedHarnessBinding.adapter_version}`,
    );
  }
  const capabilitySnapshot = existingReservation?.capability_snapshot
    ?? resolveCapabilitySnapshot(input.agent, capabilityRequirement, input.agent_id, requestedHarnessBinding);
  if (!capabilitySnapshot.accepted) {
    const reasons = capabilitySnapshot.reasons.map((reason) => reason.code).join(', ');
    return preconditionDenied(`capability requirements rejected for ${input.agent}: ${reasons}`);
  }
  const effectiveCompletionMode = existingReservation?.completion_mode ?? execution.completion_mode;
  const effectiveExpectedArtifacts = existingReservation?.expected_artifacts ?? execution.expected_artifacts;
  const contract = legacyUncontracted ? undefined : (existingReservation?.execution_contract ?? ExecutionContractSchema.parse({
    schema_version: 1,
    minimum_reader_version: 1,
    identity: {
      loop_id: loop.id,
      turn_id: turnId,
      logical_attempt_epoch: existingReservation?.epoch ?? 0,
      assignment_id: childIds.assignment_id,
      run_id: childIds.run_id,
      kind: input.kind,
      phase: input.phase,
      iteration,
    },
    artifact_contract: {
      completion_mode: effectiveCompletionMode,
      expected_artifacts: effectiveExpectedArtifacts,
    },
    capability_requirement: capabilityRequirement,
    workspace_policy: {
      scope: input.scope,
      cwd: input.cwd,
      worktree_path: input.worktree_path,
      isolation: input.workspace_policy?.isolation ?? (input.worktree_path ? 'worktree' : 'shared_checkout'),
      write_access: input.workspace_policy?.write_access ?? 'workspace',
    },
    timeout_policy: {
      dispatch_lease_ms: dispatchLeaseMs,
      grant_lease_ms: grantLeaseMs,
    },
    evidence_policy: {
      require_turn_id: true,
      require_run_id: true,
      require_nonce: true,
      artifact_hash: 'optional',
    },
    protocol: { name: 'attempt-authority', minimum_version: 1 },
  }));
  const contractRef = contract
    ? (existingReservation?.execution_contract_ref ?? executionContractRef(contract, capabilitySnapshot))
    : undefined;
  const v2 = resolveTurnGenerationChain(input.cwd, turnId);
  const activeRollout = resolveActiveAttemptRollout(input.cwd);
  const localHome = readLocalAuthorityHome(input.cwd);
  if (activeRollout && (!localHome || !contractRef)) {
    return preconditionDenied(
      !localHome
        ? 'AttemptAuthority v2 rollout is active but this store/device has no local authority_home'
        : 'AttemptAuthority v2 rollout is active but the turn has no immutable execution contract',
    );
  }
  // Crash-safe v1→v2 cutover repair. The legacy launch fence is crossed before
  // the immutable generation-zero cells are published. If the coordinator dies
  // in that narrow window, a replay must materialize/adopt the v2 anchor so the
  // turn can be fenced/taken over. It MUST NOT return spawn authority: the
  // pre-crash caller may have received the crossed grant, so only a successor
  // generation can safely recover liveness without a duplicate launch.
  if (
    activeRollout
    && localHome
    && contractRef
    && !v2
    && existingReservation?.decision === 'committed'
    && launchGrant(turnId, input.cwd)?.status === 'crossed'
  ) {
    try {
      bootstrapAttemptAuthorityV2({
        turn_id: turnId,
        authority_home: localHome,
        actor: input.dispatcher_agent_id ?? input.dispatcher_agent,
        writer_id: input.dispatcher_agent_id ?? input.dispatcher_agent,
        cwd: input.cwd,
        workspace_path: input.worktree_path ?? input.cwd,
        on_stage: (stage) => input.on_cutover_stage?.(
          stage === 'initial_anchored' ? 'initial_anchored' : 'v2_anchored'
        ),
      });
      return authorityDenied(
        input,
        turnId,
        'repaired v1→v2 cutover after a crossed legacy launch; spawn authority remains fenced — use takeover',
      );
    } catch (error) {
      return authorityDenied(input, turnId, error instanceof Error ? error.message : String(error));
    }
  }
  if (v2?.status === 'active' && v2.latest_generation.attempt_epoch === 0) {
    if (activeRollout && localHome && contractRef) {
      try {
        bootstrapAttemptAuthorityV2({
          turn_id: turnId,
          authority_home: localHome,
          actor: input.dispatcher_agent_id ?? input.dispatcher_agent,
          writer_id: input.dispatcher_agent_id ?? input.dispatcher_agent,
          cwd: input.cwd,
          workspace_path: v2.latest_generation.workspace_path,
        });
      } catch (error) {
        return authorityDenied(input, turnId, error instanceof Error ? error.message : String(error));
      }
    }
    return authorityDenied(input, turnId, 'generation zero launch is already crossed; use takeover for recovery');
  }
  if (input.accepted_execution_contract && !contractRef) {
    return preconditionDenied('legacy uncontracted reservation cannot claim worker contract acceptance');
  }
  if (input.accepted_execution_contract && contractRef && !(v2?.status === 'active' && v2.latest_generation.attempt_epoch > 0)) {
    const acceptance = validateWorkerContractAcceptance(contractRef, input.accepted_execution_contract, undefined);
    if (acceptance.kind !== 'accepted') {
      return preconditionDenied(
        `worker contract mismatch before crossing: expected ${contractRef.hash}/${contractRef.snapshot_hash}, accepted ${input.accepted_execution_contract.contract_hash}/${input.accepted_execution_contract.capability_snapshot_hash}; abort and reselect`,
      );
    }
  }

  // A takeover closes the old epoch and embeds a fresh active generation in
  // close(epoch). Re-entering the common worker path projects that generation
  // and contends on its immutable launch cell; the first caller wins spawn
  // authority, every replay is adopted and MUST NOT spawn.
  if (v2?.status === 'active' && v2.latest_generation.attempt_epoch > 0) {
    const reservation = existingReservation;
    if (!reservation || !localHome) {
      return authorityDenied(input, turnId, 'AttemptAuthority v2 authority_home is unavailable');
    }
    try {
      const generation = v2.latest_generation;
      const generationContract = executionContractForGeneration(reservation, generation);
      if (input.accepted_execution_contract) {
        const acceptance = validateWorkerContractAcceptance(
          generationContract.ref,
          input.accepted_execution_contract,
          undefined,
        );
        if (acceptance.kind !== 'accepted') {
          return preconditionDenied('worker rejected the active generation execution contract before crossing');
        }
      }
      ensureTurnExecutionProjections(reservation, {
        loop_id: loop.id,
        slot_id: input.slot_id,
        turn_id: turnId,
        assignment_id: generation.assignment_id,
        run_id: generation.run_id,
        agent: input.agent,
        agent_id: input.agent_id,
        dispatcher_agent: input.dispatcher_agent,
        dispatcher_agent_id: input.dispatcher_agent_id,
        dispatcher_session_id: input.dispatcher_session_id,
        scope: input.scope,
        description: input.description,
        task: input.task,
        worktree_path: generation.workspace_path,
        assignment_tags: input.assignment_tags,
        run_tags: [...(input.run_tags ?? ['turn-owned', 'loop']), `attempt-generation:${generation.attempt_epoch}`],
        attempt_index: generation.attempt_epoch + 1,
        execution_contract_ref: generationContract.ref,
        capability_snapshot: reservation.capability_snapshot,
        on_projection: input.on_projection,
      }, input.cwd);
      const crossing = crossActiveAttemptGenerationV2(
        turnId,
        generation.attempt_epoch,
        localHome,
        input.dispatcher_agent_id ?? input.dispatcher_agent,
        input.dispatcher_agent_id ?? input.dispatcher_agent,
        input.cwd,
      );
      if (!crossing.won) return authorityDenied(input, turnId, 'attempt generation launch already crossed');
      return {
        kind: 'won',
        turn_id: turnId,
        assignment_id: generation.assignment_id,
        run_id: generation.run_id,
        nonce: generation.launch_nonce,
        attempt_epoch: generation.attempt_epoch,
        workspace_digest: generation.workspace_digest,
        workspace_path: generation.workspace_path,
        contract_status: 'contracted',
        execution_contract_ref: generationContract.ref,
        capability_snapshot: reservation.capability_snapshot,
      };
    } catch (error) {
      return authorityDenied(input, turnId, error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const now = Date.now();
    const prepared = prepareAttempt({
      turn_id: turnId,
      loop_id: loop.id,
      slot_id: input.slot_id,
      target_slot_generation: iteration,
      loop_version_at_reserve: loop.version,
      agent: input.agent,
      agent_id: input.agent_id,
      claim_id: input.claim_id,
      phase: input.phase,
      iteration,
      completion_mode: effectiveCompletionMode,
      expected_artifacts: effectiveExpectedArtifacts,
      execution_contract: contract,
      execution_contract_ref: contractRef,
      capability_snapshot: contractRef ? capabilitySnapshot : undefined,
      store_root: input.cwd,
      cwd: input.cwd,
      lease_deadline: new Date(now + dispatchLeaseMs).toISOString(),
      grant_lease_deadline: new Date(now + grantLeaseMs).toISOString(),
      authority_actor: input.dispatcher_agent_id ?? input.dispatcher_agent,
      on_stage: input.on_authority_stage,
    }, input.cwd);
    if (prepared.launch_status !== 'armed') {
      return authorityDenied(input, turnId, `launch grant is ${prepared.launch_status}`);
    }
    const crossing = projectAndCross(prepared, (reservation) => ensureTurnExecutionProjections(reservation, {
      loop_id: loop.id,
      slot_id: input.slot_id,
      turn_id: turnId,
      assignment_id: childIds.assignment_id,
      run_id: childIds.run_id,
      agent: input.agent,
      agent_id: input.agent_id,
      dispatcher_agent: input.dispatcher_agent,
      dispatcher_agent_id: input.dispatcher_agent_id,
      dispatcher_session_id: input.dispatcher_session_id,
      scope: input.scope,
      description: input.description,
      task: input.task,
      worktree_path: input.worktree_path,
      assignment_tags: input.assignment_tags,
      run_tags: input.run_tags,
      on_projection: input.on_projection,
    }, input.cwd), input.cwd, input.dispatcher_agent_id ?? input.dispatcher_agent);
    if (crossing.kind !== 'won') return authorityDenied(input, turnId, 'launch grant already crossed');
    input.on_cutover_stage?.('legacy_crossed');
    let generationFence: { attempt_epoch?: number; workspace_digest?: string } = {};
    if (activeRollout && localHome && contractRef) {
      const generation = bootstrapAttemptAuthorityV2({
        turn_id: turnId,
        authority_home: localHome,
        actor: input.dispatcher_agent_id ?? input.dispatcher_agent,
        writer_id: input.dispatcher_agent_id ?? input.dispatcher_agent,
        cwd: input.cwd,
        workspace_path: input.worktree_path ?? input.cwd,
        on_stage: (stage) => input.on_cutover_stage?.(
          stage === 'initial_anchored' ? 'initial_anchored' : 'v2_anchored'
        ),
      });
      generationFence = {
        attempt_epoch: generation.attempt_epoch,
        workspace_digest: generation.workspace_digest,
      };
    }
    return {
      kind: 'won',
      turn_id: turnId,
      assignment_id: childIds.assignment_id,
      run_id: childIds.run_id,
      nonce: prepared.token,
      contract_status: contractRef ? 'contracted' : 'legacy_uncontracted',
      execution_contract_ref: contractRef,
      capability_snapshot: contractRef ? capabilitySnapshot : undefined,
      workspace_path: input.worktree_path ?? input.cwd,
      ...generationFence,
    };
  } catch (error) {
    return authorityDenied(input, turnId, error instanceof Error ? error.message : String(error));
  }
}
