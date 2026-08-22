/** Common projections-before-crossing contract for every worker-backed LoopKind phase. */
import { ensureAgentRunProjection } from '../agentruns.js';
import { ensureAssignmentProjection } from '../assignments.js';
import { ensureClaimAssignmentBinding, loadClaim } from '../claims.js';
import { bindTurnProjection } from './verbs.js';
import { deriveChildIds, deriveTurnId, getReservation, type TurnReservation } from './attempt-reservation.js';
import { prepareAttempt, projectAndCross } from './attempt-authority.js';
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
    tags: input.assignment_tags ?? ['coordinate', 'loop', 'turn-owned'],
  }, cwd);
  input.on_projection?.('assignment');

  ensureAgentRunProjection({
    id: input.run_id,
    short_label: input.run_id,
    assignment_id: input.assignment_id,
    claim_id: reservation.claim_id,
    attempt_index: 1,
    agent: input.agent,
    agent_id: input.agent_id,
    transport: 'cli_spawn',
    status: 'created',
    scope: input.scope,
    description: input.description,
    worktree_path: input.worktree_path,
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
  on_authority_stage?: (stage: 'reserved' | 'committed' | 'armed') => void;
  on_projection?: (stage: TurnProjectionStage) => void;
}

export type PrepareTurnExecutionResult =
  | { kind: 'won'; turn_id: string; assignment_id: string; run_id: string; nonce: string }
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
      completion_mode: execution.completion_mode,
      expected_artifacts: execution.expected_artifacts,
      store_root: input.cwd,
      cwd: input.cwd,
      lease_deadline: new Date(now + (input.dispatch_lease_ms ?? 30 * 60_000)).toISOString(),
      grant_lease_deadline: new Date(now + (input.grant_lease_ms ?? 10 * 60_000)).toISOString(),
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
    return {
      kind: 'won',
      turn_id: turnId,
      assignment_id: childIds.assignment_id,
      run_id: childIds.run_id,
      nonce: prepared.token,
    };
  } catch (error) {
    return authorityDenied(input, turnId, error instanceof Error ? error.message : String(error));
  }
}
