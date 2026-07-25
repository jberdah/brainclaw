/**
 * pln#632 impl-loop bind — the ENGINE action for an implementation loop's `bind` phase.
 *
 * The implementation protocol declares `bind` as "bind plan+sequence and dispatch" (see
 * LOOP_PROTOCOLS.implementation in types.ts). This is that action: read the loop's linked
 * sequence, dispatch its ready lanes via the EXISTING sequence spawner, then advance
 * `bind → execute` so the loop enters its execute↔verify cycle.
 *
 * Reuses `dispatch()` ADDITIVELY via its `sequenceId` option (pln#632) so the loop drives
 * its OWN linked sequence WITHOUT touching the project's global active-sequence pointer —
 * no hijack of whatever sequence other bclaw_dispatch work is using. Mirrors the
 * async-handler-spawns pattern already used by bclaw_coordinate(open_loop=true) for review
 * loops; touches NO review/ideation dispatch. The live spawn happens only when this runs
 * on a real loop (exactly like bclaw_dispatch) — `dryRun` previews with no spawn and no
 * phase mutation, so the flow is unit-testable.
 */
import { dispatch, type DispatchResult } from '../dispatcher.js';
import { listSequences } from '../sequence.js';
import { getLoop } from './store.js';
import { advance } from './verbs.js';
import { withLoopLock } from './lock.js';

export interface RunImplBindInput {
  loop_id: string;
  /** Coordinator identity recorded on the dispatch + the advance. */
  dispatcherAgent: string;
  /** Coordinator registered agent id — recorded on the dispatched assignments/claims. */
  dispatcherAgentId?: string;
  /** MCP session id — correlates the spawned work to the coordinator's session. */
  sessionId?: string;
  /** Preview only: analyze + report what WOULD dispatch, no spawn, no advance. */
  dryRun?: boolean;
  /** Restrict dispatch to specific lanes (forwarded to dispatch). */
  lanes?: string[];
  /** Deliver briefs but do not spawn (→ command_ready_manual). Default: dispatch's default (spawn). */
  autoExecute?: boolean;
  /** Model override forwarded to dispatch. */
  model?: string;
  /** Cap assignments made in this bind (forwarded to dispatch). */
  maxAssignments?: number;
}

export interface ImplBindResult {
  loop_id: string;
  sequence_id: string;
  action: 'bound' | 'preview' | 'noop';
  /** Phase after the bind→execute advance (omitted for preview/noop). */
  advanced_to?: string;
  auto_closed?: boolean;
  /** The dispatch result (null when dispatch found nothing to analyze). */
  dispatch: DispatchResult | null;
  messages_sent: number;
  reason: string;
}

/**
 * Bind an implementation loop to its linked sequence and dispatch it. Async because the
 * underlying spawn is async (the only awaited work; `dryRun` resolves synchronously).
 *
 * Idempotent: a loop already past `bind` returns a `noop` (never re-dispatches on a second
 * bind after it advanced). A crash BETWEEN dispatch and advance leaves the loop in `bind`,
 * so a retry re-dispatches only the still-unassigned lanes (dispatch skips lanes with an
 * active assignment) and re-attempts the advance — safe crash-recovery.
 */
