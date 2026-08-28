/**
 * Generic production driver for one worker-backed Loop Engine turn.
 *
 * Review and ideation retain their ergonomic coordinate drivers, but every
 * loop kind can enter the same AttemptAuthority lifecycle through this seam.
 * The adapter creates transport projections and starts the worker; it never
 * advances a phase or evaluates a gate.
 */
import { resolveModel } from './agent-capability.js';
import { listAgentIdentities } from './agent-registry.js';
import { transitionAgentRun } from './agentruns.js';
import { loadAssignment, patchAssignmentMessageId, transitionAssignment } from './assignments.js';
import {
  attachAssignmentMessageToClaim,
  createCoordinatorClaim,
  ensureClaimAssignmentBinding,
  releaseClaimIfActive,
} from './claims.js';
import { generateDispatchBrief } from './dispatcher.js';
import { search } from './search.js';
import { attemptExecution } from './execution.js';
import type { TurnEcho } from './execution-adapters.js';
import { resolveExecutionCandidate } from './execution-contract.js';
import { buildHarnessInvocation, resolveHarnessBinding } from './harness-adapters/index.js';
import { phasePolicy } from './loops/kind-policies.js';
import { buildIdeationBrief, type BriefMemoryProvider } from './loops/brief-assembly.js';
import type { LoopContextCategory } from './loops/types.js';
import { getLoop } from './loops/store.js';
import { prepareTurnExecution } from './loops/turn-execution.js';
import { sendMessage } from './messaging.js';
import { removeWorktree } from './worktree.js';

export interface DispatchLoopTurnInput {
  loop_id: string;
  slot_id: string;
  task: string;
  dispatcher_agent: string;
  dispatcher_agent_id?: string;
  session_id?: string;
  model?: string;
  auto_execute?: boolean;
  /** Candidate pool used only when the slot has no frozen agent identity. */
  candidate_agents?: string[];
  cwd: string;
}

export interface DispatchLoopTurnResult {
  loop_id: string;
  slot_id: string;
  kind?: string;
  phase?: string;
  agent?: string;
  claim_id?: string;
  assignment_id?: string;
  run_id?: string;
  turn_id?: string;
  message_id?: string;
  worktree_path?: string;
  execution_status?: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
  command?: string;
  shell?: string;
  error?: string;
}

