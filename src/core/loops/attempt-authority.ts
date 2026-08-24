/**
 * Functional authority boundary for one physical loop-turn attempt.
 *
 * This facade deliberately stores nothing of its own. TurnReservation remains
 * the canonical record and the Loop Engine remains responsible for phases,
 * gates, retries and convergence. The only decision made here is whether one
 * caller won the irreversible launch crossing.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  ExecutionContractSchema,
  executionContractRef,
  type ExecutionContract,
  type ExecutionContractRef,
} from '../execution-contract.js';
import {
  abortReservation,
  armLaunch,
  attemptStatus,
  commitReservation,
  consumeLaunchGrantWithProjection,
  currentNonce,
  evidenceMatchesAttempt,
  getReservation,
  launchGrant,
  reserve,
  revokeLaunchGrant,
  LaunchFenceError,
  ReservationStateError,
  type AttemptStatus,
  type ReserveInput,
  type TurnReservation,
} from './attempt-reservation.js';
import {
  AttemptGenerationError,
  fenceForGeneration,
  generationDigest,
  prepareCloseDecision,
  prepareInitialGeneration,
  prepareLaunchDecision,
  prepareNextGeneration,
  publishInitialGeneration,
  publishAttemptResultEvidence,
  publishPreparedCloseDecision,
  publishPreparedLaunchDecision,
  readCloseDecision,
  readInitialGeneration,
  readAttemptResultEvidence,
  readLaunchDecision,
  rebuildAttemptGenerationHead,
  listAttemptGenerations,
  resolveTurnGenerationChain,
  type AttemptGeneration,
  type AttemptResultEvidenceCell,
  type CloseDecisionCell,
  type GenerationFence,
} from './attempt-generations.js';
import {
  assertAttemptAuthorityV2Writable,
  type ActiveAttemptRollout,
} from './attempt-rollout.js';

export interface PrepareAttemptInput extends ReserveInput {
  /** Lease for the current launch generation; distinct from the reservation lease. */
  grant_lease_deadline: string;
  /** Identity recorded on reservation-lock operations. */
  authority_actor?: string;
  /** Deterministic test/observability seam; must not mutate loop business state. */
  on_stage?: (stage: 'reserved' | 'committed' | 'armed') => void;
}

export interface PreparedAttempt {
  turn_id: string;
  reservation: TurnReservation;
  token: string;
  epoch: number;
  adopted: boolean;
  launch_status: 'armed' | 'crossed';
}

export interface AttemptSnapshot {
  reservation: TurnReservation;
  status: AttemptStatus;
  nonce?: string;
}

export type AttemptCrossResult =
  | { kind: 'won'; reservation: TurnReservation; turn_id: string; token: string; epoch: number }
  | { kind: 'adopted'; reservation: TurnReservation; turn_id: string; token: string; epoch: number };

function sameExpectedArtifacts(a: TurnReservation['expected_artifacts'], b: ReserveInput['expected_artifacts']): boolean {
  const canonical = (items: TurnReservation['expected_artifacts']): string => JSON.stringify(items.map((item) => ({
    logical_name: item.logical_name,
    worker_path: item.worker_path,
    loop_artifact_type: item.loop_artifact_type,
    schema_id: item.schema_id,
    completion_policy: item.completion_policy,
    sha256: item.sha256,
  })));
  return canonical(a) === canonical(b ?? []);
}

function assertCompatible(existing: TurnReservation, input: PrepareAttemptInput): void {
  const mismatch = [
    existing.loop_id !== input.loop_id && 'loop_id',
    existing.slot_id !== input.slot_id && 'slot_id',
    existing.target_slot_generation !== input.target_slot_generation && 'target_slot_generation',
    existing.agent !== input.agent && 'agent',
    existing.agent_id !== input.agent_id && 'agent_id',
    existing.claim_id !== input.claim_id && 'claim_id',
    existing.phase !== input.phase && 'phase',
    existing.iteration !== input.iteration && 'iteration',
    existing.completion_mode !== (input.completion_mode ?? 'file') && 'completion_mode',
    !sameExpectedArtifacts(existing.expected_artifacts, input.expected_artifacts) && 'expected_artifacts',
    existing.execution_contract_ref !== undefined
      && input.execution_contract_ref !== undefined
      && JSON.stringify(existing.execution_contract_ref) !== JSON.stringify(input.execution_contract_ref)
      && 'execution_contract_ref',
    existing.capability_snapshot !== undefined
      && input.capability_snapshot !== undefined
      && JSON.stringify(existing.capability_snapshot) !== JSON.stringify(input.capability_snapshot)
      && 'capability_snapshot',
  ].find(Boolean);
  if (mismatch) {
    throw new ReservationStateError(
      input.turn_id,
      'reservation_exists',
      `prepareAttempt: existing reservation ${input.turn_id} has incompatible ${mismatch}`,
    );
  }
}

