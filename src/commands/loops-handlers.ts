import { ZodError } from 'zod';
import type { FacadeResponse, NextAction } from '../core/facade-schema.js';
import { listAgentRuns } from '../core/agentruns.js';
import { reconcileAgentRun } from '../core/agentrun-reconciler.js';
import { dispatchLoopTurn } from '../core/loop-turn-dispatch.js';
import { findReservationByRunId } from '../core/loops/attempt-reservation.js';
import { runVerify } from '../core/loops/verify-command.js';
import { runImplBind } from '../core/loops/impl-bind.js';
import { loadSequence } from '../core/sequence.js';
import { createActionRequired, loadActionRequired } from '../core/actions.js';
import {
  add_artifact,
  advance,
  AwaitingFileApplyApprovalError,
  closeLoop,
  complete_turn,
  computeNextExpected,
  getLoop,
  IdempotencyKeyReusedError,
  IdempotencyOwnerMismatchError,
  listLoopEvents,
  listLoops,
  LockLostError,
  LockTimeoutError,
  openLoop,
  pause,
  provideInput,
  requestInput,
  resume,
  sweepPauseTimeouts,
  takeoverLoopAttempt,
  readLocalAuthorityHome,
  turn,
  VersionConflictError,
  withLoopLock,
  artifactEvidenceDigest,
  attachContinuationActionRequired,
  ensureContinuation,
  type LoopEvent,
  type LoopThread,
  type ContinuationRecord,
} from '../core/loops/index.js';
import {
  BclawLoopRequestSchema,
  BCLAW_LOOP_INTENTS,
  type BclawLoopIntent,
  type BclawLoopRequest,
} from '../core/loops/facade-schema.js';

export interface HandleBclawLoopOptions {
  args: unknown;
  cwd?: string;
  /**
   * Optional actor fallback used when the caller omits `agent`/`agentId`.
   * Defaults to "bclaw_loop" to make origin traceable in the event journal.
   */
  defaultActor?: string;
  /**
   * MCP connection session id. Forwarded to spawning intents (bind) so the
   * dispatched assignments/claims/runs correlate to the coordinator's session,
   * matching bclaw_dispatch / bclaw_coordinate.
   */
  sessionId?: string;
}

export interface HandleBclawLoopResult {
  response: FacadeResponse;
  summary: string;
}

type ValidRequest = BclawLoopRequest;
type LoopEventSnapshot = Set<string>;
// NextExpectedHint type now lives in src/core/loops/next-expected.ts
// (hoisted per can_e57c7782 follow-up so MCP facade + CLI share the
// same contract). Imported above.

function resolveActor(
  req: { agent?: string; agentId?: string },
  defaultActor: string,
): { actor: string; agentId: string } {
  const agentId = req.agentId?.trim() || defaultActor;
  const actor = req.agent?.trim() || req.agentId?.trim() || defaultActor;
  return { actor, agentId };
}

function successResponse(
  intent: string,
  result: unknown,
  artifacts: FacadeResponse['artifacts'],
  side_effects: FacadeResponse['side_effects'],
  warnings: string[],
  durationMs: number,
  summary: string,
): HandleBclawLoopResult {
  const resultLoop = result && typeof result === 'object' && 'loop' in result
    ? (result as { loop?: LoopThread }).loop
    : undefined;
  const nextActions = resultLoop ? pipelineNextActions(resultLoop) : [];
  return {
    response: {
      status: 'ok',
      intent: `bclaw_loop.${intent}`,
      result,
      artifacts,
      side_effects,
      warnings,
      duration_ms: durationMs,
      ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
    },
    summary,
  };
}

/** Cross-loop affordances: explicit next calls, never hidden orchestration. */
function pipelineNextActions(loop: LoopThread): NextAction[] {
  if (loop.kind === 'ideation') {
    const draft = [...loop.artifacts].reverse().find((artifact) => artifact.type === 'plan_draft');
    if (!draft || (loop.current_phase !== 'synthesis' && loop.status !== 'completed')) return [];
    const planIds = loop.linked?.plan_ids ?? [];
    const sequenceIds = loop.linked?.sequence_ids ?? [];
    if (planIds.length > 0 && sequenceIds.length > 0) {
      return [{
        tool: 'bclaw_loop',
        args: {
          intent: 'continue', loop_id: loop.id, action_index: 0,
          autonomy_mode: 'autonomous', risk: 'normal',
        },
        when: 'evaluate and apply the accepted synthesis through persisted continuation policy',
      }];
    }
    return [{
      tool: 'bclaw_create',
      args: { entity: 'plan', text: draft.body ?? '<materialize the plan_draft artifact>', status: 'todo' },
      when: 'materialize the synthesis before opening its implementation loop',
    }];
  }
  if (loop.kind === 'implementation' && loop.current_phase === 'execute' && loop.status === 'open') {
    return loop.slots
      .filter((slot) => slot.status === 'open')
      .map((slot) => ({
        tool: 'bclaw_loop',
        args: {
          intent: 'turn', loop_id: loop.id, slot_id: slot.slot_id,
          input: loop.goal ?? loop.title, dispatch: true,
        },
        when: `dispatch implementation lane ${slot.lane ?? slot.role} through AttemptAuthority`,
      }));
  }
  if (loop.kind === 'implementation' && (loop.current_phase === 'handoff_ready' || loop.status === 'completed')) {
    const handoff = [...loop.artifacts].reverse().find((artifact) => artifact.type === 'handoff');
    const reviewScope = [...new Set(loop.slots.map((slot) => slot.scope_hint?.trim()).filter((scope): scope is string => Boolean(scope)))].join(',');
    return [{
      tool: 'bclaw_coordinate',
      args: {
        intent: 'review', open_loop: true,
        task: handoff?.ref
          ? `Review implementation loop ${loop.id}; handoff ${handoff.ref.kind}:${handoff.ref.id}`
          : `Review implementation loop ${loop.id} (${loop.title})`,
        targetAgents: ['<reviewer>'],
        ...(reviewScope ? { scope: reviewScope } : {}),
        ...(handoff?.ref && (handoff.ref.kind === 'commit' || handoff.ref.kind === 'branch')
          ? { ref: handoff.ref.id }
          : {}),
        linked: { source_loop_id: loop.id, plan_ids: loop.linked?.plan_ids, sequence_ids: loop.linked?.sequence_ids },
      },
      when: 'implementation evidence is handoff-ready',
    }];
  }
  return [];
}

