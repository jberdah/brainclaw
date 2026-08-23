import crypto from 'node:crypto';
import fs from 'node:fs';

import { ensureAgentRunProjection, loadAgentRun, transitionAgentRun } from '../agentruns.js';
import { loadAssignment } from '../assignments.js';
import { createRuntimeEvent } from '../events.js';
import { nowISO } from '../ids.js';
import { prepareAttemptTakeoverV2, type PrepareAttemptTakeoverV2Input } from './attempt-authority.js';
import { generationDigest } from './attempt-generations.js';
import { commitViaIntent } from './commit-intent.js';
import { evidenceDigest } from './evidence.js';
import { withLoopLock } from './lock.js';
import { getReservation } from './attempt-reservation.js';
import { getLoop, listLoopEvents } from './store.js';
import type { LoopEvent, LoopThread } from './types.js';

export interface TakeoverLoopAttemptInput extends PrepareAttemptTakeoverV2Input {
  loop_id: string;
  slot_id: string;
  /** Authenticated coordinator id; actor remains the human-readable audit name. */
  actor_id?: string;
}

export interface TakeoverLoopAttemptResult {
  loop: LoopThread;
  turn_id: string;
  assignment_id: string;
  previous_run_id: string;
  run_id: string;
  attempt_epoch: number;
  launch_nonce: string;
  workspace_digest: string;
  execution_contract_hash: string;
  won_close: boolean;
  spawn_authority: false;
}

/**
 * Operator/engine takeover transaction.
 *
 * Under the loop lock it publishes close(epoch) and the causal LoopEvent. The
 * immutable close cell remains the authority; AgentRun/RuntimeEvent/head are
 * replayable projections applied after the lock is released. The successor is
 * ARMED but not crossed — the normal worker dispatch path must project then win
 * launch(next epoch) immediately before spawn.
 */