/**
 * Reserve-or-adopt, commit and arm one attempt generation.
 *
 * Adoption is allowed only for an identical immutable contract. A crossed
 * generation is returned as adopted so callers can repair/read projections,
 * but projectAndCross will never award launch authority twice.
 */
export function prepareAttempt(input: PrepareAttemptInput, cwd?: string): PreparedAttempt {
  const actor = input.authority_actor ?? input.agent_id ?? input.agent;
  let adopted = false;
  try {
    reserve(input, cwd);
  } catch (error) {
    const existing = getReservation(input.turn_id, cwd);
    if (!(error instanceof ReservationStateError) || error.code !== 'reservation_exists' || !existing) {
      throw error;
    }
    assertCompatible(existing, input);
    adopted = true;
  }
  input.on_stage?.('reserved');

  const committed = commitReservation(input.turn_id, cwd, actor);
  input.on_stage?.('committed');
  let grant = launchGrant(input.turn_id, cwd);
  if (!grant || grant.status === 'revoked') {
    const nextEpoch = (grant?.epoch ?? -1) + 1;
    try {
      armLaunch(input.turn_id, {
        epoch: nextEpoch,
        lease_deadline: input.grant_lease_deadline,
      }, cwd, actor);
    } catch (error) {
      // A concurrent preparer may have armed the same committed reservation.
      if (!(error instanceof LaunchFenceError) || error.code !== 'already_armed') throw error;
      adopted = true;
    }
    grant = launchGrant(input.turn_id, cwd);
  }
  input.on_stage?.('armed');

  if (!grant || (grant.status !== 'armed' && grant.status !== 'crossed')) {
    throw new LaunchFenceError(
      input.turn_id,
      grant?.status === 'revoked' ? 'revoked' : 'not_armed',
      `prepareAttempt: launch generation for ${input.turn_id} is ${grant?.status ?? 'absent'}`,
    );
  }

  return {
    turn_id: input.turn_id,
    reservation: { ...committed, launch: grant },
    token: grant.token,
    epoch: grant.epoch,
    adopted: adopted || grant.status === 'crossed',
    launch_status: grant.status,
  };
}

/** Materialize deterministic projections and atomically cross the launch fence. */
export function projectAndCross(
  prepared: PreparedAttempt,
  projectProjections: (reservation: TurnReservation) => void,
  cwd?: string,
  authorityActor = 'attempt-authority',
): AttemptCrossResult {
  const crossed = consumeLaunchGrantWithProjection(
    prepared.turn_id,
    prepared.token,
    prepared.epoch,
    projectProjections,
    cwd,
    authorityActor,
  );
  return {
    kind: crossed.wonTransition ? 'won' : 'adopted',
    reservation: crossed.reservation,
    turn_id: prepared.turn_id,
    token: prepared.token,
    epoch: prepared.epoch,
  };
}

export function inspectAttempt(turnId: string, cwd?: string, runStatus?: string): AttemptSnapshot | undefined {
  const reservation = getReservation(turnId, cwd);
  if (!reservation) return undefined;
  return {
    reservation,
    status: attemptStatus(reservation, runStatus),
    nonce: currentNonce(reservation),
  };
}

export function matchEvidence(
  attempt: TurnReservation | AttemptSnapshot | PreparedAttempt,
  evidence: { turn_id?: string; run_id?: string; nonce?: string },
): boolean {
  const reservation = 'reservation' in attempt ? attempt.reservation : attempt;
  return evidenceMatchesAttempt(reservation, evidence);
}

/**
 * Revoke a not-yet-crossed launch generation. A merely prepared reservation is
 * aborted; a committed-but-unarmed reservation is left repairable by design.
 */