/** Concrete action evaluated by continuation policy; never exposed as an ungoverned hint. */
function proposedPipelineActions(loop: LoopThread, cwd?: string): NextAction[] {
  if (loop.kind !== 'ideation') return [];
  const draft = [...loop.artifacts].reverse().find((artifact) => artifact.type === 'plan_draft');
  const planIds = loop.linked?.plan_ids ?? [];
  const sequenceIds = loop.linked?.sequence_ids ?? [];
  if (!draft || planIds.length === 0 || sequenceIds.length !== 1) return [];
  const sequence = loadSequence(sequenceIds[0]!, cwd);
  const lanes = [...new Set(sequence.items.map((item) => item.lane?.trim() || 'default'))].sort();
  const sourceDigest = artifactEvidenceDigest(draft);
  return [{
    tool: 'bclaw_loop',
    args: {
      intent: 'open', kind: 'implementation', title: `Implement ${loop.title}`,
      goal: loop.goal ?? loop.title,
      linked: {
        plan_ids: planIds, sequence_ids: sequenceIds, source_loop_id: loop.id,
        source_artifact_id: draft.artifact_id, source_artifact_digest: sourceDigest,
      },
      verify: draft.implementation_verify,
      slots: lanes.map((lane) => ({ role: 'implementer', lane })),
      allow_orphan: true,
    },
    when: 'start implementation from the accepted synthesis',
  }];
}

function errorResponse(
  intent: string,
  code: string,
  message: string,
  durationMs: number,
  result: unknown = null,
): HandleBclawLoopResult {
  return {
    response: {
      status: 'error',
      intent: `bclaw_loop.${intent}`,
      result,
      artifacts: [],
      side_effects: [],
      warnings: [],
      error: `${code}: ${message}`,
      duration_ms: durationMs,
    },
    summary: `✘ bclaw_loop[${intent}] ${code}: ${message}`,
  };
}

function inferIntent(args: unknown): BclawLoopIntent | 'unknown' {
  if (!args || typeof args !== 'object') return 'unknown';
  const candidate = (args as { intent?: unknown }).intent;
  if (typeof candidate !== 'string') return 'unknown';
  return (BCLAW_LOOP_INTENTS as readonly string[]).includes(candidate)
    ? (candidate as BclawLoopIntent)
    : 'unknown';
}

function loopArtifactEntry(id: string): FacadeResponse['artifacts'][number] {
  return { type: 'loop', id };
}

function loopEventArtifactEntry(id: string): FacadeResponse['artifacts'][number] {
  return { type: 'loop_event', id };
}

function sideEffectCreate(entity: 'loop' | 'loop_event', id: string): FacadeResponse['side_effects'][number] {
  return { action: 'create', entity, id };
}

function sideEffectUpdate(entity: 'loop' | 'loop_event', id: string): FacadeResponse['side_effects'][number] {
  return { action: 'update', entity, id };
}

function snapshotLoopEvents(loopId: string, cwd?: string): LoopEventSnapshot {
  return new Set(listLoopEvents(loopId, cwd).map((event) => event.event_id));
}

function findNewLoopEvents(loopId: string, before: LoopEventSnapshot | undefined, cwd?: string): LoopEvent[] {
  const events = listLoopEvents(loopId, cwd);
  if (!before) return events;
  return events.filter((event) => !before.has(event.event_id));
}

function loopEventArtifacts(events: LoopEvent[]): FacadeResponse['artifacts'] {
  return events.map((event) => loopEventArtifactEntry(event.event_id));
}

function loopEventSideEffects(events: LoopEvent[]): FacadeResponse['side_effects'] {
  return events.map((event) => sideEffectCreate('loop_event', event.event_id));
}

function validateSemanticRequest(req: ValidRequest): string | null {
  if (req.intent === 'turn' && !req.slot_id && !req.role) {
    return 'turn requires slot_id or role';
  }
  return null;
}

function requestPayload(req: ValidRequest): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...req };
  delete rest.agent;
  delete rest.agentId;
  delete rest.client_request_id;
  return rest;
}

function currentLoopVersion(loopId: string, cwd?: string): number {
  return getLoop(loopId, cwd)?.version ?? 0;
}

type LoopMutationRequest = Exclude<ValidRequest, { intent: 'open' | 'get' | 'list' | 'verify' | 'bind' }>;