export function takeoverLoopAttempt(input: TakeoverLoopAttemptInput): TakeoverLoopAttemptResult {
  if (!fs.existsSync(input.next_workspace_path) || !fs.statSync(input.next_workspace_path).isDirectory()) {
    throw new Error(`takeover workspace must already exist as an isolated directory: ${input.next_workspace_path}`);
  }

  const authorityActor = input.actor_id ?? input.actor;
  const transaction = withLoopLock({
    cwd: input.cwd,
    intent: 'attempt-takeover',
    agentId: authorityActor,
    scope: { kind: 'loop', loopId: input.loop_id },
    work: () => {
      const loop = getLoop(input.loop_id, input.cwd);
      if (!loop || loop.status !== 'open') throw new Error(`loop ${input.loop_id} is not open`);
      if (loop.created_by !== authorityActor) {
        throw new Error(`attempt takeover requires loop coordinator ${loop.created_by}; caller is ${authorityActor}`);
      }
      const slot = loop.slots.find((candidate) => candidate.slot_id === input.slot_id);
      if (!slot) throw new Error(`slot ${input.slot_id} not found in loop ${input.loop_id}`);
      const reservation = getReservation(input.turn_id, input.cwd);
      if (!reservation || reservation.loop_id !== loop.id || reservation.slot_id !== slot.slot_id) {
        throw new Error(`turn ${input.turn_id} does not own ${loop.id}/${slot.slot_id}`);
      }
      if (slot.current_turn_id !== input.turn_id || slot.assignment_id !== reservation.child_ids.assignment_id) {
        throw new Error(`slot ${slot.slot_id} is no longer bound to turn ${input.turn_id}`);
      }

      const takeover = prepareAttemptTakeoverV2({ ...input, actor: authorityActor });
      const duplicate = listLoopEvents(loop.id, input.cwd).some((event) =>
        event.kind === 'attempt_generation_changed'
        && event.turn_id === input.turn_id
        && event.to_epoch === takeover.next_generation.attempt_epoch
        && event.to_run_id === takeover.next_generation.run_id,
      );
      if (duplicate) return { loop, takeover, reservation };

      const now = nowISO();
      const mutationId = crypto.randomUUID();
      const event: LoopEvent = {
        event_id: crypto.randomUUID(),
        loop_id: loop.id,
        seq: loop.version + 1,
        at: now,
        by: authorityActor,
        mutation_id: mutationId,
        kind: 'attempt_generation_changed',
        slot_id: slot.slot_id,
        turn_id: input.turn_id,
        assignment_id: takeover.next_generation.assignment_id,
        from_epoch: takeover.previous_generation.attempt_epoch,
        to_epoch: takeover.next_generation.attempt_epoch,
        from_run_id: takeover.previous_generation.run_id,
        to_run_id: takeover.next_generation.run_id,
        close_digest: evidenceDigest(takeover.close_cell),
        cause: input.cause,
      };
      const next: LoopThread = {
        ...loop,
        version: loop.version + 1,
        mutation_id: mutationId,
        updated_at: now,
      };
      commitViaIntent({ loop_id: loop.id, base_version: loop.version, events: [event], thread_snapshot: next }, input.cwd);
      return { loop: next, takeover, reservation };
    },
  });

  const { takeover, reservation } = transaction;
  const assignment = loadAssignment(takeover.next_generation.assignment_id, input.cwd);
  const previousRun = loadAgentRun(takeover.previous_generation.run_id, input.cwd);
  if (previousRun && !['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(previousRun.status)) {
    try {
      transitionAgentRun(previousRun.id, 'interrupted', {
        actor: input.actor,
        status_reason: `fenced by ${input.mode ?? 'takeover'} to epoch ${takeover.next_generation.attempt_epoch}`,
        allow_fenced_projection: true,
      }, input.cwd);
    } catch { /* immutable close cell already fences the old run */ }
  }
  ensureAgentRunProjection({
    id: takeover.next_generation.run_id,
    short_label: takeover.next_generation.run_id,
    assignment_id: takeover.next_generation.assignment_id,
    claim_id: reservation.claim_id,
    attempt_index: takeover.next_generation.attempt_epoch + 1,
    agent: reservation.agent,
    agent_id: reservation.agent_id,
    transport: 'cli_spawn',
    status: 'created',
    scope: assignment?.scope ?? reservation.execution_contract?.workspace_policy.scope ?? reservation.cwd,
    description: assignment?.description ?? `Attempt generation ${takeover.next_generation.attempt_epoch} for ${input.turn_id}`,
    worktree_path: takeover.next_generation.workspace_path,
    execution_contract_ref: takeover.execution_contract_ref,
    capability_snapshot: reservation.capability_snapshot,
    tags: ['turn-owned', 'loop', 'attempt-takeover', `attempt-generation:${takeover.next_generation.attempt_epoch}`],
  }, input.cwd);
  try {
    createRuntimeEvent({
      agent: input.actor,
      event_type: 'attempt_takeover',
      text: `Attempt ${input.turn_id} moved from epoch ${takeover.previous_generation.attempt_epoch} to ${takeover.next_generation.attempt_epoch}`,
      tags: ['loops', 'attempt-authority-v2', input.mode ?? 'takeover'],
      assignment_id: takeover.next_generation.assignment_id,
      run_id: takeover.next_generation.run_id,
      turn_id: input.turn_id,
      nonce: takeover.next_generation.launch_nonce,
      attempt_epoch: takeover.next_generation.attempt_epoch,
      workspace_digest: takeover.next_generation.workspace_digest,
      status: 'created',
      status_reason: input.cause,
      metadata: {
        previous_run_id: takeover.previous_generation.run_id,
        generation_digest: generationDigest(takeover.next_generation),
        close_digest: evidenceDigest(takeover.close_cell),
        liveness_evidence: input.liveness_evidence,
        external_effect_policy: input.external_effect_policy,
      },
    }, input.cwd);
  } catch { /* immutable close cell + LoopEvent are sufficient for recovery */ }

  return {
    loop: transaction.loop,
    turn_id: input.turn_id,
    assignment_id: takeover.next_generation.assignment_id,
    previous_run_id: takeover.previous_generation.run_id,
    run_id: takeover.next_generation.run_id,
    attempt_epoch: takeover.next_generation.attempt_epoch,
    launch_nonce: takeover.next_generation.launch_nonce,
    workspace_digest: takeover.next_generation.workspace_digest,
    execution_contract_hash: takeover.execution_contract_ref.hash,
    won_close: takeover.won,
    spawn_authority: false,
  };
}