export function revokeAttempt(turnId: string, reason: string, cwd?: string, actor = 'attempt-authority'): AttemptSnapshot {
  const reservation = getReservation(turnId, cwd);
  if (!reservation) {
    throw new ReservationStateError(turnId, 'reservation_not_found', `revokeAttempt: unknown turn_id ${turnId}`);
  }
  let next = reservation;
  if (reservation.decision === 'prepared') {
    next = abortReservation(turnId, reason, cwd, actor);
  } else if (reservation.launch?.status === 'armed') {
    next = revokeLaunchGrant(turnId, reservation.launch.epoch, reason, cwd, actor);
  } else if (reservation.launch?.status === 'crossed') {
    throw new LaunchFenceError(turnId, 'crossed_not_revocable', `revokeAttempt: ${turnId} already crossed`);
  } else if (!reservation.launch) {
    throw new LaunchFenceError(turnId, 'not_armed', `revokeAttempt: ${turnId} has no launch generation`);
  }
  return { reservation: next, status: attemptStatus(next), nonce: currentNonce(next) };
}

/** Explicit prepared→aborted helper for recovery code that knows no commit occurred. */
export function abortAttempt(turnId: string, reason: string, cwd?: string, actor = 'attempt-authority'): AttemptSnapshot {
  const reservation = abortReservation(turnId, reason, cwd, actor);
  return { reservation, status: attemptStatus(reservation), nonce: currentNonce(reservation) };
}

/* ======================= AttemptAuthority v2 ============================ */

export function attemptWorkspaceDigest(workspacePath: string, turnId: string, attemptEpoch: number): string {
  let resolved: string;
  try { resolved = fs.realpathSync.native(workspacePath); } catch { resolved = path.resolve(workspacePath); }
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return crypto.createHash('sha256')
    .update(`${resolved}\0${turnId}\0${attemptEpoch}`, 'utf8')
    .digest('hex');
}