/**
 * Slot-bound intents must not let a cached idempotent response leak to a
 * different caller. `complete_turn` is the obvious case: it carries auth
 * semantics (caller_agent_id must match the slot owner or loop.created_by).
 * Without caller-match enforcement on the idempotency cache, a second caller
 * who learned the client_request_id could replay it and receive the cached
 * success payload — bypassing slot-bound auth from an information-disclosure
 * perspective even though the state change already happened. Intents listed
 * here get `requireCallerMatch: true` on their withLoopLock invocation.
 */
const SLOT_BOUND_INTENTS = new Set<BclawLoopIntent>(['complete_turn']);

/**
 * Fence-check discipline for mutations.
 *
 * The `work` callback calls `fenceCheck()` at entry before invoking the verb.
 * This closes the "lock acquired, then reaped mid-wait, then foreign writer
 * took over" window — the verb will not proceed if the lock's mutation_id
 * changed between `acquireLock` and `work` dispatch. It does NOT cover mid-verb
 * fs operations: the verbs themselves (`openLoop`, `advance`, …) perform their
 * atomic-rename + JSONL append without consulting the fence. Safety therefore
 * depends on lock.ts refusing deadline/lease-based takeover of a still-live
 * local process (and failing closed for remote-host owners). If a future slice
 * adds async work inside a mutation or enables time-based/remote takeover,
 * `fenceCheck` must first be threaded to every committing write.
 */
function withLockedLoopMutation(
  req: LoopMutationRequest,
  agentId: string,
  cwd: string | undefined,
  work: () => HandleBclawLoopResult,
): HandleBclawLoopResult {
  return withLoopLock({
    cwd,
    intent: req.intent,
    agentId,
    scope: { kind: 'loop', loopId: req.loop_id },
    expectedVersion: 'expected_version' in req ? req.expected_version : undefined,
    clientRequestId: req.client_request_id,
    requestPayload: requestPayload(req),
    currentVersion: () => currentLoopVersion(req.loop_id, cwd),
    requireCallerMatch: SLOT_BOUND_INTENTS.has(req.intent),
    work: ({ fenceCheck }) => {
      // Best-effort fence at entry; see SLOT_BOUND_INTENTS / fence-check
      // discipline comment above for why mid-verb re-checks are deferred.
      fenceCheck();
      // pln#508 step 3 follow-up (can_810ff9ec): run the timeout sweep
      // INSIDE the loop lock for mutating intents. Previously the sweep
      // ran at facade entry (before lock acquisition), which could race
      // with concurrent writers and turn the caller's expected_version
      // into a sweep-induced version_conflict. Now: sweep writes happen
      // under the same lock as the caller's verb — single-writer
      // serialization preserved. If the sweep bumps the version, the
      // caller's verb sees the post-sweep state (e.g. their question
      // already timed out → provide_input legitimately returns
      // unknown_question, which is correct semantics).
      trySweepLoopTimeouts(req.loop_id, cwd);
      return work();
    },
  });
}

// computeNextExpected lives in src/core/loops/next-expected.ts (hoisted
// per can_e57c7782 follow-up — same contract is now shared by both the
// MCP facade here and the CLI `brainclaw reply` command).

function summarizeLoop(loop: LoopThread, autoClosed?: boolean): string {
  const suffix = autoClosed ? ' (auto-closed)' : '';
  return `✔ loop ${loop.id} [${loop.kind}] phase=${loop.current_phase} status=${loop.status}${suffix}`;
}

/**
 * pln#508 step 3 — lazy pause-timeout reconcile at facade entry.
 *
 * Phase 0 spec §6: any time the facade is invoked against a loop_id, sweep
 * the target loop for timed-out operator_question artifacts BEFORE
 * dispatching the intent. The downstream verb then sees the corrected state
 * (e.g. a `cancel_loop` timeout already fired → mutating intents will get
 * the natural `already cancelled` error from assertMutable; a `use_default`
 * timeout already fired → open_questions reflects the synthesized answer).
 *
 * Best-effort: wrapped in try/catch so any reconcile error (corrupt loop on
 * disk, fs hiccup, …) never blocks the facade. The handler proceeds with
 * stale state in that case, which is no worse than the pre-step-3 behavior.
 *
 * Mirrors the lazy-reconcile pattern used by `agentrun-reconciler.ts` for
 * agent_run silent completion (see entity-operations.ts loadAgentRunsWithReconciliation).
 */
function trySweepLoopTimeouts(loop_id: string, cwd: string | undefined): void {
  try {
    sweepPauseTimeouts(loop_id, undefined, cwd);
  } catch { /* best-effort: never block facade on sweep errors */ }
}

/** Execute a persisted continuation through the same public open handler used by MCP/CLI callers. */
export async function executeContinuationPublicAction(
  record: ContinuationRecord,
  options: { cwd?: string; actor: string; agentId: string; sessionId?: string },
): Promise<{ kind: 'loop'; id: string }> {
  const args = record.action.args ?? {};
  const linked = (args.linked && typeof args.linked === 'object' ? args.linked : {}) as Record<string, unknown>;
  const opened = await handleBclawLoop({
    args: {
      ...args,
      linked: { ...linked, continuation_key: record.continuation_key },
      client_request_id: `ctn_${record.continuation_key}`,
      agent: options.actor,
      agentId: options.agentId,
    },
    cwd: options.cwd,
    defaultActor: options.actor,
    sessionId: options.sessionId,
  });
  if (opened.response.status !== 'ok') throw new Error(opened.response.error ?? opened.summary);
  const downstream = (opened.response.result as { loop?: LoopThread }).loop;
  if (!downstream) throw new Error('continuation_open_missing_loop');
  if (process.env.BRAINCLAW_TEST_FAULT_CONTINUATION_AFTER_OPEN === '1') {
    throw new Error('fault_injection: continuation_after_open');
  }
  return { kind: 'loop', id: downstream.id };
}