export async function runImplBind(input: RunImplBindInput, cwd?: string): Promise<ImplBindResult> {
  const { loop_id, dispatcherAgent } = input;
  const loop = getLoop(loop_id, cwd);
  if (!loop) throw new Error(`unknown loop_id ${loop_id}`);
  if (loop.kind !== 'implementation') {
    throw new Error(
      `bind is only valid for implementation loops (loop ${loop_id} is kind='${loop.kind}'); review/ideation loops dispatch via bclaw_coordinate`,
    );
  }
  // bind SPAWNS real workers via dispatch() — never do that on a loop that is not open.
  // A paused loop keeps current_phase='bind' (pause only flips status), and open→close
  // leaves the phase at 'bind' too, so the phase-idempotency check below is NOT sufficient
  // to stop a spawn on a held/terminal loop (review Finding 1). Gate on status FIRST, so
  // no dispatch fires and we don't spawn then throw at the advance.
  if (loop.status !== 'open') {
    throw new Error(
      `bind requires an open loop; loop ${loop_id} is ${loop.status} (resume a paused loop, or reopen a terminal one, before binding)`,
    );
  }

  const sequenceId = loop.linked?.sequence_ids?.[0];
  // Idempotency: `bind` is the loop's FIRST phase. A loop already past it was bound before.
  if (loop.current_phase !== 'bind') {
    return {
      loop_id,
      sequence_id: sequenceId ?? '',
      action: 'noop',
      dispatch: null,
      messages_sent: 0,
      reason: `loop is in phase '${loop.current_phase}', not 'bind' — already bound (idempotent)`,
    };
  }

  if (!sequenceId) {
    throw new Error(
      `impl-bind requires a linked sequence: open the implementation loop with linked.sequence_ids=[…] (the sequence whose lanes it executes). None found on ${loop_id}.`,
    );
  }
  // Validate up-front (non-throwing lookup) so a missing sequence fails with a clear
  // message rather than a silent null dispatch.
  const seq = listSequences(cwd).find((s) => s.id === sequenceId);
  if (!seq) throw new Error(`linked sequence ${sequenceId} not found for loop ${loop_id}`);

  const dispatched = await dispatch(
    {
      sequenceId,
      dispatcherAgent,
      dispatcherAgentId: input.dispatcherAgentId,
      sessionId: input.sessionId,
      dryRun: input.dryRun,
      lanes: input.lanes,
      autoExecute: input.autoExecute,
      model: input.model,
      maxAssignments: input.maxAssignments,
    },
    cwd ?? process.cwd(),
  );
  const result = dispatched?.result ?? null;
  const messages_sent = result?.messages_sent.length ?? 0;

  // Guard a race: the sequence disappeared between validation and dispatch → don't advance.
  if (!dispatched) {
    return {
      loop_id,
      sequence_id: sequenceId,
      action: 'noop',
      dispatch: null,
      messages_sent: 0,
      reason: `sequence ${sequenceId} yielded no dispatch analysis (unavailable); loop stays in 'bind'`,
    };
  }

  if (input.dryRun) {
    return {
      loop_id,
      sequence_id: sequenceId,
      action: 'preview',
      dispatch: result,
      messages_sent,
      reason: `dry run: ${result?.delivery_plan.length ?? 0} lane(s) would dispatch; loop stays in 'bind' (no spawn, no advance)`,
    };
  }

  // Real bind: advance bind → execute so the loop enters the execute↔verify cycle. The
  // implementation protocol's `bind` phase carries no advance_gate, so the advance is
  // unconditional FROM bind — but the phase-check and the advance must be ATOMIC or two
  // racing binds each advance once and push the loop bind→execute→verify with no execute
  // work done (review Finding 2). advance() does not self-lock (its callers — the facade's
  // withLockedLoopMutation and the ideation closer — provide the lock), so we take the loop
  // lock here and re-check the phase under it: only the bind that still sees 'bind' advances.
  const advanced = withLoopLock<{ phase: string; auto_closed: boolean } | null>({
    cwd,
    intent: 'impl-bind-advance',
    agentId: dispatcherAgent,
    scope: { kind: 'loop', loopId: loop_id },
    work: () => {
      const fresh = getLoop(loop_id, cwd);
      // Raced: a concurrent bind (or a pause/close) moved the loop out of an open 'bind'
      // state → do NOT advance again. Idempotent by construction.
      if (!fresh || fresh.status !== 'open' || fresh.current_phase !== 'bind') return null;
      const a = advance({ id: loop_id, actor: dispatcherAgent }, cwd);
      return { phase: a.loop.current_phase, auto_closed: a.auto_closed };
    },
  });

  if (!advanced) {
    return {
      loop_id,
      sequence_id: sequenceId,
      action: 'noop',
      dispatch: result,
      messages_sent,
      reason: `dispatched ${messages_sent} assignment(s); phase already advanced out of 'bind' under a concurrent bind (idempotent — not re-advanced)`,
    };
  }
  return {
    loop_id,
    sequence_id: sequenceId,
    action: 'bound',
    advanced_to: advanced.phase,
    auto_closed: advanced.auto_closed,
    dispatch: result,
    messages_sent,
    reason: `dispatched ${messages_sent} assignment(s) on sequence ${sequenceId}; advanced bind → ${advanced.phase}`,
  };
}