export async function dispatchLoopTurn(input: DispatchLoopTurnInput): Promise<DispatchLoopTurnResult> {
  const loop = getLoop(input.loop_id, input.cwd);
  if (!loop) return { loop_id: input.loop_id, slot_id: input.slot_id, error: `unknown loop_id ${input.loop_id}` };
  const slot = loop.slots.find((candidate) => candidate.slot_id === input.slot_id);
  const result: DispatchLoopTurnResult = {
    loop_id: loop.id,
    slot_id: input.slot_id,
    kind: loop.kind,
    phase: loop.current_phase,
    agent: slot?.agent,
  };
  if (loop.status !== 'open') return { ...result, error: `loop ${loop.id} is ${loop.status}, not open` };
  if (!slot) return { ...result, error: `slot ${input.slot_id} not found` };
  const policy = phasePolicy(loop.kind, loop.current_phase);
  if (!policy || policy.execution !== 'worker') {
    return { ...result, error: `${loop.kind}.${loop.current_phase} is ${policy?.execution ?? 'unknown'}, not a worker phase` };
  }

  let agent = slot.agent;
  let agentId = slot.agent_id;
  if (!agent) {
    const registered = listAgentIdentities(input.cwd).filter((identity) => identity.kind !== 'human');
    const allowed = new Set(input.candidate_agents ?? registered.map((identity) => identity.agent_name));
    const candidates = registered
      .filter((identity) => allowed.has(identity.agent_name))
      .map((identity) => ({ agent: identity.agent_name, agent_id: identity.agent_id }));
    const role = loop.kind === 'review' || loop.kind === 'ideation'
      ? 'review'
      : loop.kind === 'research' ? 'consult' : 'execute';
    const selection = resolveExecutionCandidate(candidates, {
      roles: [role], required_surfaces: ['cli_spawn'], execution_surfaces: [], required_tools: [],
    });
    if (selection.kind !== 'selected') {
      return { ...result, error: `slot ${slot.slot_id} has no compatible worker candidate` };
    }
    agent = selection.selected.agent;
    agentId = selection.selected.agent_id;
    result.agent = agent;
  }

  const scope = slot.scope_hint ?? `loop:${loop.kind}:${loop.id}:slot:${slot.slot_id}`;
  const sectionByCategory: Partial<Record<LoopContextCategory, string>> = {
    traps: 'traps', decisions: 'decisions', constraints: 'constraints', handoffs: 'handoffs',
    plans: 'plans', candidates: 'candidates',
  };
  const provider: BriefMemoryProvider = {
    fetch(category, query, topK) {
      const section = sectionByCategory[category];
      if (!section) return [];
      return search({ query, section, maxResults: topK, cwd: input.cwd, includePending: section === 'candidates' })
        .map((item) => ({
          id: item.id, category, text: item.text, score: item.score, relatedPaths: item.related_paths,
        }));
    },
  };
  const phaseBrief = buildIdeationBrief({
    thread: loop,
    slotRole: slot.role,
    slotPerspective: slot.perspective,
    memoryProvider: provider,
    seedText: input.task,
    scopeHints: slot.scope_hint ? slot.scope_hint.split(',').map((value) => value.trim()) : [],
  });
  const laneContext = slot.lane
    ? `Lane: ${slot.lane}\nPlans: ${(slot.plan_ids ?? []).join(', ') || '(none)'}\nSteps: ${(slot.step_ids ?? []).join(', ') || '(whole plan)'}`
    : '';
  const scopedTask = [phaseBrief.text, laneContext].filter(Boolean).join('\n\n');
  const description = `${loop.kind} loop turn for ${loop.id} slot ${slot.slot_id} phase ${loop.current_phase}. ${input.task}`;
  try {
    const claim = createCoordinatorClaim({
      agent,
      scope,
      description,
      dispatcherAgent: input.dispatcher_agent,
      sessionId: input.session_id,
      cwd: input.cwd,
    });
    result.claim_id = claim.claimId;
    result.worktree_path = claim.worktreePath;
    if (claim.scopeConflict) {
      result.error = `scope ${scope} is already claimed by ${claim.conflictAgent ?? 'another agent'}`;
      return result;
    }

    const model = resolveModel(agent, { override: input.model });
    const binding = resolveHarnessBinding(agent, model);
    const prepared = prepareTurnExecution({
      kind: loop.kind,
      loop_id: loop.id,
      slot_id: slot.slot_id,
      phase: loop.current_phase,
      agent,
      agent_id: agentId,
      claim_id: claim.claimId,
      dispatcher_agent: input.dispatcher_agent,
      dispatcher_agent_id: input.dispatcher_agent_id,
      dispatcher_session_id: input.session_id,
      scope,
      description,
      task: scopedTask,
      cwd: input.cwd,
      worktree_path: claim.worktreePath,
      model,
      harness_binding: binding,
      assignment_tags: ['coordinate', loop.kind, 'loop', 'turn-owned'],
      run_tags: ['turn-owned', loop.kind, 'loop'],
    });
    if (prepared.kind !== 'won') {
      result.execution_status = 'inbox_only';
      result.error = prepared.reason;
      if (prepared.claim_disposition === 'release' && !claim.reusedExisting) {
        try {
          const released = releaseClaimIfActive(claim.claimId, input.cwd);
          if (released.released && claim.worktreePath) {
            try { removeWorktree(input.cwd, claim.worktreePath, { force: true }); }
            catch (cleanupError) {
              result.error += `; denied-claim worktree cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
            }
          }
        } catch (cleanupError) {
          result.error += `; denied-claim cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
        }
      }
      return result;
    }

    result.assignment_id = prepared.assignment_id;
    result.run_id = prepared.run_id;
    result.turn_id = prepared.turn_id;
    result.worktree_path = prepared.workspace_path;
    const turnEcho: TurnEcho = {
      turn_id: prepared.turn_id,
      run_id: prepared.run_id,
      nonce: prepared.nonce,
      ...(prepared.execution_contract_ref ? {
        contract_hash: prepared.execution_contract_ref.hash,
        capability_snapshot_hash: prepared.execution_contract_ref.snapshot_hash,
      } : {}),
      ...(prepared.attempt_epoch !== undefined ? { attempt_epoch: prepared.attempt_epoch } : {}),
      ...(prepared.workspace_digest ? { workspace_digest: prepared.workspace_digest } : {}),
    };
    const brief = generateDispatchBrief({
      task: scopedTask,
      agent,
      claimId: claim.claimId,
      scope,
      worktreePath: prepared.workspace_path,
      assignmentId: prepared.assignment_id,
      executionContractRef: prepared.execution_contract_ref,
      attemptFence: prepared.attempt_epoch !== undefined && prepared.workspace_digest ? {
        turn_id: prepared.turn_id,
        run_id: prepared.run_id,
        nonce: prepared.nonce,
        attempt_epoch: prepared.attempt_epoch,
        workspace_digest: prepared.workspace_digest,
      } : undefined,
      artifactType: policy.expected_artifacts?.[0]?.loop_artifact_type,
      cwd: input.cwd,
    });
    const message = sendMessage({
      from: input.dispatcher_agent,
      to: agent,
      type: 'assign',
      text: brief,
      ref: loop.id,
      scope,
      requires_ack: true,
      claim_id: claim.claimId,
      assignment_id: prepared.assignment_id,
      tags: ['coordinate', loop.kind, 'loop', 'turn-owned'],
      author_id: input.dispatcher_agent_id,
      session_id: input.session_id,
      payload: {
        intent: 'loop_turn', loop_id: loop.id, slot_id: slot.slot_id,
        phase: loop.current_phase, scope, claim_id: claim.claimId,
        assignment_id: prepared.assignment_id, worktree_path: prepared.workspace_path,
      },
    }, input.cwd);
    result.message_id = message.id;
    attachAssignmentMessageToClaim(claim.claimId, message.id, input.cwd);
    ensureClaimAssignmentBinding(claim.claimId, prepared.assignment_id, input.cwd, {
      worktreePath: prepared.workspace_path,
    });
    const assignment = loadAssignment(prepared.assignment_id, input.cwd);
    if (assignment?.status === 'created' || assignment?.status === 'retrying') {
      transitionAssignment(prepared.assignment_id, 'offered', { actor: input.dispatcher_agent }, input.cwd);
    }
    patchAssignmentMessageId(prepared.assignment_id, message.id, input.cwd);

    const invoke = buildHarnessInvocation(agent, brief, {
      mode: 'worker', model, binding,
      contract: undefined,
      capability_snapshot: prepared.capability_snapshot,
    })?.invoke;
    const execution = await attemptExecution(invoke, {
      agent,
      autoExecute: input.auto_execute ?? true,
      worktreePath: prepared.workspace_path,
      claimId: claim.claimId,
      assignmentId: prepared.assignment_id,
      dispatcherAgent: input.dispatcher_agent,
      dispatcherAgentId: input.dispatcher_agent_id,
      cwd: input.cwd,
      requireWorktree: true,
      turnEcho,
    });
    result.execution_status = execution.execution_status;
    result.command = execution.command;
    result.shell = execution.shell;
    if (execution.error) result.error = execution.error;
    if (execution.execution_status === 'delivered_and_started') {
      try {
        transitionAgentRun(prepared.run_id, 'running', {
          actor: input.dispatcher_agent,
          status_reason: `turn-owned ${loop.kind} worker spawned`,
        }, input.cwd);
      } catch { /* the reconciler converges transport state */ }
    }
    return result;
  } catch (error) {
    result.error = `loop turn dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }
}