export async function handleBclawLoop(options: HandleBclawLoopOptions): Promise<HandleBclawLoopResult> {
  const startMs = Date.now();
  const defaultActor = options.defaultActor ?? 'bclaw_loop';
  const inferredIntent = inferIntent(options.args);
  const parseResult = BclawLoopRequestSchema.safeParse(options.args);
  if (!parseResult.success) {
    return errorResponse(inferredIntent, 'validation_error', parseResult.error.message, Date.now() - startMs);
  }
  const req: ValidRequest = parseResult.data;
  const semanticError = validateSemanticRequest(req);
  if (semanticError) {
    return errorResponse(req.intent, 'validation_error', semanticError, Date.now() - startMs);
  }
  const { actor, agentId } = resolveActor(req, defaultActor);

  // pln#508 step 3 — lazy pause-timeout reconcile at facade entry. Only
  // for the `get` read-only intent (no withLockedLoopMutation wrapper).
  // Mutating intents sweep INSIDE withLockedLoopMutation to keep all
  // writes under the same loop lock as the caller's verb — see
  // can_810ff9ec follow-up. `open` has no existing loop_id; `list`
  // enumerates many loops (unbounded fan-out, not in scope).
  if (req.intent === 'get' && typeof req.loop_id === 'string') {
    trySweepLoopTimeouts(req.loop_id, options.cwd);
  }

  try {
    switch (req.intent) {
      case 'open': {
        if (!req.allow_orphan) {
          return errorResponse(
            'open',
            'validation_error',
            "Direct bclaw_loop(intent='open') creates a loop with no dispatch — no claim, no inbox message, no agent will pick up the work. Use bclaw_coordinate(intent='review', open_loop=true) for review loops (recommended), or pass allow_orphan: true to acknowledge that you will handle turn() + dispatch manually (advanced/test use only). See CLAUDE.md anti-pattern note and pln#461.",
            Date.now() - startMs,
          );
        }
        const runOpen = (): HandleBclawLoopResult => {
          const loop = openLoop(
            {
              kind: req.kind,
              title: req.title,
              goal: req.goal,
              phases: req.phases,
              slots: req.slots,
              linked: req.linked,
              stop_condition: req.stop_condition,
              mode: req.mode,
              verify: req.verify,
              created_by: agentId,
            },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(loop.id, undefined, options.cwd);
          return successResponse(
            'open',
            { loop, next_expected: computeNextExpected(loop) },
            [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectCreate('loop', loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            `✔ opened ${loop.id} [${loop.kind}] phase=${loop.current_phase}`,
          );
        };
        if (!req.client_request_id) {
          return runOpen();
        }
        return withLoopLock({
          cwd: options.cwd,
          intent: req.intent,
          agentId,
          scope: { kind: 'open_idempotency', clientRequestId: req.client_request_id },
          clientRequestId: req.client_request_id,
          requestPayload: requestPayload(req),
          loopIdForIdempotency: undefined,
          work: () => runOpen(),
        });
      }

      case 'get': {
        const loop = getLoop(req.loop_id, options.cwd);
        if (!loop) {
          return errorResponse('get', 'not_found', `unknown loop_id ${req.loop_id}`, Date.now() - startMs);
        }

        // pln#496 Phase 2: reconcile each slot's assigned run before
        // returning the loop. Catches the silent-completion case where a
        // dispatched reviewer committed work / released their claim but
        // never emitted run_completed — the loop appeared stuck on
        // 'assigned' slots forever in May 2026 (lop_3b2068e25166e183 +
        // lop_ea5852302acb8cbb). Targeted to slots with assignment_id so
        // we never run a broad scan here.
        try {
          for (const slot of loop.slots ?? []) {
            const slotStatus = (slot as { status?: string }).status;
            const assignmentId = (slot as { assignment_id?: string }).assignment_id;
            if (!assignmentId) continue;
            if (slotStatus === 'done' || slotStatus === 'failed' || slotStatus === 'cancelled') continue;
            // pln#630 PR2b-c (§13 R6): GET is strictly observational for
            // TURN-OWNED slots. A slot carrying current_turn_id reconciles only
            // via the dedicated mutating reconcile path (never on a read), so a
            // stale/racing read can't phantom-complete its run. Legacy slots
            // (no current_turn_id) keep the intentional lazy reconcile
            // (trp_fdf3e590) that converges silent-completion on access.
            if ((slot as { current_turn_id?: string }).current_turn_id) continue;
            for (const run of listAgentRuns(options.cwd, { assignment_id: assignmentId })) {
              // Belt-and-braces (review PR2b-c #D): skip by ACTUAL ownership too,
              // not just the slot pointer — if a run is turn-owned but its slot
              // wasn't stamped (write-ordering), GET must still not mutate it.
              if (findReservationByRunId(run.id, options.cwd)) continue;
              reconcileAgentRun(run.id, options.cwd);
            }
          }
        } catch { /* defensive: never block loop reads on reconcile errors */ }

        // Re-load the loop after reconciliation so any slot transitions
        // triggered by the reconciler (e.g. via assignment lifecycle hooks)
        // are reflected in the response. Cheap (fs read).
        const reconciledLoop = getLoop(req.loop_id, options.cwd) ?? loop;

        const events = req.include_events ? listLoopEvents(req.loop_id, options.cwd) : undefined;
        return successResponse(
          'get',
          { loop: reconciledLoop, events, next_expected: computeNextExpected(reconciledLoop) },
          [loopArtifactEntry(reconciledLoop.id)],
          [],
          [],
          Date.now() - startMs,
          summarizeLoop(reconciledLoop),
        );
      }

      case 'list': {
        const loops = listLoops({ kind: req.kind, status: req.status }, options.cwd);
        const sliced = typeof req.offset === 'number' || typeof req.limit === 'number'
          ? loops.slice(req.offset ?? 0, (req.offset ?? 0) + (req.limit ?? loops.length))
          : loops;
        return successResponse(
          'list',
          { loops: sliced, total: loops.length },
          sliced.map((l) => loopArtifactEntry(l.id)),
          [],
          [],
          Date.now() - startMs,
          `✔ list ${sliced.length}/${loops.length} loops`,
        );
      }

      case 'turn': {
        if (req.dispatch) {
          if (!req.slot_id) {
            return errorResponse('turn', 'validation_error', 'turn dispatch requires slot_id', Date.now() - startMs);
          }
          const dispatched = await dispatchLoopTurn({
            loop_id: req.loop_id,
            slot_id: req.slot_id,
            task: req.input ?? `Execute ${req.loop_id} slot ${req.slot_id}`,
            dispatcher_agent: actor,
            dispatcher_agent_id: req.agentId,
            session_id: options.sessionId,
            model: req.model,
            auto_execute: req.auto_execute,
            candidate_agents: req.target_agents,
            cwd: options.cwd ?? process.cwd(),
          });
          // Before AttemptAuthority exists an error is a true denial. Once the
          // launch grant has crossed, however, transport may fall back to a
          // manual command or become crossed_unknown. Preserve the created
          // entities in a successful structured response instead of reporting
          // an empty-side-effect error that invites a dangerous retry.
          if (dispatched.error && !dispatched.turn_id) {
            return errorResponse('turn', 'dispatch_denied', dispatched.error, Date.now() - startMs);
          }
          const loop = getLoop(req.loop_id, options.cwd);
          return successResponse(
            'turn',
            { loop, dispatch: dispatched, next_expected: loop ? computeNextExpected(loop) : undefined },
            [
              loopArtifactEntry(req.loop_id),
              ...(dispatched.assignment_id ? [{ type: 'assignment' as const, id: dispatched.assignment_id }] : []),
              ...(dispatched.run_id ? [{ type: 'agent_run' as const, id: dispatched.run_id }] : []),
              ...(dispatched.claim_id ? [{ type: 'claim' as const, id: dispatched.claim_id }] : []),
            ],
            [
              sideEffectUpdate('loop', req.loop_id),
              ...(dispatched.claim_id ? [{ action: 'create', entity: 'claim', id: dispatched.claim_id }] : []),
              ...(dispatched.assignment_id ? [{ action: 'create', entity: 'assignment', id: dispatched.assignment_id }] : []),
              ...(dispatched.run_id ? [{ action: 'create', entity: 'agent_run', id: dispatched.run_id }] : []),
            ],
            dispatched.error ? [dispatched.error] : [],
            Date.now() - startMs,
            dispatched.error
              ? `⚠ ${dispatched.kind}.${dispatched.phase} turn ${dispatched.turn_id} crossed; ${dispatched.error}`
              : `✔ dispatched ${dispatched.kind}.${dispatched.phase} turn ${dispatched.turn_id}`,
          );
        }
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const loop = turn(
            {
              id: req.loop_id,
              slot_id: req.slot_id,
              role: req.role,
              input: req.input,
              assignment_id: req.assignment_id,
              claim_id: req.claim_id,
              actor,
            },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
          return successResponse(
            'turn',
            { loop, next_expected: computeNextExpected(loop) },
            [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(loop),
          );
        });
      }

      case 'complete_turn': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const loop = complete_turn(
            {
              id: req.loop_id,
              slot_id: req.slot_id,
              assignment_id: req.assignment_id,
              turn_id: req.turn_id,
              run_id: req.run_id,
              nonce: req.nonce,
              attempt_epoch: req.attempt_epoch,
              execution_contract_hash: req.execution_contract_hash,
              workspace_digest: req.workspace_digest,
              outcome: req.outcome,
              failure_reason: req.failure_reason,
              artifact: req.artifact
                ? {
                    phase: req.artifact.phase,
                    type: req.artifact.type,
                    body: req.artifact.body,
                    ref: req.artifact.ref,
                    addresses_critique: req.artifact.addresses_critique,
                    implementation_verify: req.artifact.implementation_verify,
                  }
                : undefined,
              actor,
              caller_agent_id: req.agentId,
              // pln#562 step 4 — a dispatched instance proves itself via its
              // claim env; claim-bound slots reject same-named siblings.
              caller_claim_id: process.env.BRAINCLAW_CLAIM_ID?.trim() || undefined,
            },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
          return successResponse(
            'complete_turn',
            { loop, next_expected: computeNextExpected(loop) },
            [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(loop),
          );
        });
      }

      case 'takeover': {
        const authorityHome = readLocalAuthorityHome(options.cwd ?? process.cwd());
        if (!authorityHome) {
          return errorResponse('takeover', 'authority_home_unavailable', 'local store/device authority identity is not initialized', Date.now() - startMs);
        }
        const result = takeoverLoopAttempt({
          loop_id: req.loop_id,
          slot_id: req.slot_id,
          turn_id: req.turn_id,
          expected_epoch: req.expected_epoch,
          authority_home: authorityHome,
          actor,
          actor_id: agentId,
          writer_id: agentId,
          cause: req.cause,
          liveness_evidence: req.liveness_evidence,
          external_effect_policy: req.external_effect_policy,
          next_workspace_path: req.next_workspace_path,
          mode: req.takeover_mode,
          cwd: options.cwd ?? process.cwd(),
        });
        return successResponse(
          'takeover',
          {
            ...result,
            next_action: 'dispatch the same logical turn; the common path will project and contend on launch(next_epoch)',
          },
          [loopArtifactEntry(result.loop.id)],
          [sideEffectUpdate('loop', result.loop.id)],
          [],
          Date.now() - startMs,
          `✔ takeover ${result.turn_id} epoch=${result.attempt_epoch} run=${result.run_id} (armed, not spawned)`,
        );
      }

      case 'advance': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const result = advance(
            {
              id: req.loop_id,
              to_phase: req.to_phase,
              reason: req.reason,
              force: req.force,
              actor,
            },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(result.loop.id, beforeEvents, options.cwd);
          return successResponse(
            'advance',
            { loop: result.loop, auto_closed: result.auto_closed, next_expected: computeNextExpected(result.loop) },
            [loopArtifactEntry(result.loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', result.loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(result.loop, result.auto_closed),
          );
        });
      }

      case 'add_artifact': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const loop = add_artifact(
            {
              id: req.loop_id,
              artifact: {
                phase: req.artifact.phase,
                type: req.artifact.type,
                body: req.artifact.body,
                ref: req.artifact.ref,
                addresses_critique: req.artifact.addresses_critique,
                implementation_verify: req.artifact.implementation_verify,
              },
              actor,
            },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
          return successResponse(
            'add_artifact',
            { loop, next_expected: computeNextExpected(loop) },
            [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(loop),
          );
        });
      }

      case 'pause': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const loop = pause({ id: req.loop_id, reason: req.reason, actor }, options.cwd);
          const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
          return successResponse(
            'pause',
            { loop, next_expected: null },
            [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(loop),
          );
        });
      }

      case 'resume': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const loop = resume({ id: req.loop_id, actor }, options.cwd);
          const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
          return successResponse(
            'resume',
            { loop, next_expected: computeNextExpected(loop) },
            [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(loop),
          );
        });
      }

      case 'request_input': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const result = requestInput(
            {
              loop_id: req.loop_id,
              slot_id: req.slot_id,
              phase: req.phase,
              question_text: req.question_text,
              evidence: req.evidence,
              suggested_default: req.suggested_default,
              options: req.options,
              pause_scope: req.pause_scope,
              on_timeout: req.on_timeout,
              timeout_at: req.timeout_at,
              actor,
            },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(result.thread.id, beforeEvents, options.cwd);
          return successResponse(
            'request_input',
            {
              loop: result.thread,
              question_id: result.question_id,
              artifact_id: result.artifact_id,
              next_expected: computeNextExpected(result.thread),
            },
            [loopArtifactEntry(result.thread.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', result.thread.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(result.thread),
          );
        });
      }

      case 'provide_input': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const result = provideInput(
            {
              loop_id: req.loop_id,
              replies_to: req.replies_to,
              resolved_via: req.resolved_via,
              answer_text: req.answer_text,
              chosen_option_id: req.chosen_option_id,
              by: req.by,
              actor,
            },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(result.thread.id, beforeEvents, options.cwd);
          return successResponse(
            'provide_input',
            {
              loop: result.thread,
              artifact_id: result.artifact_id,
              duplicate: result.duplicate,
              next_expected: computeNextExpected(result.thread),
            },
            [loopArtifactEntry(result.thread.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', result.thread.id), ...loopEventSideEffects(newEvents)],
            result.duplicate
              ? ['provide_input: idempotent replay — replies_to was already resolved; returning existing answer']
              : [],
            Date.now() - startMs,
            summarizeLoop(result.thread),
          );
        });
      }

      case 'close': {
        return withLockedLoopMutation(req, agentId, options.cwd, () => {
          const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
          const loop = closeLoop(
            { id: req.loop_id, final_status: req.status, reason: req.reason, actor },
            options.cwd,
          );
          const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
          return successResponse(
            'close',
            { loop, next_expected: null },
            [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
            [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)],
            [],
            Date.now() - startMs,
            summarizeLoop(loop),
          );
        });
      }

      case 'verify': {
        // pln#632 — run the loop's opener-configured verify command + record a
        // deterministic verify_report. runVerify manages its OWN two lock scopes (the
        // spawn runs OUT of the lock), so it is NOT wrapped in withLockedLoopMutation.
        const existing = getLoop(req.loop_id, options.cwd);
        if (!existing) {
          return errorResponse('verify', 'not_found', `unknown loop_id ${req.loop_id}`, Date.now() - startMs);
        }
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
        const result = runVerify({ loop_id: req.loop_id, slot_id: req.slot_id, actor }, options.cwd);
        const newEvents = findNewLoopEvents(result.thread.id, beforeEvents, options.cwd);
        const summary = result.unconfigured
          ? `verify: loop has no protocol.verify — falling back to an agent-narrated verify_report`
          : result.deduped
            ? `verify: a verify_report already exists for iteration ${result.thread.iteration_count} (idempotent)`
            : `${result.report?.passed ? '✔ verify green' : result.report?.timed_out ? '✖ verify RED (timeout)' : '✖ verify red'}: ${result.report?.command ?? ''}`;
        return successResponse(
          'verify',
          {
            loop: result.thread,
            verify_report: result.report ?? null,
            deduped: result.deduped,
            unconfigured: result.unconfigured ?? false,
            next_expected: computeNextExpected(result.thread),
          },
          [loopArtifactEntry(result.thread.id), ...loopEventArtifacts(newEvents)],
          [sideEffectUpdate('loop', result.thread.id), ...loopEventSideEffects(newEvents)],
          [],
          Date.now() - startMs,
          summary,
        );
      }
      case 'continue': {
        const source = getLoop(req.loop_id, options.cwd);
        if (!source) {
          return errorResponse('continue', 'not_found', `unknown loop_id ${req.loop_id}`, Date.now() - startMs);
        }
        const actions = proposedPipelineActions(source, options.cwd);
        const action = actions[req.action_index];
        if (!action) {
          return errorResponse(
            'continue',
            'continuation_unavailable',
            `no executable continuation action ${req.action_index} for ${source.id}`,
            Date.now() - startMs,
          );
        }
        const sourceArtifactId = (action.args?.linked as { source_artifact_id?: string } | undefined)?.source_artifact_id;
        const sourceArtifact = source.artifacts.find((artifact) => artifact.artifact_id === sourceArtifactId);
        if (!sourceArtifact) {
          return errorResponse('continue', 'continuation_source_missing', 'source plan_draft disappeared', Date.now() - startMs);
        }
        const ensured = await ensureContinuation({
          source_loop: source,
          source_artifact: sourceArtifact,
          action,
          action_index: req.action_index,
          autonomy_mode: req.autonomy_mode,
          risk: req.risk,
          actor,
          actor_id: agentId,
          execute: (record) => executeContinuationPublicAction(record, {
            cwd: options.cwd, actor, agentId, sessionId: options.sessionId,
          }),
        }, options.cwd);

        let continuation = ensured.record;
        if (continuation.state === 'approval_required') {
          let approval = continuation.action_required_id
            ? loadActionRequired(continuation.action_required_id, options.cwd)
            : undefined;
          if (!approval) {
            approval = createActionRequired({
              target: { kind: 'continuation', continuation_id: continuation.id },
              plan_id: source.linked?.plan_ids?.[0],
              sequence_id: source.linked?.sequence_ids?.[0],
              agent: actor,
              agent_id: agentId,
              session_id: options.sessionId,
              kind: 'plan_approval',
              scope: source.goal,
              title: `Approve continuation from ${source.id}`,
              prompt: continuation.reason.join('; '),
              tags: ['loop-engine', 'continuation', 'approval-required'],
            }, options.cwd);
            continuation = attachContinuationActionRequired(continuation.id, approval.id, actor, agentId, options.cwd);
          }
          const handled = successResponse(
            'continue',
            { continuation, action_required: approval },
            [{ type: 'continuation', id: continuation.id }, { type: 'action', id: approval.id }],
            [{ action: 'create', entity: 'action', id: approval.id }],
            [],
            Date.now() - startMs,
            `continuation ${continuation.id} requires approval ${approval.id}`,
          );
          handled.response.next_actions = [{
            tool: 'bclaw_assignment_action',
            args: { action_id: approval.id, outcome: 'resolved' },
            when: 'a different trusted supervisor approves this continuation',
          }];
          return handled;
        }
        if (continuation.state === 'denied') {
          return successResponse(
            'continue', { continuation }, [{ type: 'continuation', id: continuation.id }], [], [],
            Date.now() - startMs, `continuation ${continuation.id} denied: ${continuation.reason.join('; ')}`,
          );
        }
        if (ensured.executing_elsewhere) {
          const handled = successResponse(
            'continue', { continuation, executing_elsewhere: true }, [{ type: 'continuation', id: continuation.id }], [], [],
            Date.now() - startMs, `continuation ${continuation.id} is applying in another live process`,
          );
          handled.response.next_actions = [{
            tool: 'bclaw_loop',
            args: { intent: 'continue', loop_id: source.id, action_index: req.action_index },
            when: 'retry after the current continuation owner settles',
          }];
          return handled;
        }
        const downstreamId = continuation.downstream?.id;
        if (!downstreamId) throw new Error('continuation_applied_without_downstream');
        const bound = await handleBclawLoop({
          args: { intent: 'bind', loop_id: downstreamId, agent: actor, agentId },
          cwd: options.cwd,
          defaultActor: actor,
          sessionId: options.sessionId,
        });
        if (bound.response.status !== 'ok') throw new Error(bound.response.error ?? bound.summary);
        const loop = getLoop(downstreamId, options.cwd);
        if (!loop) throw new Error('continuation_downstream_disappeared');
        return successResponse(
          'continue',
          { loop, continuation, bind: bound.response.result, reused: ensured.reused, next_expected: computeNextExpected(loop) },
          [{ type: 'continuation', id: continuation.id }, loopArtifactEntry(loop.id)],
          [{ action: 'update', entity: 'continuation', id: continuation.id }, sideEffectUpdate('loop', loop.id)],
          [],
          Date.now() - startMs,
          `continuation ${continuation.id} applied to ${loop.id} phase=${loop.current_phase}`,
        );
      }
      case 'bind': {
        // Implementation bind is engine-only: validate the linked sequence and
        // advance bind -> execute. Worker launch belongs exclusively to
        // turn(dispatch=true), the common AttemptAuthority path.
        const existing = getLoop(req.loop_id, options.cwd);
        if (!existing) {
          return errorResponse('bind', 'not_found', `unknown loop_id ${req.loop_id}`, Date.now() - startMs);
        }
        if (existing.kind !== 'implementation') {
          return errorResponse(
            'bind',
            'validation_error',
            `bind is only valid for implementation loops (loop ${req.loop_id} is kind='${existing.kind}'); review/ideation loops dispatch via bclaw_coordinate`,
            Date.now() - startMs,
          );
        }
        const beforeEvents = snapshotLoopEvents(req.loop_id, options.cwd);
        const bind = await runImplBind(
          {
            loop_id: req.loop_id,
            dispatcherAgent: actor,
            dispatcherAgentId: agentId,
            sessionId: options.sessionId,
            dryRun: req.dry_run,
            lanes: req.lanes,
            autoExecute: req.auto_execute,
            model: req.model,
            maxAssignments: req.max_assignments,
          },
          options.cwd,
        );
        const loop = getLoop(req.loop_id, options.cwd)!;
        const newEvents = findNewLoopEvents(loop.id, beforeEvents, options.cwd);
        const sideEffects =
          bind.action === 'bound'
            ? [sideEffectUpdate('loop', loop.id), ...loopEventSideEffects(newEvents)]
            : [...loopEventSideEffects(newEvents)];
        return successResponse(
          'bind',
          {
            loop,
            sequence_id: bind.sequence_id,
            action: bind.action,
            advanced_to: bind.advanced_to ?? null,
            auto_closed: bind.auto_closed ?? false,
            dispatched: bind.messages_sent,
            dispatch: bind.dispatch,
            next_expected: computeNextExpected(loop),
          },
          [loopArtifactEntry(loop.id), ...loopEventArtifacts(newEvents)],
          sideEffects,
          [...bind.warnings, ...(bind.dispatch?.warnings ?? [])],
          Date.now() - startMs,
          bind.reason,
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return errorResponse(req.intent, 'validation_error', err.message, Date.now() - startMs);
    }
    if (err instanceof VersionConflictError) {
      return errorResponse(
        req.intent,
        'version_conflict',
        `expected=${err.expected} actual=${err.actual}`,
        Date.now() - startMs,
        { actual_version: err.actual },
      );
    }
    if (err instanceof IdempotencyKeyReusedError) {
      return errorResponse(
        req.intent,
        'idempotency_key_reused_with_different_body',
        `stored_hash=${err.storedHash} submitted_hash=${err.submittedHash}`,
        Date.now() - startMs,
        { stored_hash: err.storedHash, submitted_hash: err.submittedHash },
      );
    }
    if (err instanceof IdempotencyOwnerMismatchError) {
      return errorResponse(
        req.intent,
        'idempotency_owner_mismatch',
        `stored_owner=${err.storedOwner ?? 'unknown'} submitted_owner=${err.submittedOwner}`,
        Date.now() - startMs,
        { stored_owner: err.storedOwner, submitted_owner: err.submittedOwner },
      );
    }
    if (err instanceof LockTimeoutError) {
      return errorResponse(req.intent, 'lock_timeout', err.message, Date.now() - startMs);
    }
    if (err instanceof LockLostError) {
      return errorResponse(req.intent, 'lock_lost', err.message, Date.now() - startMs);
    }
    if (err instanceof AwaitingFileApplyApprovalError) {
      // pln#512 phase 3 codex review fix #1: surface structurally so callers
      // can branch on the code without parsing the message text.
      return errorResponse(
        req.intent,
        'awaiting_file_apply_approval',
        err.message,
        Date.now() - startMs,
        {
          loop_id: err.loop_id,
          question_id: err.question_id,
          target_path: err.target_path,
          diff_artifact_id: err.diff_artifact_id,
        },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('attempt_fence_')) {
      return errorResponse(req.intent, 'attempt_fence_rejected', message, Date.now() - startMs);
    }
    if (message.includes('unauthorized_slot_write')) {
      return errorResponse(req.intent, 'unauthorized_slot_write', message, Date.now() - startMs);
    }
    if (message.startsWith('unknown loop_id')) {
      return errorResponse(req.intent, 'not_found', message, Date.now() - startMs);
    }
    return errorResponse(req.intent, 'verb_error', message, Date.now() - startMs);
  }

  return errorResponse('unknown', 'unreachable', 'unexpected fallthrough', Date.now() - startMs);
}

export type { LoopEvent, LoopThread };
