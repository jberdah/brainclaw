/**
 * Functional authority boundary for one physical loop-turn attempt.
 *
 * This facade deliberately stores nothing of its own. TurnReservation remains
 * the canonical record and the Loop Engine remains responsible for phases,
 * gates, retries and convergence. The only decision made here is whether one
 * caller won the irreversible launch crossing.
 */
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