function canonicalWorkspacePath(workspacePath: string): string {
  let resolved: string;
  try { resolved = fs.realpathSync.native(workspacePath); } catch { resolved = path.resolve(workspacePath); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function gitWorkspaceIdentity(workspacePath: string): { git_dir: string; common_dir: string; top_level: string } {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    { cwd: workspacePath, encoding: 'utf8', windowsHide: true },
  );
  const lines = result.status === 0 ? (result.stdout ?? '').trim().split(/\r?\n/) : [];
  if (lines.length < 3) {
    throw new AttemptGenerationError('invalid_transition', `workspace is not an attestable Git worktree: ${workspacePath}`);
  }
  return {
    git_dir: canonicalWorkspacePath(lines[0]!),
    common_dir: canonicalWorkspacePath(lines[1]!),
    top_level: canonicalWorkspacePath(lines[2]!),
  };
}

export function executionContractForGeneration(
  reservation: TurnReservation,
  generation: AttemptGeneration,
): { contract: ExecutionContract; ref: ExecutionContractRef } {
  if (!reservation.execution_contract || !reservation.capability_snapshot) {
    throw new AttemptGenerationError('invalid_transition', `turn ${reservation.turn_id} has no immutable execution contract`);
  }
  // Generation zero anchors the already-crossed immutable reservation. Keep
  // its original serialized contract: on Windows the generation cell stores a
  // canonicalized (case-folded) workspace path, and rebuilding the contract
  // from that path changes its hash even though it names the same checkout.
  // Successor generations still derive a new contract below because their
  // epoch, run id, and workspace are intentionally different.
  if (generation.attempt_epoch === 0) {
    const contract = reservation.execution_contract;
    if (
      contract.identity.assignment_id !== generation.assignment_id
      || contract.identity.run_id !== generation.run_id
      || canonicalWorkspacePath(contract.workspace_policy.worktree_path ?? contract.workspace_policy.cwd)
        !== canonicalWorkspacePath(generation.workspace_path)
    ) {
      throw new AttemptGenerationError('fenced', 'generation zero diverges from its immutable reservation contract');
    }
    const ref = executionContractRef(contract, reservation.capability_snapshot);
    if (ref.hash !== generation.contract_hash) {
      throw new AttemptGenerationError(
        'fenced',
        `generation zero contract hash ${generation.contract_hash} does not match reservation ${ref.hash}`,
      );
    }
    return { contract, ref };
  }
  const contract = ExecutionContractSchema.parse({
    ...reservation.execution_contract,
    identity: {
      ...reservation.execution_contract.identity,
      logical_attempt_epoch: generation.attempt_epoch,
      assignment_id: generation.assignment_id,
      run_id: generation.run_id,
    },
    workspace_policy: {
      ...reservation.execution_contract.workspace_policy,
      cwd: generation.workspace_path,
      worktree_path: generation.workspace_path,
      isolation: 'worktree',
    },
  });
  const ref = executionContractRef(contract, reservation.capability_snapshot);
  if (ref.hash !== generation.contract_hash) {
    throw new AttemptGenerationError(
      'fenced',
      `generation ${generation.attempt_epoch} contract hash ${generation.contract_hash} does not match derived ${ref.hash}`,
    );
  }
  return { contract, ref };
}

export interface BootstrapAttemptAuthorityV2Input {
  turn_id: string;
  authority_home: import('./attempt-generations.js').AuthorityHome;
  actor: string;
  writer_id: string;
  cwd: string;
  workspace_path?: string;
  /** Fault-injection/telemetry seam; immutable publishes remain authoritative. */
  on_stage?: (stage: 'initial_anchored' | 'launch_crossed') => void;
}

/**
 * Anchor a crossed legacy generation into the v2 immutable chain. This is an
 * explicit Release-B write and therefore refuses unless the signed writer
 * guard is active on the local authority home.
 */
export function bootstrapAttemptAuthorityV2(input: BootstrapAttemptAuthorityV2Input): AttemptGeneration {
  assertAttemptAuthorityV2Writable(input.cwd, input.authority_home, undefined, input.writer_id);
  const reservation = getReservation(input.turn_id, input.cwd);
  if (!reservation || reservation.decision !== 'committed') {
    throw new AttemptGenerationError('invalid_transition', `turn ${input.turn_id} is not a committed reservation`);
  }
  const grant = launchGrant(input.turn_id, input.cwd);
  if (!grant || grant.status !== 'crossed') {
    throw new AttemptGenerationError('invalid_transition', `turn ${input.turn_id} is not a crossed generation`);
  }
  if (!reservation.execution_contract_ref) {
    throw new AttemptGenerationError('invalid_transition', `turn ${input.turn_id} is legacy-uncontracted and cannot enter v2`);
  }
  const workspacePath = path.resolve(
    input.workspace_path
    ?? reservation.execution_contract?.workspace_policy.worktree_path
    ?? reservation.cwd,
  );
  const existingAnchor = readInitialGeneration(input.cwd, input.turn_id);
  const initial = existingAnchor ?? prepareInitialGeneration({
      turn_id: reservation.turn_id,
      authority_home: input.authority_home,
      contract_hash: reservation.execution_contract_ref.hash,
      workspace_path: workspacePath,
      workspace_digest: attemptWorkspaceDigest(workspacePath, reservation.turn_id, 0),
      launch_nonce: grant.token,
    });
  if (
    initial.assignment_id !== reservation.child_ids.assignment_id
    || initial.run_id !== reservation.child_ids.run_id
    || initial.launch_nonce !== grant.token
    || initial.contract_hash !== reservation.execution_contract_ref.hash
    || canonicalWorkspacePath(initial.workspace_path) !== canonicalWorkspacePath(workspacePath)
    || initial.workspace_digest !== attemptWorkspaceDigest(workspacePath, reservation.turn_id, 0)
    || JSON.stringify(initial.authority_home) !== JSON.stringify(input.authority_home)
  ) {
    throw new AttemptGenerationError('invalid_transition', 'generation-zero anchor diverges from the existing reservation');
  }
  const anchored = publishInitialGeneration(input.cwd, initial).cell;
  input.on_stage?.('initial_anchored');
  const launch = prepareLaunchDecision(anchored, {
    decision: 'crossed',
    actor: input.actor,
    cause: 'release-b bootstrap of already-crossed generation',
  });
  const publishedLaunch = publishPreparedLaunchDecision(input.cwd, anchored, launch).cell;
  if (publishedLaunch.decision !== 'crossed') {
    throw new AttemptGenerationError('fenced', `generation zero was already revoked for ${input.turn_id}`);
  }
  input.on_stage?.('launch_crossed');
  rebuildAttemptGenerationHead(input.cwd, anchored);
  return anchored;
}

export type AttemptExternalEffectPolicy = 'none' | 'idempotent' | 'externally_fenced';

export interface PrepareAttemptTakeoverV2Input {
  turn_id: string;
  expected_epoch: number;
  authority_home: import('./attempt-generations.js').AuthorityHome;
  actor: string;
  writer_id: string;
  cause: string;
  liveness_evidence: string;
  external_effect_policy: AttemptExternalEffectPolicy;
  next_workspace_path: string;
  mode?: 'takeover' | 'retry';
  cwd: string;
}

export interface PrepareAttemptTakeoverV2Result {
  won: boolean;
  rollout: ActiveAttemptRollout;
  previous_generation: AttemptGeneration;
  next_generation: AttemptGeneration;
  close_cell: CloseDecisionCell;
  execution_contract: ExecutionContract;
  execution_contract_ref: ExecutionContractRef;
}

/**
 * Close the active epoch and activate its successor with ONE close(epoch) CAS.
 * No projection is authoritative: callers may replay AgentRun/head/event
 * materialization after this function returns.
 */
export function prepareAttemptTakeoverV2(input: PrepareAttemptTakeoverV2Input): PrepareAttemptTakeoverV2Result {
  const rollout = assertAttemptAuthorityV2Writable(input.cwd, input.authority_home, undefined, input.writer_id);
  if (input.external_effect_policy !== 'none'
    && input.external_effect_policy !== 'idempotent'
    && input.external_effect_policy !== 'externally_fenced') {
    throw new AttemptGenerationError('invalid_transition', 'automatic takeover requires idempotent or externally fenced effects');
  }
  if (!input.cause.trim() || !input.liveness_evidence.trim()) {
    throw new AttemptGenerationError('invalid_transition', 'takeover requires a cause and liveness evidence');
  }
  const reservation = getReservation(input.turn_id, input.cwd);
  const resolved = resolveTurnGenerationChain(input.cwd, input.turn_id);
  if (!reservation || !resolved) {
    throw new AttemptGenerationError('invalid_transition', `turn ${input.turn_id} has no active v2 generation`);
  }
  const requestedCause = `${input.cause}; liveness=${input.liveness_evidence}; effects=${input.external_effect_policy}`;
  // Crash replay: close(epoch) may have won before the LoopEvent/AgentRun/head
  // projections were written. Adopt that exact immutable successor so the
  // caller can repair projections; never mint another generation on replay.
  if (resolved.latest_generation.attempt_epoch > input.expected_epoch) {
    const initial = readInitialGeneration(input.cwd, input.turn_id);
    const previous = initial
      ? listAttemptGenerations(input.cwd, initial).find((generation) => generation.attempt_epoch === input.expected_epoch)
      : undefined;
    const close = previous ? readCloseDecision(input.cwd, input.turn_id, input.expected_epoch) : undefined;
    const expectedMode = input.mode ?? 'takeover';
    if (
      previous
      && close
      && (close.decision === 'takeover' || close.decision === 'retry')
      && close.decision === expectedMode
      && close.cause === requestedCause
      && canonicalWorkspacePath(close.next_generation.workspace_path) === canonicalWorkspacePath(input.next_workspace_path)
      && JSON.stringify(close.next_generation.authority_home) === JSON.stringify(input.authority_home)
    ) {
      const generationContract = executionContractForGeneration(reservation, close.next_generation);
      return {
        won: false,
        rollout,
        previous_generation: previous,
        next_generation: close.next_generation,
        close_cell: close,
        execution_contract: generationContract.contract,
        execution_contract_ref: generationContract.ref,
      };
    }
    throw new AttemptGenerationError('fenced', `expected epoch ${input.expected_epoch}, active epoch is ${resolved.latest_generation.attempt_epoch}`);
  }
  if (resolved.status !== 'active') {
    throw new AttemptGenerationError('invalid_transition', `turn ${input.turn_id} has no active v2 generation`);
  }
  const current = resolved.latest_generation;
  if (current.attempt_epoch !== input.expected_epoch) {
    throw new AttemptGenerationError('fenced', `expected epoch ${input.expected_epoch}, active epoch is ${current.attempt_epoch}`);
  }
  if (JSON.stringify(current.authority_home) !== JSON.stringify(input.authority_home)) {
    throw new AttemptGenerationError('authority_home_mismatch', 'takeover caller is not authority_home');
  }
  const currentLaunch = readLaunchDecision(input.cwd, input.turn_id, current.attempt_epoch);
  if (!currentLaunch || currentLaunch.decision !== 'crossed') {
    throw new AttemptGenerationError('invalid_transition', `generation ${current.attempt_epoch} never crossed`);
  }
  const nextEpoch = current.attempt_epoch + 1;
  const nextWorkspacePath = path.resolve(input.next_workspace_path);
  if (canonicalWorkspacePath(nextWorkspacePath) === canonicalWorkspacePath(current.workspace_path)) {
    throw new AttemptGenerationError('invalid_transition', 'next generation workspace resolves to the current workspace (alias/junction reuse refused)');
  }
  const currentWorkspace = gitWorkspaceIdentity(current.workspace_path);
  const nextWorkspace = gitWorkspaceIdentity(nextWorkspacePath);
  if (currentWorkspace.common_dir !== nextWorkspace.common_dir) {
    throw new AttemptGenerationError('invalid_transition', 'next generation workspace is not a worktree of the same Git repository');
  }
  if (currentWorkspace.git_dir === nextWorkspace.git_dir || currentWorkspace.top_level === nextWorkspace.top_level) {
    throw new AttemptGenerationError('invalid_transition', 'next generation must use a distinct Git worktree/gitdir');
  }
  const provisional = prepareNextGeneration(current, {
    contract_hash: '0'.repeat(64),
    workspace_path: nextWorkspacePath,
    workspace_digest: attemptWorkspaceDigest(nextWorkspacePath, input.turn_id, nextEpoch),
  });
  const baseContract = reservation.execution_contract;
  const snapshot = reservation.capability_snapshot;
  if (!baseContract || !snapshot) {
    throw new AttemptGenerationError('invalid_transition', `turn ${input.turn_id} lacks a contracted capability snapshot`);
  }
  const nextContract = ExecutionContractSchema.parse({
    ...baseContract,
    identity: {
      ...baseContract.identity,
      logical_attempt_epoch: nextEpoch,
      assignment_id: provisional.assignment_id,
      run_id: provisional.run_id,
    },
    workspace_policy: {
      ...baseContract.workspace_policy,
      cwd: nextWorkspacePath,
      worktree_path: nextWorkspacePath,
      isolation: 'worktree',
    },
  });
  const nextRef = executionContractRef(nextContract, snapshot);
  const next = prepareNextGeneration(current, {
    contract_hash: nextRef.hash,
    workspace_path: nextWorkspacePath,
    workspace_digest: attemptWorkspaceDigest(nextWorkspacePath, input.turn_id, nextEpoch),
    launch_nonce: provisional.launch_nonce,
    created_at: provisional.created_at,
  });
  const proposed = prepareCloseDecision(current, {
    decision: input.mode ?? 'takeover',
    actor: input.actor,
    cause: requestedCause,
    next_generation: next,
  });
  const published = publishPreparedCloseDecision(input.cwd, current, proposed);
  const incumbent = published.cell;
  if (incumbent.decision !== 'takeover' && incumbent.decision !== 'retry') {
    throw new AttemptGenerationError('fenced', `generation ${current.attempt_epoch} already closed as ${incumbent.decision}`);
  }
  if (generationDigest(incumbent.next_generation) !== generationDigest(next)) {
    throw new AttemptGenerationError('fenced', `a different successor already won generation ${current.attempt_epoch}`);
  }
  rebuildAttemptGenerationHead(input.cwd, current);
  return {
    won: published.won,
    rollout,
    previous_generation: current,
    next_generation: incumbent.next_generation,
    close_cell: incumbent,
    execution_contract: nextContract,
    execution_contract_ref: nextRef,
  };
}

export interface CrossAttemptGenerationV2Result {
  won: boolean;
  generation: AttemptGeneration;
  fence: GenerationFence;
}

export function crossActiveAttemptGenerationV2(
  turnId: string,
  expectedEpoch: number,
  authorityHome: import('./attempt-generations.js').AuthorityHome,
  actor: string,
  writerId: string,
  cwd: string,
): CrossAttemptGenerationV2Result {
  assertAttemptAuthorityV2Writable(cwd, authorityHome, undefined, writerId);
  const resolved = resolveTurnGenerationChain(cwd, turnId);
  if (!resolved || resolved.status !== 'active' || resolved.latest_generation.attempt_epoch !== expectedEpoch) {
    throw new AttemptGenerationError('fenced', `turn ${turnId} epoch ${expectedEpoch} is not active`);
  }
  const generation = resolved.latest_generation;
  if (JSON.stringify(generation.authority_home) !== JSON.stringify(authorityHome)) {
    throw new AttemptGenerationError('authority_home_mismatch', 'cross caller is not authority_home');
  }
  const published = publishPreparedLaunchDecision(cwd, generation, prepareLaunchDecision(generation, {
    decision: 'crossed', actor, cause: 'projection-complete launch crossing',
  }));
  if (published.cell.decision !== 'crossed') {
    throw new AttemptGenerationError('fenced', `generation ${expectedEpoch} was revoked before crossing`);
  }
  return { won: published.won, generation, fence: fenceForGeneration(generation) };
}

export function settleActiveAttemptGenerationV2(
  turnId: string,
  expectedFence: GenerationFence,
  result: Record<string, unknown>,
  authorityHome: import('./attempt-generations.js').AuthorityHome,
  actor: string,
  writerId: string,
  cwd: string,
): { won: boolean; cell: CloseDecisionCell; evidence: AttemptResultEvidenceCell } | undefined {
  assertAttemptAuthorityV2Writable(cwd, authorityHome, undefined, writerId);
  const resolved = resolveTurnGenerationChain(cwd, turnId);
  if (!resolved) return undefined;
  if (resolved.status !== 'active') {
    const terminal = resolved.terminal_cell;
    if (!terminal || terminal.decision !== 'settled' || !terminal.result_digest) return undefined;
    if (JSON.stringify(terminal.fence) !== JSON.stringify(expectedFence)) {
      throw new AttemptGenerationError('fenced', `settled generation fence does not match ${turnId}`);
    }
    const evidence = readAttemptResultEvidence(cwd, turnId, terminal.fence.attempt_epoch, terminal.result_digest);
    if (!evidence) throw new AttemptGenerationError('fenced', `settled evidence ${terminal.result_digest} is missing`);
    return { won: false, cell: terminal, evidence };
  }
  const generation = resolved.latest_generation;
  if (JSON.stringify(fenceForGeneration(generation)) !== JSON.stringify(expectedFence)) {
    throw new AttemptGenerationError('fenced', 'settlement fence no longer matches the active generation');
  }
  if (JSON.stringify(generation.authority_home) !== JSON.stringify(authorityHome)) {
    throw new AttemptGenerationError('authority_home_mismatch', 'settlement caller is not authority_home');
  }
  const launch = readLaunchDecision(cwd, turnId, generation.attempt_epoch);
  if (!launch || launch.decision !== 'crossed') {
    throw new AttemptGenerationError('invalid_transition', `generation ${generation.attempt_epoch} never crossed`);
  }
  const publishedEvidence = publishAttemptResultEvidence(cwd, generation, result);
  const proposed = prepareCloseDecision(generation, {
    decision: 'settled', actor, cause: 'turn evidence accepted', result_digest: publishedEvidence.digest,
  });
  const published = publishPreparedCloseDecision(cwd, generation, proposed);
  if (published.cell.decision !== 'settled') {
    return { ...published, evidence: publishedEvidence.cell };
  }
  if (published.cell.result_digest !== publishedEvidence.digest) {
    throw new AttemptGenerationError('fenced', `generation ${generation.attempt_epoch} already settled with different evidence`);
  }
  const authoritativeEvidence = readAttemptResultEvidence(
    cwd,
    turnId,
    generation.attempt_epoch,
    published.cell.result_digest,
  );
  if (!authoritativeEvidence) throw new AttemptGenerationError('fenced', 'authoritative settlement evidence is missing');
  rebuildAttemptGenerationHead(cwd, generation);
  return { ...published, evidence: authoritativeEvidence };
}
