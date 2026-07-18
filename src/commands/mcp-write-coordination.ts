/**
 * MCP coordination / dispatch / loop WRITE tool handlers.
 *
 * Extracted mechanically from mcp.ts (pln#622 PR3a). Each exported handler is
 * the verbatim body of the corresponding `executeMcpToolCall` branch; the
 * enclosing executor's locals (effective cwd, connection session id, resolved
 * model) are carried via {@link McpWriteToolContext} from mcp-write-support.
 *
 * Import rule (pln#622 PR1 guard): this module must never import ./mcp.js —
 * it imports mcp-contract / mcp-catalog boundary modules and core directly.
 *
 * @module
 */
import crypto from 'node:crypto';
import { buildClaimEnvPrefix } from '../core/execution-profile.js';
import { resolveProjectCwd } from '../core/cross-project.js';
import {
  attachAssignmentMessageToClaim,
  createCoordinatorClaim,
  linkClaimToAssignment,
  listClaims,
  saveClaim,
} from '../core/claims.js';
import {
  ensureAgentRegisteredForDispatch,
  findAgentIdentityById,
  findAgentIdentityByName,
} from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO } from '../core/ids.js';
import { validateMcpField } from '../core/input-validation.js';
import { generateCandidateIdWithLabel, saveCandidate } from '../core/candidates.js';
import type { BriefMemoryProvider, LoopContextCategory, LoopThread } from '../core/loops/index.js';
import { ackMessage, getThread, hasActiveAssignment, sendMessage } from '../core/messaging.js';
import { dispatch, dispatchReview, generateDispatchBrief } from '../core/dispatcher.js';
import { CoordinateRequestSchema, type FacadeResponse } from '../core/facade-schema.js';
import {
  buildInvokeCommand,
  getCapabilityProfile,
  getSpawnableAgents,
  resolveModel,
  validateAgentForDispatch,
} from '../core/agent-capability.js';
import { attemptExecution } from '../core/execution.js';
import { createAgentRun, transitionAgentRun } from '../core/agentruns.js';
import {
  createAssignment,
  generateAssignmentId,
  patchAssignmentMessageId,
  transitionAssignment,
} from '../core/assignments.js';
import {
  createToolErrorResponse,
  toolResponse,
  type McpToolExecutionOutcome,
} from './mcp-contract.js';
import { handleMcpReadToolCall } from './mcp-read-handlers.js';
import { ensureTrust, type McpWriteToolContext } from './mcp-write-support.js';

export async function handleBclawDispatch(args: Record<string, unknown>, ctx: McpWriteToolContext): Promise<McpToolExecutionOutcome> {
  const { cwd, connectionSessionId } = ctx;
  if ((args.intent === 'analysis' || args.intent === 'review')) {
    // Phase 3 slice 3d — intent dispatch. Routes analysis/review to the
    // equivalent legacy tool handler, preserving the execute path below.
    // See docs/concepts/mcp-governance.md.
    const dispatchIntent = args.intent as string;
    if (dispatchIntent === 'analysis') {
      try {
        return { response: toolResponse(handleMcpReadToolCall('bclaw_dispatch_analysis', args, { cwd })) };
      } catch (err: unknown) {
        return { response: createToolErrorResponse('operation_error', (err as Error).message) };
      }
    }
    // dispatchIntent === 'review' — delegate via dispatchReview directly.
    const resolvedReview = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
    if (resolvedReview.error) {
      return { response: createToolErrorResponse(resolvedReview.error.kind, resolvedReview.error.message, resolvedReview.error.details) };
    }
    try {
      const result = dispatchReview({
        handoffId: args.handoffId as string | undefined,
        reviewer: args.reviewer as string | undefined,
        dryRun: args.dryRun as boolean | undefined,
        openLoop: args.openLoop as boolean | undefined,
        reviewMode: args.reviewMode as 'asymmetric' | 'symmetric' | undefined,
        dispatcherAgent: resolvedReview.identity!.agent_name,
        dispatcherAgentId: resolvedReview.identity!.agent_id,
        sessionId: connectionSessionId,
      }, cwd);
      const text = args.dryRun
        ? `🔍 Review dispatch dry run: ${result.reviews_sent.length} target(s).`
        : `✔ Review dispatch complete: ${result.reviews_sent.length} target(s).`;
      return {
        response: toolResponse({
          content: [{ type: 'text', text }],
          ...result,
        }),
      };
    } catch (err: unknown) {
      return { response: createToolErrorResponse('operation_error', (err as Error).message) };
    }
  }
  if (args.intent !== undefined && args.intent !== 'execute') {
    return { response: createToolErrorResponse('validation_error', `bclaw_dispatch: unknown intent '${args.intent}'. Expected analysis | execute | review.`) };
  }

  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  try {
    const result = await dispatch({
      agents: args.agents as string[] | undefined,
      lanes: args.lanes as string[] | undefined,
      maxAssignments: args.maxAssignments as number | undefined,
      dryRun: args.dryRun as boolean | undefined,
      dispatcherAgent: resolved.identity!.agent_name,
      dispatcherAgentId: resolved.identity!.agent_id,
      sessionId: connectionSessionId,
      autoExecute: args.autoExecute as boolean | undefined,
      model: args.model as string | undefined,
    }, cwd);

    if (!result) {
      return { response: createToolErrorResponse('operation_error', 'No active sequence found. Create a sequence first.') };
    }

    const { analysis, result: dispatchResult } = result;
    const lines: string[] = [];

    if (args.dryRun) {
      lines.push('Dispatch dry run (no messages sent):');
    } else {
      lines.push('Dispatch cycle complete:');
    }

    lines.push(`  Sequence: ${analysis.sequence.name}`);
    lines.push(`  Ready: ${analysis.ready.length} | Active: ${analysis.active.length} | Blocked: ${analysis.blocked.length} | Done: ${analysis.done.length}`);

    // can_681a6c52 — truthful per-delivery status. The old output printed
    // '[inbox]' for every entry and ALWAYS dumped a 'Run these commands'
    // block, even when the auto-spawn had already SUCCEEDED — an obedient
    // coordinator would then double-spawn the worker.
    const spawnedPlanIds = new Set(
      dispatchResult.messages_sent
        .filter((m) => m.execution_status === 'delivered_and_started')
        .map((m) => m.plan_id),
    );
    if (dispatchResult.messages_sent.length > 0) {
      lines.push('');
      lines.push(args.dryRun ? '  Would assign:' : '  Assigned:');
      for (const msg of dispatchResult.messages_sent) {
        const lane = msg.lane ? ` (lane: ${msg.lane})` : '';
        const exec = msg.execution_status ? ` [${msg.execution_status}]` : ' [inbox]';
        const pid = msg.pid ? ` pid=${msg.pid}` : '';
        const run = msg.run_id ? ` run=${msg.run_id}` : '';
        lines.push(`    ${msg.agent}: ${msg.plan_id}${lane}${exec}${pid}${run}`);
      }
    }

    const spawned = dispatchResult.messages_sent.filter((m) => m.execution_status === 'delivered_and_started');
    if (spawned.length > 0) {
      lines.push('');
      lines.push('Auto-spawn succeeded — do NOT run the launch commands for these (double-spawn risk). Verify instead:');
      for (const msg of spawned) {
        const target = msg.assignment_id ?? msg.run_id ?? msg.claim_id;
        lines.push(`  bclaw_dispatch_status(target_id: "${target}")  # ${msg.agent} on ${msg.plan_id}`);
      }
    }

    // Only surface manual launch commands for deliveries that were NOT
    // auto-spawned (manual fallback, spawn refusal, inbox-only).
    const manualCommands = dispatchResult.commands.filter(
      (cmd) => !cmd.plan_id || !spawnedPlanIds.has(cmd.plan_id),
    );
    if (manualCommands.length > 0) {
      lines.push('');
      lines.push('Run these commands to launch the agents that were NOT auto-spawned:');
      lines.push('');
      for (const cmd of manualCommands) {
        const lane = cmd.lane ? ` [lane: ${cmd.lane}]` : '';
        lines.push(`# ${cmd.agent}${lane}`);
        lines.push(cmd.command);
        lines.push('');
      }
    }

    if (dispatchResult.skipped.length > 0) {
      lines.push('');
      lines.push('  Skipped:');
      for (const skip of dispatchResult.skipped) {
        lines.push(`    - ${skip.plan_id}: ${skip.reason}`);
      }
    }

    // can_45316d5c — worktree warnings / spawn refusals were hidden behind
    // dispatch_status; surface them in the cycle output itself.
    if (dispatchResult.warnings.length > 0) {
      lines.push('');
      lines.push('  Warnings:');
      for (const warning of dispatchResult.warnings) {
        lines.push(`    ⚠ ${warning}`);
      }
    }

    appendAuditEntry({
      actor: resolved.identity!.agent_name,
      actor_id: resolved.identity!.agent_id,
      action: 'create',
      item_type: 'dispatch',
      scope: `${dispatchResult.messages_sent.length} assignments`,
    }, cwd);

    return {
      response: toolResponse({
        content: [{ type: 'text', text: lines.join('\n') }],
        ...dispatchResult,
        sequence_id: analysis.sequence.id,
        dry_run: !!args.dryRun,
      }),
    };
  } catch (err: unknown) {
    return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
  }
}

export function handleBclawSendMessage(args: Record<string, unknown>, ctx: McpWriteToolContext): McpToolExecutionOutcome {
  const { cwd, connectionSessionId } = ctx;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const to = String(args.to ?? '').trim();
  if (!to) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: to') };
  }
  const msgType = String(args.type ?? '').trim();
  if (!['assign', 'review', 'rfc', 'info', 'reply'].includes(msgType)) {
    return { response: createToolErrorResponse('validation_error', 'type must be one of: assign, review, rfc, info, reply') };
  }
  const msgText = String(args.text ?? '').trim();
  if (!msgText) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
  }
  const textCheck = validateMcpField(msgText, 'text');
  if (!textCheck.ok) {
    return { response: createToolErrorResponse('validation_error', textCheck.message) };
  }
  // Auto-generate thread_id for new rfc/review threads
  let threadId = args.thread_id as string | undefined;
  if (!threadId && (msgType === 'rfc' || msgType === 'review')) {
    threadId = `thread_${crypto.randomBytes(4).toString('hex')}`;
  }
  try {
    const result = sendMessage({
      from: resolved.identity!.agent_name,
      to,
      type: msgType as import('../core/schema.js').MessageType,
      text: msgText,
      ref: args.ref as string | undefined,
      payload: args.payload as Record<string, unknown> | undefined,
      scope: args.scope as string | undefined,
      requires_ack: args.requires_ack as boolean | undefined,
      thread_id: threadId,
      tags: (args.tags as string[]) ?? [],
      author_id: resolved.identity!.agent_id,
      session_id: connectionSessionId,
    }, cwd);
    appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'create', item_id: result.id, item_type: 'message', scope: to }, cwd);
    const threadInfo = threadId ? ` thread:${threadId}` : '';
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Message sent: [${result.shortLabel}] ${msgType} → ${to}${threadInfo}` }],
        message_id: result.id,
        thread_id: threadId,
      }),
    };
  } catch (err: unknown) {
    return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
  }
}

export function handleBclawAckMessage(args: Record<string, unknown>, ctx: McpWriteToolContext): McpToolExecutionOutcome {
  const { cwd, connectionSessionId } = ctx;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const msgId = String(args.id ?? '').trim();
  if (!msgId) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  }
  try {
    // pln#562 step 4 — a dispatched instance (BRAINCLAW_CLAIM_ID) may only
    // ack messages bound to its own claim.
    const result = ackMessage(msgId, resolved.identity!.agent_name, cwd, {
      claimId: process.env.BRAINCLAW_CLAIM_ID?.trim() || undefined,
    });
    appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: result.id, item_type: 'message' }, cwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Message acknowledged: [${result.id}]` }],
        message_id: result.id,
        status: result.status,
      }),
    };
  } catch (err: unknown) {
    return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
  }
}

export async function handleBclawCoordinate(args: Record<string, unknown>, ctx: McpWriteToolContext): Promise<McpToolExecutionOutcome> {
  const { cwd, connectionSessionId, currentModel } = ctx;
  const startMs = Date.now();
  const parseResult = CoordinateRequestSchema.safeParse(args);
  if (!parseResult.success) {
    return { response: createToolErrorResponse('validation_error', parseResult.error.message) };
  }
  const req = parseResult.data;

  // pln#511 step 2 — preset selector validation. Presets are kind-
  // specific in v1: only intent='ideate' carries them. Unknown names
  // are rejected up-front against the registry so the handler never
  // silently falls back to the kind-default. The bootstrap preset
  // also enforces a dispatch constraint (can_753a083a): the champion
  // must be a human-connected agent, never a sandboxed worker —
  // checked below once the senderAgent is resolved.
  if (req.preset !== undefined) {
    if (req.intent !== 'ideate') {
      return {
        response: createToolErrorResponse(
          'preset_kind_mismatch',
          `preset='${req.preset}' is only valid for intent='ideate' in v1; got intent='${req.intent}'. Loop presets are kind-specific — open the loop without a preset, or call with intent='ideate'.`,
        ),
      };
    }
    const { PRESETS: PRESETS_REGISTRY } = await import('../core/loops/presets/index.js');
    if (!(req.preset in PRESETS_REGISTRY)) {
      const validNames = Object.keys(PRESETS_REGISTRY).join(', ') || '(none)';
      return {
        response: createToolErrorResponse(
          'unknown_preset',
          `Unknown preset '${req.preset}'. Valid preset names: ${validNames}.`,
        ),
      };
    }
  }

  // can_30c295b4 / trp#371 Tier 2 — the scope-aware dirty-working-tree
  // guard runs LOWER DOWN, after dispatchCwd / isCrossProject are
  // resolved (so it probes the dispatch TARGET, not the source, and only
  // for the intents that actually spawn a worktree worker). See the
  // assessDirtyDispatchGuard call after the cross-project block.
  const warnings: string[] = [];
  const artifacts: Array<{ type: string; id: string; path?: string }> = [];
  const side_effects: Array<{ action: string; entity: string; id: string }> = [];

  // can_5e62334e — codex sandboxed dispatches cannot commit in worktrees
  // because `.git` is a file pointer to the parent repo's
  // .git/worktrees/<wt>/ directory, which lives OUTSIDE the worktree's
  // writable root that `--sandbox workspace-write` permits. Any
  // codex worker that runs `git commit` will fail with `index.lock:
  // Permission denied`. Warn callers up-front so briefs don't request
  // per-bug commits; the coordinator must harvest the worktree
  // diff via `git diff` and commit from a non-sandboxed cwd.
  if (Array.isArray(req.targetAgents) && req.targetAgents.includes('codex')) {
    warnings.push(
      'codex --sandbox workspace-write cannot commit to git in worktrees (.git is outside writable root). Briefs MUST NOT request per-bug commits; codex will produce uncommitted edits, then the coordinator must harvest via `git diff HEAD` from the worktree path and commit from the main repo. See can_5e62334e for context.',
    );
  }

  const senderAgent = typeof args.agent === 'string' && args.agent.trim()
    ? args.agent.trim()
    : 'bclaw_coordinate';
  const senderAgentId = typeof args.agentId === 'string' && args.agentId.trim()
    ? args.agentId.trim()
    : undefined;

  // pln#511 step 2 — bootstrap preset dispatch constraint (can_753a083a).
  // The bootstrap loop's champion must be a human-connected agent: it
  // asks the operator clarifying questions and writes PROJECT.md. A
  // sandboxed worker (codex / github-copilot) cannot reach the human,
  // so the loop would stall in `clarify`. Enforce by requiring
  // targetAgents to be empty (= single-agent / self-champion mode)
  // or to contain only the caller. Other presets are unrestricted.
  if (req.preset === 'bootstrap') {
    const targets = req.targetAgents ?? [];
    const onlyCaller = targets.length === 0
      || (targets.length === 1 && targets[0] === senderAgent);
    if (!onlyCaller) {
      return {
        response: createToolErrorResponse(
          'bootstrap_preset_not_dispatchable',
          `preset='bootstrap' cannot dispatch to other agents (can_753a083a): the champion must be a human-connected agent. Got targetAgents=${JSON.stringify(targets)}; pass an empty array or [${JSON.stringify(senderAgent)}].`,
        ),
      };
    }
  }

  const commandHints: Array<{ agent: string; command: string; shell: string }> = [];
  type PreparedInvoke = { entry: CoordinateDeliveryEntry; invoke: ReturnType<typeof buildInvokeCommand>; worktreePath?: string };
  const preparedInvokes: PreparedInvoke[] = [];

  // pln#359 phase 1b — cross-project routing. When `project` is set, all
  // dispatch writes (claim, assignment, inbox message, audit) land in the
  // target project (`dispatchCwd`). The target agent picks the brief up
  // async via its own bclaw_work — auto-spawn from the source process
  // is disabled because the spawn cwd / worktree semantics are tied to
  // the target's git repo. The dispatch flow below uses `dispatchCwd`
  // for state-mutating helpers; the outer `cwd` (source) stays in scope
  // for the few cases that genuinely need source attribution.
  const dispatchCwd = resolveProjectCwd(req.project, cwd);
  const isCrossProject = dispatchCwd !== cwd;
  if (isCrossProject && req.autoExecute !== false) {
    warnings.push(
      `cross-project dispatch (project='${req.project}') — auto-spawn disabled; the target agent picks up the brief async via its own bclaw_work.`,
    );
  }
  const effectiveAutoExecute = isCrossProject ? false : req.autoExecute;

  // can_30c295b4 / trp#371 Tier 2 — scope-aware dirty-working-tree guard.
  // Intents that spawn a worktree worker from HEAD can review/edit stale code,
  // so they are guarded; consult/summarize (no worktree) are not. pln#626
  // Phase 2 — multi-agent ideate now ALSO builds a worktree (from HEAD) per
  // critic, so it is subject to the same stale-code concern; but ideation ABOUT
  // in-progress work is legitimate, so ideate only WARNS (never blocks) that
  // critics see HEAD, not the working tree. Cross-project dispatch is inbox-only
  // (no local worktree here) so it is skipped. The guard compares dirty files
  // against the dispatch scope and only blocks when overlap can't be ruled out;
  // allow_dirty=true downgrades a block to a warning; an explicit ref makes
  // working-tree dirt intentionally out of scope.
  const WORKTREE_SPAWNING_INTENTS = new Set(['assign', 'review', 'reroute']);
  const ideateWillSpawn = req.intent === 'ideate'
    && Array.isArray(req.targetAgents) && req.targetAgents.length > 0
    && req.preset !== 'bootstrap';
  if (!isCrossProject && (WORKTREE_SPAWNING_INTENTS.has(req.intent) || ideateWillSpawn)) {
    // Probe with the SAME scope the dispatch will actually claim, so the
    // resolution mirrors reality (codex r1): assign falls back to the task
    // text (mcp ~assignScope), reroute to the targeted active claim's scope.
    let guardScope = req.scope;
    if (req.intent === 'assign') {
      guardScope = req.scope ?? req.task;
    } else if (req.intent === 'reroute' && !req.scope) {
      guardScope = listClaims(dispatchCwd).find((c) => c.status === 'active')?.scope;
    }
    const { assessDirtyDispatchGuard } = await import('../core/dirty-scope.js');
    const assessment = assessDirtyDispatchGuard({
      cwd: dispatchCwd,
      scope: guardScope,
      allowDirty: req.allow_dirty,
      checkoutRef: req.ref,
    });
    // ideate never blocks (ideating on dirty work is valid) — its block downgrades to a warn.
    if (assessment.decision === 'block' && !ideateWillSpawn) {
      return {
        response: createToolErrorResponse('dirty_working_tree', `${assessment.reason} (cwd: ${dispatchCwd})`),
      };
    }
    if (assessment.decision === 'warn' || (assessment.decision === 'block' && ideateWillSpawn)) {
      warnings.push(
        `dirty_working_tree: ${assessment.reason}`
        + (ideateWillSpawn ? ' — ideate critics spawn from HEAD and will not see your uncommitted changes' : ''),
      );
    }
  }

  /** Run E2E execution phase on prepared delivery entries. Returns overall execution status. */
  const runCoordinateExecution = async (
    prepared: PreparedInvoke[],
    opts: { autoExecute: boolean; senderAgent: string; senderAgentId?: string; cwd: string; warnings: string[] },
  ): Promise<'delivered_and_started' | 'command_ready_manual' | 'inbox_only'> => {
    let overall: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only' = 'inbox_only';
    for (const { entry, invoke, worktreePath } of prepared) {
      const execResult = await attemptExecution(invoke, {
        agent: entry.agent,
        autoExecute: opts.autoExecute,
        worktreePath,
        claimId: entry.claim_id,
        assignmentId: entry.assignment_id,
        dispatcherAgent: opts.senderAgent,
        dispatcherAgentId: opts.senderAgentId,
        cwd: opts.cwd,
        requireWorktree: true, // pln#531: never spawn a worker in the integration repo
      });
      entry.execution_status = execResult.execution_status;
      // pln#626 Phase 1 — carry the machine-readable reason (+ failure_kind) to
      // the delivery entry so the primary spawn path (assign/review/reroute) is
      // as honest as consult/ideate: a command_ready_manual entry now says WHY.
      if (execResult.execution_reason) entry.execution_reason = execResult.execution_reason;
      if (execResult.failure_kind) entry.failure_kind = execResult.failure_kind;
      if (execResult.pid) entry.pid = execResult.pid;
      if (execResult.execution_status === 'delivered_and_started') {
        entry.channel = 'spawned_cli';
        overall = 'delivered_and_started';
      } else if (execResult.execution_status === 'command_ready_manual' && overall !== 'delivered_and_started') {
        overall = 'command_ready_manual';
      }
      // Attribute the reason to its agent — a 3-target NO_SPAWN dispatch used to
      // emit three identical context-free warnings (pln#626 Phase 1 R5).
      if (execResult.error) opts.warnings.push(`${entry.agent}: ${execResult.error}`);
      if (entry.assignment_id && entry.claim_id) {
        if (execResult.failure_kind === 'spawn_no_handshake') {
          try {
            const run = createAgentRun({
              assignment_id: entry.assignment_id,
              claim_id: entry.claim_id,
              message_id: entry.message_id,
              agent: entry.agent,
              transport: 'cli_spawn',
              status: 'launching',
              scope: worktreePath ?? entry.scope ?? entry.ref ?? entry.assignment_id,
              description: `Coordinate execution attempt for ${entry.scope ?? entry.ref ?? entry.assignment_id}`,
              worktree_path: worktreePath,
              command: execResult.command,
              shell: execResult.shell,
              pid: execResult.pid,
              status_reason: 'CLI spawn launched by coordinator',
              tags: ['coordinate-run', `message:${entry.message_type}`],
            }, opts.cwd);
            transitionAgentRun(run.id, 'failed', {
              actor: opts.senderAgent,
              actor_id: opts.senderAgentId,
              pid: execResult.pid,
              status_reason: execResult.error,
              error_message: execResult.error,
            }, opts.cwd);
          } catch (runErr) {
            opts.warnings.push(`AgentRun creation failed for ${entry.assignment_id}: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
          }

          try {
            transitionAssignment(entry.assignment_id, 'failed', {
              actor: opts.senderAgent,
              actor_id: opts.senderAgentId,
              error_message: execResult.error,
              status_reason: execResult.error,
              syncAgentRun: false,
            }, opts.cwd);
          } catch (assignmentErr) {
            opts.warnings.push(`Assignment failure transition failed for ${entry.assignment_id}: ${assignmentErr instanceof Error ? assignmentErr.message : String(assignmentErr)}`);
          }
          continue;
        }

        try {
          const run = createAgentRun({
            assignment_id: entry.assignment_id,
            claim_id: entry.claim_id,
            message_id: entry.message_id,
            agent: entry.agent,
            transport: execResult.execution_status === 'delivered_and_started'
              ? 'cli_spawn'
              : execResult.execution_status === 'command_ready_manual'
                ? 'manual_command'
                : 'inbox_only',
            scope: worktreePath ?? entry.scope ?? entry.ref ?? entry.assignment_id,
            description: `Coordinate execution attempt for ${entry.scope ?? entry.ref ?? entry.assignment_id}`,
            worktree_path: worktreePath,
            command: execResult.command,
            shell: execResult.shell,
            pid: execResult.pid,
            status_reason: execResult.error,
            tags: ['coordinate-run', `message:${entry.message_type}`],
          }, opts.cwd);

          if (execResult.execution_status === 'delivered_and_started') {
            transitionAgentRun(run.id, 'launching', {
              actor: opts.senderAgent,
              actor_id: opts.senderAgentId,
              pid: execResult.pid,
              status_reason: 'CLI spawn launched by coordinator',
            }, opts.cwd);
            transitionAgentRun(run.id, 'running', {
              actor: opts.senderAgent,
              actor_id: opts.senderAgentId,
              pid: execResult.pid,
              status_reason: 'CLI process started',
            }, opts.cwd);
          } else if (execResult.execution_status === 'command_ready_manual') {
            transitionAgentRun(run.id, 'waiting_input', {
              actor: opts.senderAgent,
              actor_id: opts.senderAgentId,
              status_reason: execResult.error ?? 'Awaiting manual command execution',
            }, opts.cwd);
          } else {
            transitionAgentRun(run.id, 'waiting_input', {
              actor: opts.senderAgent,
              actor_id: opts.senderAgentId,
              status_reason: 'Awaiting inbox pickup by assigned agent',
            }, opts.cwd);
          }
        } catch (runErr) {
          opts.warnings.push(`AgentRun creation failed for ${entry.assignment_id}: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
        }
      }
    }
    return overall;
  };

  // pln#628 Focus 4B — appended to a REVIEW dispatch brief only. Tells the
  // reviewer to emit a machine-readable verdict in LANE-RESULT.json so the
  // coordinator's harvest can close the review loop (reviewer_green) without a
  // human driving complete_turn/advance. Findings prose still goes wherever the
  // task asks (e.g. a REVIEW-*.md); this is the structured signal the loop reads.
  const reviewVerdictBriefSuffix =
    '\n\n## Review verdict (required — drives autonomous loop convergence)\n'
    + 'In your LANE-RESULT.json set "status":"completed" AND add "review_verdict": '
    + '"approve" (change is good to merge) or "request_changes" (needs fixes), plus '
    + '"review_summary":"<one-line rationale>". The coordinator reads review_verdict '
    + 'to close the review loop on approve, or continue it on request_changes.';

  /** Build a coordinate brief: delegates to shared generateDispatchBrief(). */
  const buildCoordinateBrief = (agentName: string, task: string, options?: { claimId?: string; scope?: string; worktreePath?: string; assignmentId?: string }): string => {
    return generateDispatchBrief({
      task,
      agent: agentName,
      claimId: options?.claimId,
      scope: options?.scope,
      worktreePath: options?.worktreePath,
      assignmentId: options?.assignmentId,
    });
  };
  type CoordinateDeliveryEntry = {
    agent: string;
    message_id: string;
    channel: 'inbox' | 'spawned_cli';
    message_type: 'assign' | 'rfc' | 'review';
    requires_ack: boolean;
    ref?: string;
    scope?: string;
    thread_id?: string;
    claim_id?: string;
    assignment_id?: string;
    released_claim_id?: string;
    command?: string;
    shell?: string;
    execution_status?: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
    // pln#626 Phase 1 — per-entry reason so a command_ready_manual entry is
    // never silent about WHY it didn't spawn (auto_execute_disabled vs
    // not_spawnable vs spawn_*). Copied from attemptExecution's ExecutionResult.
    execution_reason?: string;
    failure_kind?: string;
    pid?: number;
  };
  const toMessageSummary = (deliveryPlan: CoordinateDeliveryEntry[]) => deliveryPlan.map((entry) => ({
    agent: entry.agent,
    message_id: entry.message_id,
    channel: entry.channel,
    ref: entry.ref,
    ...(entry.thread_id ? { thread_id: entry.thread_id } : {}),
  }));
  const queueCoordinateMessage = (input: {
    agent: string;
    text: string;
    messageType: 'assign' | 'rfc' | 'review';
    ref?: string;
    scope?: string;
    requiresAck?: boolean;
    threadId?: string;
    claimId?: string;
    assignmentId?: string;
    releasedClaimId?: string;
    tags?: string[];
    payload?: Record<string, unknown>;
    commandMode?: 'worker' | 'consult';
  }): { entry: CoordinateDeliveryEntry; invoke: ReturnType<typeof buildInvokeCommand> } => {
    const msgResult = sendMessage({
      from: senderAgent,
      to: input.agent,
      type: input.messageType,
      text: input.text,
      ref: input.ref,
      payload: input.payload,
      scope: input.scope,
      requires_ack: input.requiresAck,
      thread_id: input.threadId,
      claim_id: input.claimId,
      assignment_id: input.assignmentId,
      tags: input.tags ?? [],
      author_id: senderAgentId,
      session_id: connectionSessionId,
    }, dispatchCwd);
    artifacts.push({ type: 'message', id: msgResult.id });
    side_effects.push({ action: 'create', entity: 'message', id: msgResult.id });

    const invoke = buildInvokeCommand(input.agent, input.text, {
      mode: input.commandMode ?? 'worker',
      // pln#520/#606 — decouple model from agent identity. req.model is the
      // override link; when unset, resolveModel intentionally falls back to
      // the profile's default_model (the documented last link in the chain),
      // mirroring the dispatcher's resolveModel usage (dispatcher.ts) so
      // coordinate and dispatch spawn with the same model. No profile ships
      // a default_model today, so omitting model stays a no-op in practice
      // (gpt-5.6-luna review). Flows to both the manual commandHint and the
      // auto-spawn path (runCoordinateExecution reuses this invoke).
      model: resolveModel(input.agent, { override: req.model }),
    });
    // Build env prefix for claim routing — centralised in
    // execution-profile.ts:buildClaimEnvPrefix as of pln#496 step
    // stp_a9afe59d (handles all five shells, not just Windows/POSIX).
    const claimEnvPrefix = buildClaimEnvPrefix(input.claimId);
    const resolvedShell = process.platform === 'win32' ? 'cmd' : (invoke?.shell ? 'bash' : 'sh');
    const commandHint = invoke
      ? {
          agent: input.agent,
          command: `${claimEnvPrefix}${invoke.bashCommand}`,
          shell: resolvedShell,
        }
      : undefined;
    if (commandHint) commandHints.push(commandHint);

    return {
      entry: {
        agent: input.agent,
        message_id: msgResult.id,
        channel: 'inbox',
        message_type: input.messageType,
        requires_ack: input.requiresAck ?? false,
        ref: input.ref,
        scope: input.scope,
        thread_id: input.threadId,
        claim_id: input.claimId,
        assignment_id: input.assignmentId,
        released_claim_id: input.releasedClaimId,
        command: commandHint?.command,
        shell: commandHint?.shell,
      },
      invoke,
    };
  };

  // Resolve target agents: explicit list or all spawnable
  const resolvedAgents: string[] = (req.targetAgents && req.targetAgents.length > 0)
    ? req.targetAgents
    : getSpawnableAgents().map((a) => a.name);

  let result: unknown = { selected_targets: resolvedAgents };
  let facadeStatus: FacadeResponse['status'] = 'ok';

  if (req.intent === 'assign') {
    const delivery_plan: CoordinateDeliveryEntry[] = [];
    for (const agentName of resolvedAgents) {
      // trp#51: dispatch-time validation rejects unknown profiles,
      // non-spawnable agents, and missing invoke_binary. Caller gets a
      // specific error code instead of a silent skip, so automated
      // retry loops can react (e.g. fall back to a different agent).
      const check = validateAgentForDispatch(agentName, { requireSpawnable: true });
      if (!check.valid) {
        warnings.push(JSON.stringify({
          warning: 'agent_validation_failed',
          agent: agentName,
          code: check.code,
          reason: check.reason,
        }));
        continue;
      }
      // Ensure target agent is registered before creating claims/messages
      ensureAgentRegisteredForDispatch(agentName, dispatchCwd);
      const assignScope = req.scope ?? req.task;

      // Guard: warn if there is already a non-archived assign message for this agent+scope
      if (hasActiveAssignment(agentName, assignScope, dispatchCwd)) {
        warnings.push(JSON.stringify({
          warning: 'plan_already_assigned',
          plan_id: assignScope,
          existing_agent: agentName,
        }));
      }

      // Guard: warn if there is already an active claim on the same scope
      const conflictingClaims = listClaims(dispatchCwd).filter(
        (c) => c.status === 'active' && c.scope === assignScope,
      );
      if (conflictingClaims.length > 0) {
        const existing = conflictingClaims[0];
        warnings.push(JSON.stringify({
          warning: 'scope_already_claimed',
          scope: assignScope,
          existing_agent: existing.agent,
          existing_claim_id: existing.id,
        }));
      }

      const claimResult = createCoordinatorClaim({
        agent: agentName,
        scope: assignScope,
        description: req.task,
        dispatcherAgent: senderAgent,
        sessionId: connectionSessionId,
        cwd: dispatchCwd,
        // createCoordinatorClaim guarantees the worktree reflects this ref
        // (resets a stale branch / re-points a reused worktree) — see the
        // worktreeBaseRef invariant there (pln#520 Tier 2).
        worktreeBaseRef: req.ref,
      });
      const claimId = claimResult.claimId;
      if (claimResult.worktreeWarning) {
        warnings.push(claimResult.worktreeWarning);
      }
      artifacts.push({ type: 'claim', id: claimId });
      side_effects.push({
        action: claimResult.reusedExisting ? 'reuse' : 'create',
        entity: 'claim',
        id: claimId,
      });
      let assignmentId: string | undefined;
      try {
        const preId = generateAssignmentId(dispatchCwd);
        const assignment = createAssignment({
          id: preId.id,
          short_label: preId.short_label,
          claim_id: claimId,
          agent: agentName,
          dispatcher_agent: senderAgent,
          dispatcher_session_id: connectionSessionId,
          scope: assignScope,
          description: req.task,
          tags: ['coordinate', 'assign'],
        }, dispatchCwd);
        assignmentId = assignment.id;
        artifacts.push({ type: 'assignment', id: assignment.id });
      } catch (err) {
        warnings.push(`Assignment creation failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const assignBrief = buildCoordinateBrief(agentName, req.task, {
        claimId,
        scope: assignScope,
        worktreePath: claimResult.worktreePath,
        assignmentId,
      });
      const queued = queueCoordinateMessage({
        agent: agentName,
        text: assignBrief,
        messageType: 'assign',
        ref: assignScope,
        scope: assignScope,
        requiresAck: true,
        claimId,
        assignmentId,
        tags: ['coordinate', 'assign'],
        payload: {
          intent: req.intent,
          scope: assignScope,
          claim_id: claimId,
          ...(assignmentId ? { assignment_id: assignmentId } : {}),
          worktree_path: claimResult.worktreePath,
          constraints: req.constraints,
        },
        commandMode: 'worker',
      });
      if (assignmentId) {
        try {
          attachAssignmentMessageToClaim(claimId, queued.entry.message_id, dispatchCwd);
          linkClaimToAssignment(claimId, assignmentId, dispatchCwd);
          transitionAssignment(assignmentId, 'offered', { actor: senderAgent }, dispatchCwd);
          patchAssignmentMessageId(assignmentId, queued.entry.message_id, dispatchCwd);
          queued.entry.assignment_id = assignmentId;
        } catch (err) {
          warnings.push(`Assignment linkage failed for ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      delivery_plan.push(queued.entry);
      preparedInvokes.push({ entry: queued.entry, invoke: queued.invoke, worktreePath: claimResult.worktreePath });
    }

    // E2E execution phase: attempt to spawn assigned agents
    const overallExecStatus = await runCoordinateExecution(preparedInvokes, {
      autoExecute: effectiveAutoExecute !== false,
      senderAgent, senderAgentId, cwd: dispatchCwd, warnings,
    });

    result = {
      selected_targets: resolvedAgents,
      delivery_plan,
      messages_sent: toMessageSummary(delivery_plan),
      commands: commandHints,
      execution_status: overallExecStatus,
    };

  } else if (req.intent === 'consult') {
    // pln#626 Phase 1 — consult is inbox-only by design: it delivers an RFC to
    // the target inbox(es) and never spawns. autoExecute is a no-op here, so
    // say so explicitly rather than silently ignoring a caller who set it.
    if (req.autoExecute === true) {
      warnings.push(
        "autoExecute has no effect on intent='consult': consult delivers the RFC to the target inbox(es) only and never spawns an agent — targets pick it up via their own bclaw_work. For real spawning use bclaw_dispatch(intent='execute') on a sequence, or intent='assign'/'review' (pln#626).",
      );
    }
    const consultThreadId = req.threadId ?? `thread_${crypto.randomBytes(4).toString('hex')}`;
    const contacted: string[] = [];
    const delivery_plan: CoordinateDeliveryEntry[] = [];
    for (const agentName of resolvedAgents) {
      const profile = getCapabilityProfile(agentName);
      if (!profile) {
        warnings.push(`Unknown agent profile: ${agentName}`);
        continue;
      }
      delivery_plan.push(queueCoordinateMessage({
        agent: agentName,
        text: req.task,
        messageType: 'rfc',
        scope: req.scope,
        threadId: consultThreadId,
        tags: ['coordinate', 'consult'],
        payload: {
          intent: req.intent,
          scope: req.scope,
          constraints: req.constraints,
        },
        commandMode: 'consult',
      }).entry);
      contacted.push(agentName);
    }
    result = {
      selected_targets: resolvedAgents,
      contacted,
      thread_id: consultThreadId,
      delivery_plan,
      messages_sent: toMessageSummary(delivery_plan),
      commands: commandHints,
      // pln#626 Phase 1 — consult is inbox-only, so it reports that honestly
      // instead of omitting execution_status (which read as "maybe it spawned").
      execution_status: 'inbox_only',
      execution_reason: 'intent_inbox_only',
    };

  } else if (req.intent === 'review') {
    // Cap the implicit fan-out so that omitting `targetAgents` on an
    // open_loop review doesn't mint a loop with a reviewer slot per
    // spawnable agent. The cap only applies to the implicit case —
    // callers who explicitly list targetAgents get the full list.
    const REVIEW_OPEN_LOOP_FANOUT_CAP = 3;
    const implicitFanout = !(req.targetAgents && req.targetAgents.length > 0);
    let loopReviewerAgents = resolvedAgents;
    const preReviewWarnings: string[] = [];
    if (req.open_loop === true && implicitFanout && resolvedAgents.length > REVIEW_OPEN_LOOP_FANOUT_CAP) {
      loopReviewerAgents = resolvedAgents.slice(0, REVIEW_OPEN_LOOP_FANOUT_CAP);
      preReviewWarnings.push(
        `open_loop: implicit reviewer fan-out capped at ${REVIEW_OPEN_LOOP_FANOUT_CAP} of ${resolvedAgents.length} spawnable agents; pass targetAgents to override`,
      );
    }

    // pln#533 — pre-flight the reviewer agents with a trivial validation
    // spawn BEFORE opening the loop, so an environment death (config
    // rejected, auth fail, model mismatch) surfaces instantly with a clear
    // reason instead of a generic "did not acknowledge" loop timeout. Drop
    // the agents that fail and surface their reasons; if none survive the
    // existing length===0 guard skips loop creation. Skipped when open_loop
    // is off, preflight=false, or BRAINCLAW_NO_SPAWN is set (handled inside
    // preflightAgents). Cross-project dispatch never auto-spawns, so skip.
    if (req.open_loop === true && req.preflight !== false && !req.project && loopReviewerAgents.length > 0) {
      try {
        const { preflightAgents } = await import('../core/spawn-check.js');
        const pf = await preflightAgents(loopReviewerAgents, { cwd: dispatchCwd });
        if (pf.blocked.length > 0) {
          const healthy = loopReviewerAgents.filter((a) => !pf.blocked.some((b) => b.agent === a));
          for (const b of pf.blocked) {
            preReviewWarnings.push(
              `pre-flight: dropped reviewer '${b.agent}' — ${b.reason}.${b.recommended_next_action ? ` ${b.recommended_next_action}` : ''}`,
            );
          }
          loopReviewerAgents = healthy;
        }
      } catch (pfErr) {
        // Pre-flight is best-effort: a failure here must not block the review.
        preReviewWarnings.push(`pre-flight: skipped (check threw: ${pfErr instanceof Error ? pfErr.message : String(pfErr)})`);
      }
    }

    type ReviewOutput = {
      candidateId: string;
      loopId?: string;
      artifacts: Array<{ type: string; id: string; path?: string }>;
      sideEffects: Array<{ action: string; entity: string; id: string }>;
      warnings: string[];
      partial: boolean;
      // pln#458 stp_daffa477: invokes prepared under the lock but spawned
      // outside it so runCoordinateExecution (async) doesn't block the
      // idempotency window.
      preparedReviews: PreparedInvoke[];
    };

    // Lazy-import the loops module once before defining performReview so
    // the synchronous withLoopLock work callback can use it without
    // re-importing inside the callback.
    const loopsModuleRef = await import('../core/loops/index.js');

    const performReview = (): ReviewOutput => {
      const out: ReviewOutput = {
        candidateId: '',
        artifacts: [],
        sideEffects: [],
        warnings: [...preReviewWarnings],
        partial: false,
        preparedReviews: [],
      };

      const candId = generateCandidateIdWithLabel(dispatchCwd);
      saveCandidate({
        id: candId.id,
        short_label: candId.short_label,
        type: 'handoff',
        text: req.task,
        created_at: nowISO(),
        author: senderAgent,
        author_id: senderAgentId,
        tags: ['review'],
        status: 'pending',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
        ...(req.scope ? { related_paths: [req.scope] } : {}),
      }, dispatchCwd);
      out.candidateId = candId.id;
      out.artifacts.push({ type: 'candidate', id: candId.id });
      out.sideEffects.push({ action: 'create', entity: 'candidate', id: candId.id });

      if (req.open_loop === true && loopReviewerAgents.length === 0) {
        out.warnings.push('open_loop: no reviewer targets resolved; skipped loop creation — candidate preserved');
        return out;
      }
      if (req.open_loop !== true) {
        return out;
      }

      try {
        const { openLoop, add_artifact, advance, turn } = loopsModuleRef;
        const senderIdentity = (
          (senderAgentId ? findAgentIdentityById(senderAgentId, dispatchCwd) : undefined)
          ?? findAgentIdentityByName(senderAgent, dispatchCwd)
          ?? ensureAgentRegisteredForDispatch(senderAgent, dispatchCwd)
        );
        const authorAgentId = senderIdentity?.agent_id ?? senderAgentId;
        const creatorActor = authorAgentId ?? senderAgent;
        const slots = [
          {
            role: 'author',
            agent: senderAgent,
            ...(authorAgentId ? { agent_id: authorAgentId } : {}),
          },
          ...loopReviewerAgents.map((agent) => {
            const reviewerIdentity = findAgentIdentityByName(agent, dispatchCwd) ?? ensureAgentRegisteredForDispatch(agent, dispatchCwd);
            return {
              role: 'reviewer',
              agent,
              ...(reviewerIdentity?.agent_id ? { agent_id: reviewerIdentity.agent_id } : {}),
            };
          }),
        ];
        const loop = openLoop(
          {
            kind: 'review',
            title: req.task.slice(0, 120),
            created_by: creatorActor,
            slots,
            mode: req.review_mode ?? 'asymmetric',
          },
          dispatchCwd,
        );
        out.loopId = loop.id;
        out.artifacts.push({ type: 'loop', id: loop.id });
        out.sideEffects.push({ action: 'create', entity: 'loop', id: loop.id });

        add_artifact(
          {
            id: loop.id,
            actor: creatorActor,
            artifact: {
              phase: 'change_summary',
              type: 'change_summary',
              ref: { kind: 'candidate', id: candId.id },
            },
          },
          dispatchCwd,
        );

        const advanced = advance(
          { id: loop.id, actor: creatorActor },
          dispatchCwd,
        );
        const reviewerSlots = advanced.loop.slots.filter((s) => s.role === 'reviewer');
        for (const slot of reviewerSlots) {
          // pln#458 stp_daffa477: turn() is pure state mutation — it does
          // NOT spawn the reviewer. Without the linkage below, the loop
          // stays "assigned" forever and no work ever runs (symptom
          // observed on lop_0a0cb84a7bf8dd92). Build the same claim +
          // assignment + queued message chain as intent=assign so that
          // the downstream runCoordinateExecution actually spawns.
          // pln#628 Focus 4B (Codex review of #87, BLOCKING 2): turn() is now
          // called AFTER the claim + assignment exist so the reviewer slot is
          // BOUND to its assignment_id/claim_id. Previously turn() ran first with
          // no ids, so a harvest could only match reviewer slots by agent name —
          // which completes the WRONG slot in symmetric (multi-reviewer) mode.
          try {
            const reviewScope = `review-loop:${loop.id}`;
            const reviewDescription =
              `Review loop turn for ${loop.id} slot ${slot.slot_id} phase findings. `
              + `Mode: ${advanced.loop.protocol?.review_mode ?? 'asymmetric'}. ${req.task}`;
            const claimResult = createCoordinatorClaim({
              agent: slot.agent ?? '',
              scope: reviewScope,
              description: reviewDescription,
              dispatcherAgent: senderAgent,
              sessionId: connectionSessionId,
              cwd: dispatchCwd,
              worktreeBaseRef: req.ref,
            });
            if (claimResult.worktreeWarning) out.warnings.push(claimResult.worktreeWarning);
            out.artifacts.push({ type: 'claim', id: claimResult.claimId });
            out.sideEffects.push({
              action: claimResult.reusedExisting ? 'reuse' : 'create',
              entity: 'claim',
              id: claimResult.claimId,
            });

            let reviewAssignmentId: string | undefined;
            try {
              const preId = generateAssignmentId(dispatchCwd);
              const assignment = createAssignment({
                id: preId.id,
                short_label: preId.short_label,
                claim_id: claimResult.claimId,
                agent: slot.agent ?? '',
                dispatcher_agent: senderAgent,
                dispatcher_session_id: connectionSessionId,
                scope: reviewScope,
                description: reviewDescription,
                tags: ['coordinate', 'review', 'loop'],
              }, dispatchCwd);
              reviewAssignmentId = assignment.id;
              out.artifacts.push({ type: 'assignment', id: assignment.id });
            } catch (asgErr) {
              out.warnings.push(
                `Review assignment creation failed for slot ${slot.slot_id}: ${asgErr instanceof Error ? asgErr.message : String(asgErr)}`,
              );
            }

            // pln#628 Focus 4B (BLOCKING 2) — assign the slot NOW that the
            // claim/assignment exist, binding their ids onto the slot so the
            // harvest close resolves this exact reviewer by assignment_id. Runs
            // even if assignment creation failed (undefined id → the harvest
            // falls back to the legacy agent match for this one slot).
            turn(
              {
                id: loop.id,
                slot_id: slot.slot_id,
                actor: creatorActor,
                input: req.task,
                assignment_id: reviewAssignmentId,
                claim_id: claimResult.claimId,
              },
              dispatchCwd,
            );

            const reviewBrief = buildCoordinateBrief(slot.agent ?? '', reviewDescription + reviewVerdictBriefSuffix, {
              claimId: claimResult.claimId,
              scope: reviewScope,
              worktreePath: claimResult.worktreePath,
              assignmentId: reviewAssignmentId,
            });
            const queued = queueCoordinateMessage({
              agent: slot.agent ?? '',
              text: reviewBrief,
              messageType: 'review',
              ref: loop.id,
              scope: reviewScope,
              requiresAck: true,
              claimId: claimResult.claimId,
              assignmentId: reviewAssignmentId,
              tags: ['coordinate', 'review', 'loop'],
              payload: {
                intent: 'review',
                loop_id: loop.id,
                slot_id: slot.slot_id,
                phase: 'findings',
                scope: reviewScope,
                claim_id: claimResult.claimId,
                ...(reviewAssignmentId ? { assignment_id: reviewAssignmentId } : {}),
                worktree_path: claimResult.worktreePath,
              },
              commandMode: 'worker',
            });

            if (reviewAssignmentId) {
              try {
                attachAssignmentMessageToClaim(claimResult.claimId, queued.entry.message_id, dispatchCwd);
                linkClaimToAssignment(claimResult.claimId, reviewAssignmentId, dispatchCwd);
                transitionAssignment(reviewAssignmentId, 'offered', { actor: senderAgent }, dispatchCwd);
                patchAssignmentMessageId(reviewAssignmentId, queued.entry.message_id, dispatchCwd);
                queued.entry.assignment_id = reviewAssignmentId;
              } catch (linkErr) {
                out.warnings.push(
                  `Review assignment linkage failed for ${reviewAssignmentId}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`,
                );
              }
            }

            out.preparedReviews.push({
              entry: queued.entry,
              invoke: queued.invoke,
              worktreePath: claimResult.worktreePath,
            });
          } catch (dispatchErr) {
            out.partial = true;
            out.warnings.push(
              `open_loop: reviewer dispatch linkage failed for slot ${slot.slot_id} (${dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)}); loop remains open without spawn`,
            );
          }
        }
      } catch (loopErr: unknown) {
        out.partial = true;
        const loopErrMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
        out.warnings.push(`open_loop: failed to open review loop (${loopErrMsg}); candidate ${out.candidateId} still created`);
      }
      return out;
    };

    const useIdempotency = Boolean(req.client_request_id && senderAgentId && req.open_loop === true);
    let output: ReviewOutput;
    try {
      if (useIdempotency) {
        const { client_request_id: _crid, ...hashablePayload } = req;
        output = loopsModuleRef.withLoopLock<ReviewOutput>({
          cwd: dispatchCwd,
          intent: 'coordinate_review',
          agentId: senderAgentId!,
          scope: { kind: 'open_idempotency', clientRequestId: req.client_request_id! },
          clientRequestId: req.client_request_id!,
          requestPayload: hashablePayload,
          work: () => performReview(),
        });
      } else {
        output = performReview();
      }
    } catch (err: unknown) {
      if (err instanceof loopsModuleRef.IdempotencyKeyReusedError) {
        return {
          response: createToolErrorResponse(
            'idempotency_key_reused_with_different_body',
            err.message,
            { stored_hash: err.storedHash, submitted_hash: err.submittedHash },
          ),
        };
      }
      throw err;
    }

    artifacts.push(...output.artifacts);
    side_effects.push(...output.sideEffects);
    warnings.push(...output.warnings);
    if (output.partial) facadeStatus = 'partial';

    // pln#458 stp_daffa477: spawn reviewers OUTSIDE the idempotency lock
    // so the async spawn work doesn't widen the critical section. Skipped
    // when there's nothing to spawn (no open_loop, or no reviewer slots).
    let reviewExecStatus: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only' | undefined;
    if (output.preparedReviews.length > 0) {
      reviewExecStatus = await runCoordinateExecution(output.preparedReviews, {
        autoExecute: effectiveAutoExecute !== false,
        senderAgent, senderAgentId, cwd: dispatchCwd, warnings,
      });
    }

    result = {
      candidate_id: output.candidateId,
      selected_targets: resolvedAgents,
      // pln#626 Phase 1 (review rework) — expose the reviewer delivery entries
      // so review is as honest as assign/reroute: each entry's execution_reason
      // (set by runCoordinateExecution) feeds the top-level derivation, so a
      // manual (autoExecute=false) open_loop review no longer hides WHY it
      // didn't spawn. Empty when there was nothing to dispatch (plain review).
      delivery_plan: output.preparedReviews.map((p) => p.entry),
      ...(output.loopId ? { loop_id: output.loopId } : {}),
      ...(reviewExecStatus ? { execution_status: reviewExecStatus } : {}),
    };

  } else if (req.intent === 'reroute') {
    const activeClaims = listClaims(dispatchCwd).filter(
      (c) => c.status === 'active' && (req.scope ? c.scope === req.scope : true),
    );
    if (activeClaims.length === 0) {
      return { response: createToolErrorResponse('not_found', `No active claim found for scope: ${req.scope ?? '(any)'}`) };
    }
    const oldClaim = activeClaims[0];
    saveClaim({ ...oldClaim, status: 'released' as const, released_at: nowISO() }, dispatchCwd);
    appendAuditEntry({ actor: oldClaim.agent, action: 'release_claim', item_id: oldClaim.id, item_type: 'claim', scope: oldClaim.scope }, dispatchCwd);
    side_effects.push({ action: 'release', entity: 'claim', id: oldClaim.id });

    // trp#61: supersede assignments attached to the old claim so they
    // don't linger in `created`/`offered`/etc. Prior behaviour only
    // released the claim, leaving the assignment FSM stuck and confusing
    // dispatch analysis / review.
    const { listAssignments: listAsgn } = await import('../core/assignments.js');
    const predecessors = listAsgn(dispatchCwd, { claim_id: oldClaim.id })
      .filter((a) => a.status !== 'completed' && a.status !== 'cancelled' && a.status !== 'expired' && a.status !== 'rerouted');
    for (const predecessor of predecessors) {
      try {
        transitionAssignment(predecessor.id, 'rerouted', {
          actor: senderAgent,
          status_reason: `reroute: claim ${oldClaim.id} reassigned`,
        }, dispatchCwd);
        side_effects.push({ action: 'update', entity: 'assignment', id: predecessor.id });
      } catch (err) {
        warnings.push(`Failed to close predecessor assignment ${predecessor.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const newAgentName = resolvedAgents.find((a) => a !== oldClaim.agent) ?? resolvedAgents[0];
    let newClaimId: string | undefined;
    if (newAgentName) {
      // trp#51: validate target agent before creating a new claim.
      const check = validateAgentForDispatch(newAgentName, { requireSpawnable: true });
      if (!check.valid) {
        warnings.push(JSON.stringify({
          warning: 'agent_validation_failed',
          agent: newAgentName,
          code: check.code,
          reason: check.reason,
        }));
      }
      const profile = check.profile;
      if (check.valid && profile) {
        ensureAgentRegisteredForDispatch(newAgentName, dispatchCwd);
        const rerouteClaimResult = createCoordinatorClaim({
          agent: newAgentName,
          scope: oldClaim.scope,
          description: req.task,
          dispatcherAgent: senderAgent,
          sessionId: connectionSessionId,
          cwd: dispatchCwd,
          worktreeBaseRef: req.ref,
        });
        newClaimId = rerouteClaimResult.claimId;
        if (rerouteClaimResult.worktreeWarning) {
          warnings.push(rerouteClaimResult.worktreeWarning);
        }
        artifacts.push({ type: 'claim', id: newClaimId });
        side_effects.push({
          action: rerouteClaimResult.reusedExisting ? 'reuse' : 'create',
          entity: 'claim',
          id: newClaimId,
        });
        let rerouteAssignmentId: string | undefined;
        try {
          const preId = generateAssignmentId(dispatchCwd);
          const assignment = createAssignment({
            id: preId.id,
            short_label: preId.short_label,
            claim_id: newClaimId,
            agent: newAgentName,
            dispatcher_agent: senderAgent,
            dispatcher_session_id: connectionSessionId,
            scope: oldClaim.scope,
            description: req.task,
            tags: ['coordinate', 'assign', 'reroute'],
          }, dispatchCwd);
          rerouteAssignmentId = assignment.id;
          artifacts.push({ type: 'assignment', id: assignment.id });
        } catch (err) {
          warnings.push(`Assignment creation failed for ${newAgentName}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const rerouteBrief = buildCoordinateBrief(newAgentName, req.task, {
          claimId: newClaimId,
          scope: oldClaim.scope,
          worktreePath: rerouteClaimResult.worktreePath,
          assignmentId: rerouteAssignmentId,
        });
        const delivery_plan: CoordinateDeliveryEntry[] = [];
        const reroutePrepared: PreparedInvoke[] = [];
        const queued = queueCoordinateMessage({
          agent: newAgentName,
          text: rerouteBrief,
          messageType: 'assign',
          ref: oldClaim.scope,
          scope: oldClaim.scope,
          requiresAck: true,
          claimId: newClaimId,
          assignmentId: rerouteAssignmentId,
          releasedClaimId: oldClaim.id,
          tags: ['coordinate', 'assign', 'reroute'],
          payload: {
            intent: req.intent,
            scope: oldClaim.scope,
            claim_id: newClaimId,
            ...(rerouteAssignmentId ? { assignment_id: rerouteAssignmentId } : {}),
            worktree_path: rerouteClaimResult.worktreePath,
            released_claim_id: oldClaim.id,
            previous_agent: oldClaim.agent,
            constraints: req.constraints,
          },
          commandMode: 'worker',
        });
        if (rerouteAssignmentId) {
          try {
            attachAssignmentMessageToClaim(newClaimId, queued.entry.message_id, dispatchCwd);
            linkClaimToAssignment(newClaimId, rerouteAssignmentId, dispatchCwd);
            transitionAssignment(rerouteAssignmentId, 'offered', { actor: senderAgent }, dispatchCwd);
            patchAssignmentMessageId(rerouteAssignmentId, queued.entry.message_id, dispatchCwd);
            queued.entry.assignment_id = rerouteAssignmentId;
          } catch (err) {
            warnings.push(`Assignment linkage failed for ${newAgentName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        delivery_plan.push(queued.entry);
        reroutePrepared.push({ entry: queued.entry, invoke: queued.invoke, worktreePath: rerouteClaimResult.worktreePath });

        const rerouteExecStatus = await runCoordinateExecution(reroutePrepared, {
          autoExecute: effectiveAutoExecute !== false,
          senderAgent, senderAgentId, cwd: dispatchCwd, warnings,
        });

        result = {
          released_claim: oldClaim.id,
          old_agent: oldClaim.agent,
          new_agent: newAgentName,
          new_claim_id: newClaimId,
          selected_targets: resolvedAgents,
          delivery_plan,
          messages_sent: toMessageSummary(delivery_plan),
          commands: commandHints,
          execution_status: rerouteExecStatus,
        };
      } else {
        warnings.push(`Unknown agent profile: ${newAgentName}`);
      }
    }
    if (!('released_claim' in (result as Record<string, unknown>))) {
      result = {
        released_claim: oldClaim.id,
        old_agent: oldClaim.agent,
        new_agent: newAgentName,
        new_claim_id: newClaimId,
        selected_targets: resolvedAgents,
        delivery_plan: [],
        messages_sent: [],
        commands: commandHints,
      };
    }

  } else if (req.intent === 'summarize') {
    const threadId = req.threadId ?? req.scope;
    if (!threadId) {
      return { response: createToolErrorResponse('validation_error', 'summarize intent requires threadId or scope') };
    }
    const messages = getThread(threadId, dispatchCwd, { truncateText: 500 });
    const summary = messages.length === 0
      ? 'No messages found in thread.'
      : messages.map((m, i) => `[${i + 1}] ${m.from} → ${m.to}: ${m.text}`).join('\n');
    result = { thread_id: threadId, message_count: messages.length, summary };

  } else if (req.intent === 'ideate') ideate: {
    // pln#626 Phase 2 — multi-agent ideate now SPAWNS its critics as
    // worktree-isolated workers (Option B), so autoExecute IS honored on that
    // path (no longer a no-op). Single-agent / bootstrap ideate still opens the
    // loop for manual driving — covered by the "champion drives manually" and
    // "joined existing" warnings below, so no blanket no-op warning here.
    // pln#492 phase 2.c (open + proposal) + 2.d.2 (multi-agent dispatch).
    // Single-agent mode (no targetAgents): open the loop with the task
    // as a proposal seed and stop there — the champion drives manually
    // via bclaw_loop intent='turn' / 'advance'. Multi-agent mode
    // (targetAgents passed): also advance to critique and dispatch a
    // turn to each critic slot with a context-filtered, BM25-ranked,
    // size-capped brief assembled by buildIdeationBrief.
    //
    // pln#511 step 2 — when `req.preset` is set, the loop opens with
    // the preset's phases / stop_condition / protocol instead of the
    // kind-default ideation chain. Bootstrap preset enforces single-
    // agent / self-champion mode (validated above), so the multi-
    // agent dispatch branch never runs for it.
    //
    // pln#513 step 2 — labelled block (ideate:) so the bootstrap
    // join-or-lock path can break out early after assigning result.
    const loopsModuleRef = await import('../core/loops/index.js');
    const { openLoop, add_artifact, advance, turn, getLoop, buildIdeationBrief } = loopsModuleRef;
    const presetSelected = req.preset
      ? (await import('../core/loops/presets/index.js')).PRESETS[req.preset]
      : undefined;

    // pln#513 step 2 — bootstrap join-or-lock. The bootstrap preset is
    // project-singleton: two concurrent callers must converge on the same
    // loop rather than open duplicates. Strategy:
    //   1. Find existing bootstrap loop in {open, paused} → join.
    //   2. Else check for an active coordination claim (someone is
    //      mid-open). Re-find once; surface bootstrap_coordination_in_progress
    //      if still nothing.
    //   3. Else acquire the lock, fall through to the normal open path,
    //      release the lock on the way out (success or fail).
    // The lock is opportunistic, not blocking — a fast retry-in-place
    // not a wait-on-mutex. Keeps the verb short and predictable.
    // pln#518 step 1 — bootstrap join-or-lock now delegates to the shared
    // acquireBootstrapLoop helper (src/core/loops/bootstrap-acquire.ts).
    // Both the CLI and this MCP handler converge on the same singleton
    // acquire path, eliminating the race where two concurrent callers both
    // passed the local scan and called openLoop directly.
    const senderIdentity = (
      (senderAgentId ? findAgentIdentityById(senderAgentId, dispatchCwd) : undefined)
      ?? findAgentIdentityByName(senderAgent, dispatchCwd)
      ?? ensureAgentRegisteredForDispatch(senderAgent, dispatchCwd)
    );
    const authorAgentId = senderIdentity?.agent_id ?? senderAgentId;
    const creatorActor = authorAgentId ?? senderAgent;
    let bootstrapOpenedLoop: LoopThread | undefined;
    if (req.preset === 'bootstrap') {
      const { acquireBootstrapLoop, BootstrapCoordinationInProgressError: BcipError } =
        await import('../core/loops/bootstrap-acquire.js');
      let acqResult: Awaited<ReturnType<typeof acquireBootstrapLoop>>;
      try {
        acqResult = acquireBootstrapLoop(
          {
            actor: senderAgent,
            agent_id: authorAgentId,
            created_by: creatorActor,
            title: req.task.slice(0, 120),
            goal: req.scope,
            model: currentModel,
          },
          dispatchCwd,
        );
      } catch (err) {
        if (err instanceof BcipError) {
          return {
            response: createToolErrorResponse(
              'bootstrap_coordination_in_progress',
              err.message,
            ),
          };
        }
        throw err;
      }
      warnings.push(...acqResult.warnings);
      if (acqResult.action === 'joined') {
        const jLoop = acqResult.loop;
        artifacts.push({ type: 'loop', id: jLoop.id });
        result = {
          loop_id: jLoop.id,
          joined_existing: true,
          current_phase: jLoop.current_phase,
          status: jLoop.status,
          mode: 'single_agent',
          preset: req.preset,
          // pln#626 Phase 1 — report inbox_only even on the join early-return,
          // so this path is not the one silent hole in the contract (R1).
          execution_status: 'inbox_only',
          execution_reason: 'intent_inbox_only',
        };
        // Skip the rest of the ideate flow — we joined an existing loop.
        break ideate;
      }
      // action === 'opened': helper already called openLoop + released lock.
      bootstrapOpenedLoop = acqResult.loop;
    }

    // pln#511 step 2 — bootstrap preset always runs in single-agent
    // mode: the champion drives the whole loop. Even when the caller
    // passes targetAgents=[caller] (validated as the only legal non-
    // empty form), we don't add critic slots and we don't take the
    // multi-agent dispatch branch. Treating that idiom as "single
    // agent / self-champion" matches what the constraint check
    // already enforced upstream.
    const explicitTargets = Boolean(
      req.targetAgents
      && req.targetAgents.length > 0
      && req.preset !== 'bootstrap',
    );
    const slots: Array<{ role: string; agent: string; agent_id?: string }> = [
      {
        role: 'champion',
        agent: senderAgent,
        ...(authorAgentId ? { agent_id: authorAgentId } : {}),
      },
    ];
    if (explicitTargets) {
      for (const agent of req.targetAgents!) {
        const criticIdentity = findAgentIdentityByName(agent, dispatchCwd) ?? ensureAgentRegisteredForDispatch(agent, dispatchCwd);
        slots.push({
          role: 'critic',
          agent,
          ...(criticIdentity?.agent_id ? { agent_id: criticIdentity.agent_id } : {}),
        });
      }
    }

    let loopId: string;
    let proposalArtifactId: string | undefined;
    if (bootstrapOpenedLoop) {
      // Bootstrap case: helper already opened the loop and released its lock.
      loopId = bootstrapOpenedLoop.id;
      artifacts.push({ type: 'loop', id: bootstrapOpenedLoop.id });
      side_effects.push({ action: 'create', entity: 'loop', id: bootstrapOpenedLoop.id });
    } else {
    try {
      const loop = openLoop(
        {
          kind: 'ideation',
          title: req.task.slice(0, 120),
          goal: req.scope,
          created_by: creatorActor,
          slots,
          ...(presetSelected
            ? {
                phases: presetSelected.phases,
                stop_condition: presetSelected.stop_condition,
                protocol: presetSelected.protocol,
              }
            : {}),
        },
        dispatchCwd,
      );
      loopId = loop.id;
      artifacts.push({ type: 'loop', id: loop.id });
      side_effects.push({ action: 'create', entity: 'loop', id: loop.id });

      // pln#511 step 2 — skip the proposal-seed artifact when a preset
      // is in use. The kind-default ideation chain opens at phase
      // 'proposal' and the seed artifact lives there; presets define
      // their own initial phase + seeding semantics (bootstrap starts
      // at 'survey' and produces a signals_report). Forcing a
      // 'proposal'-phased artifact here would dangle on a phase the
      // loop doesn't contain. The task text is already captured on
      // the thread (title + goal).
      if (!presetSelected) {
        const proposalBody = req.task.slice(0, 4000);
        const updated = add_artifact(
          {
            id: loop.id,
            actor: creatorActor,
            artifact: {
              phase: 'proposal',
              type: 'proposal',
              body: proposalBody,
              produced_by: creatorActor,
            },
          },
          dispatchCwd,
        );
        const lastArtifact = updated.artifacts[updated.artifacts.length - 1];
        proposalArtifactId = lastArtifact?.artifact_id;
        if (proposalArtifactId) {
          artifacts.push({ type: 'artifact', id: proposalArtifactId });
          side_effects.push({ action: 'create', entity: 'artifact', id: proposalArtifactId });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        response: createToolErrorResponse(
          'ideate_failed',
          `ideate intent: failed to open ideation loop — ${msg}`,
        ),
      };
    }
    } // end else (non-bootstrap open path)

    // pln#492 phase 2.d.2 — multi-agent dispatch. Skipped in single-
    // agent mode (the champion drives manually).
    //
    // pln#511 step 2 — initial phase comes from the actual loop's
    // first phase, not a hardcoded 'proposal'. Presets like bootstrap
    // open at 'survey'; the kind-default ideation chain still opens
    // at 'proposal', so this is backward compatible.
    let dispatchedCritics = 0;
    let dispatchedPhase = presetSelected ? presetSelected.phases[0].name : 'proposal';
    // pln#626 Phase 2 (Option B) — prepared invokes for the critic spawn, run
    // through runCoordinateExecution after the loop (mirrors intent=assign).
    const preparedCritics: PreparedInvoke[] = [];
    let ideateExecStatus: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only' | undefined;
    if (explicitTargets) {
      try {
        // Build a search-backed BriefMemoryProvider. Maps user-facing
        // memory categories the brief asks for onto src/core/search.ts
        // sections (BM25 there). Loop-internal categories
        // (critique_history / revision_history / synthesis_artifact)
        // are pulled by the assembler from the thread directly.
        const searchModule = await import('../core/search.js');
        const sectionByCategory: Partial<Record<LoopContextCategory, string>> = {
          traps: 'traps',
          decisions: 'decisions',
          constraints: 'constraints',
          handoffs: 'handoffs',
          plans: 'plans',
          candidates: 'candidates',
        };
        const provider: BriefMemoryProvider = {
          fetch(category, query, topK) {
            const section = sectionByCategory[category];
            if (!section) return [];
            const results = searchModule.search({
              query,
              section,
              maxResults: topK,
              cwd: dispatchCwd,
              includePending: section === 'candidates',
            });
            return results.map((r) => ({
              id: r.id,
              category,
              text: r.text,
              score: r.score,
            }));
          },
        };

        // Advance proposal → critique. proposal has no advance_gate so
        // this is unconditional. After advance, the loop sits at the
        // critique phase ready for critic turns.
        advance({ id: loopId, actor: creatorActor }, dispatchCwd);
        const advancedLoop = getLoop(loopId, dispatchCwd);
        if (!advancedLoop) {
          throw new Error('ideate dispatch: loop disappeared after advance');
        }
        dispatchedPhase = advancedLoop.current_phase;

        const criticSlots = advancedLoop.slots.filter((s) => s.role === 'critic');
        for (const slot of criticSlots) {
          if (!slot.agent) continue;
          // pln#626 Phase 2 — validate the target BEFORE any claim/worktree churn
          // (mirrors intent=assign). A typo'd or non-spawnable critic is skipped
          // with a clear warning instead of leaving a claim+worktree+assignment
          // behind that only fails later at spawn time.
          const critCheck = validateAgentForDispatch(slot.agent, { requireSpawnable: true });
          if (!critCheck.valid) {
            warnings.push(JSON.stringify({
              warning: 'agent_validation_failed',
              agent: slot.agent,
              code: critCheck.code,
              reason: critCheck.reason,
            }));
            continue;
          }
          const briefResult = buildIdeationBrief({
            thread: advancedLoop,
            slotRole: slot.role,
            memoryProvider: provider,
          });

          turn(
            {
              id: loopId,
              slot_id: slot.slot_id,
              actor: creatorActor,
              input: briefResult.text,
            },
            dispatchCwd,
          );

          // pln#626 Phase 2 (Option B) — spawn the critic as a worktree-isolated
          // worker, mirroring the intent=assign / review chain. Each critic gets
          // its OWN claim + worktree (scope is unique per slot) so parallel
          // critics never share a checkout. The ideation brief is wrapped in the
          // coordinate envelope (assignment header + ack instructions) so a
          // spawned critic — even one without brainclaw MCP wired — can ack and
          // reply. The brief instructs critique-only; the worktree makes any
          // stray edit harmless (it lands in the throwaway checkout, not master).
          const criticScope = `ideate-loop:${loopId}:${slot.slot_id}`;
          const criticDescription =
            `Ideation critic turn for loop ${loopId} slot ${slot.slot_id} (phase ${advancedLoop.current_phase}). `
            + `Critique the proposal and reply with your critique — do not edit code. ${req.task}`;
          try {
            const claimResult = createCoordinatorClaim({
              agent: slot.agent,
              scope: criticScope,
              description: criticDescription,
              dispatcherAgent: senderAgent,
              sessionId: connectionSessionId,
              cwd: dispatchCwd,
              worktreeBaseRef: req.ref,
            });
            if (claimResult.worktreeWarning) warnings.push(claimResult.worktreeWarning);
            artifacts.push({ type: 'claim', id: claimResult.claimId });
            side_effects.push({
              action: claimResult.reusedExisting ? 'reuse' : 'create',
              entity: 'claim',
              id: claimResult.claimId,
            });

            let criticAssignmentId: string | undefined;
            try {
              const preId = generateAssignmentId(dispatchCwd);
              const assignment = createAssignment({
                id: preId.id,
                short_label: preId.short_label,
                claim_id: claimResult.claimId,
                agent: slot.agent,
                dispatcher_agent: senderAgent,
                dispatcher_session_id: connectionSessionId,
                scope: criticScope,
                description: criticDescription,
                tags: ['coordinate', 'ideate', 'loop'],
              }, dispatchCwd);
              criticAssignmentId = assignment.id;
              artifacts.push({ type: 'assignment', id: assignment.id });
            } catch (asgErr) {
              warnings.push(
                `ideate assignment creation failed for slot ${slot.slot_id}: ${asgErr instanceof Error ? asgErr.message : String(asgErr)}`,
              );
            }

            // pln#626 Phase 2 — the critique-only contract must reach the
            // DELIVERED brief, not just the claim record: buildCoordinateBrief
            // wraps this in a worker envelope, so prepend the constraint + the
            // reply path (MCP complete_turn, or LANE-RESULT.json for a sandboxed
            // critic without brainclaw MCP) ahead of the ideation brief body.
            const criticTaskText =
              `CRITIQUE-ONLY TASK — do NOT edit code or commit. Read the proposal below and reply with your critique: `
              + `call bclaw_loop(intent='complete_turn') if you have brainclaw MCP, otherwise write your critique to LANE-RESULT.json in your worktree root (the coordinator harvests it).\n\n`
              + briefResult.text;
            const criticBrief = buildCoordinateBrief(slot.agent, criticTaskText, {
              claimId: claimResult.claimId,
              scope: criticScope,
              worktreePath: claimResult.worktreePath,
              assignmentId: criticAssignmentId,
            });
            const queued = queueCoordinateMessage({
              agent: slot.agent,
              text: criticBrief,
              messageType: 'rfc',
              ref: loopId,
              scope: criticScope,
              requiresAck: true,
              claimId: claimResult.claimId,
              assignmentId: criticAssignmentId,
              tags: ['coordinate', 'ideate', 'loop'],
              payload: {
                intent: 'ideate',
                loop_id: loopId,
                slot_id: slot.slot_id,
                phase: advancedLoop.current_phase,
                iteration: advancedLoop.iteration_count,
                proposal_artifact_id: proposalArtifactId,
                ...(criticAssignmentId ? { assignment_id: criticAssignmentId } : {}),
                worktree_path: claimResult.worktreePath,
              },
              commandMode: 'worker',
            });

            if (criticAssignmentId) {
              try {
                attachAssignmentMessageToClaim(claimResult.claimId, queued.entry.message_id, dispatchCwd);
                linkClaimToAssignment(claimResult.claimId, criticAssignmentId, dispatchCwd);
                transitionAssignment(criticAssignmentId, 'offered', { actor: senderAgent }, dispatchCwd);
                patchAssignmentMessageId(criticAssignmentId, queued.entry.message_id, dispatchCwd);
                queued.entry.assignment_id = criticAssignmentId;
              } catch (linkErr) {
                warnings.push(
                  `ideate assignment linkage failed for ${criticAssignmentId}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`,
                );
              }
            }

            preparedCritics.push({
              entry: queued.entry,
              invoke: queued.invoke,
              worktreePath: claimResult.worktreePath,
            });
            dispatchedCritics += 1;
          } catch (criticErr) {
            facadeStatus = 'partial';
            warnings.push(
              `ideate critic dispatch failed for slot ${slot.slot_id} (${slot.agent}): ${criticErr instanceof Error ? criticErr.message : String(criticErr)}; loop ${loopId} stays open`,
            );
          }

          if (briefResult.truncated) {
            warnings.push(
              `Brief for critic slot ${slot.slot_id} (${slot.agent}) truncated: ${briefResult.droppedItems} memory items dropped to fit cap`,
            );
          }
        }

        // pln#626 Phase 2 (Option B) — spawn the prepared critics now that all
        // loop state is mutated (mirrors intent=assign's post-loop execution).
        // autoExecute=false yields command_ready_manual per critic; a target
        // that can't spawn yields not_spawnable — both surfaced honestly.
        if (preparedCritics.length > 0) {
          ideateExecStatus = await runCoordinateExecution(preparedCritics, {
            autoExecute: effectiveAutoExecute !== false,
            senderAgent,
            senderAgentId,
            cwd: dispatchCwd,
            warnings,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(
          `ideate dispatch failed: ${msg}; loop ${loopId} stays at proposal phase`,
        );
        facadeStatus = 'partial';
      }
    }

    if (!explicitTargets) {
      warnings.push(
        presetSelected
          ? `ideate single-agent mode (preset='${req.preset}'): loop opened at phase '${dispatchedPhase}'; champion drives manually via bclaw_loop intent='turn' / 'advance'.`
          : "ideate single-agent mode: loop opened with proposal seed; champion drives manually via bclaw_loop intent='turn' / 'advance'. Pass targetAgents to enable multi-agent auto-dispatch.",
      );
    }

    // pln#626 Phase 2 — multi-agent critics are now SPAWNED (worktree workers),
    // so the result reports the real execution_status from runCoordinateExecution
    // and exposes the delivery entries (each carrying execution_reason) so the
    // top-level reason derivation works — exactly like intent=assign. Single-
    // agent ideate spawns nothing, so it stays honestly inbox_only.
    result = {
      loop_id: loopId,
      proposal_artifact_id: proposalArtifactId,
      selected_targets: explicitTargets ? req.targetAgents! : [],
      mode: explicitTargets ? 'multi_agent' : 'single_agent',
      dispatched_critics: dispatchedCritics,
      current_phase: dispatchedPhase,
      delivery_plan: preparedCritics.map((p) => p.entry),
      ...(ideateExecStatus
        ? { execution_status: ideateExecStatus }
        : explicitTargets
          // Multi-agent was intended but nothing prepared (advance() threw, or
          // every per-critic prep failed) — that's a failure, not by-design
          // inbox delivery. facadeStatus is already 'partial'; say so honestly.
          ? { execution_status: 'inbox_only', execution_reason: 'dispatch_failed' }
          : { execution_status: 'inbox_only', execution_reason: 'intent_inbox_only' }),
      ...(presetSelected ? { preset: req.preset } : {}),
    };

    // pln#518 step 1 — bootstrap lock is now managed inside acquireBootstrapLoop;
    // no release needed here.
  }

  // Extract execution_status from result if present (assign/reroute set it)
  const resultExecStatus = (result && typeof result === 'object' && 'execution_status' in result)
    ? (result as Record<string, unknown>).execution_status as FacadeResponse['execution_status']
    : undefined;

  // pln#626 Phase 1 — surface the REASON WHY at the top level, not just per
  // delivery entry. The reason accompanies execution_status only when it is
  // NOT delivered_and_started (mixed dispatches where ≥1 target spawned report
  // delivered_and_started overall, and their per-entry failures stay visible in
  // delivery_plan + warnings — the top-level reason must not contradict the
  // status). Prefer an explicit result.execution_reason (consult / ideate /
  // bootstrap-join set it); otherwise derive it from the first non-started
  // delivery entry (e.g. auto_execute_disabled on a manual assign/review,
  // not_spawnable on an IDE-only target).
  const resultExecReason: string | undefined = (() => {
    if (resultExecStatus === 'delivered_and_started') return undefined;
    if (!result || typeof result !== 'object') return undefined;
    const r = result as Record<string, unknown>;
    if (typeof r.execution_reason === 'string') return r.execution_reason;
    const plan = r.delivery_plan;
    if (Array.isArray(plan)) {
      for (const e of plan as Array<Record<string, unknown>>) {
        if (e && e.execution_status !== 'delivered_and_started' && typeof e.execution_reason === 'string') {
          return e.execution_reason;
        }
      }
    }
    return undefined;
  })();

  // pln#503 phase 3.3: when execution_status === 'delivered_and_started',
  // attach a self-documenting `verify_with` hint pointing at the assignment
  // record. Callers should not take delivered_and_started at face value —
  // it only attests the brief-ack sentinel was touched, not that the worker
  // is doing useful work. The hint tells them exactly which canonical-
  // grammar call to make next to verify spawn liveness.
  let verifyWith: FacadeResponse['verify_with'] | undefined;
  if (resultExecStatus === 'delivered_and_started') {
    const firstAssignment = artifacts.find((a) => a.type === 'assignment');
    if (firstAssignment) {
      verifyWith = {
        action: 'bclaw_find',
        entity: 'agent_run',
        filter: { assignment_id: firstAssignment.id },
        expected_when_alive: 'agent_run with status="running" AND OS pid alive AND last_event_at within the last few minutes',
        see_also: 'docs/concepts/dispatch-lifecycle.md',
      };
    }
  }

  const facadeResponse: FacadeResponse = {
    status: facadeStatus,
    intent: req.intent,
    result,
    artifacts,
    side_effects,
    warnings,
    duration_ms: Date.now() - startMs,
    ...(resultExecStatus ? { execution_status: resultExecStatus } : {}),
    ...(resultExecReason ? { execution_reason: resultExecReason } : {}),
    ...(verifyWith ? { verify_with: verifyWith } : {}),
  };

  const summaryParts: string[] = [`✔ bclaw_coordinate [${req.intent}] targets=${resolvedAgents.length}`];
  if (resultExecStatus) summaryParts.push(`execution: ${resultExecStatus}${resultExecReason ? ` (${resultExecReason})` : ''}`);
  if (warnings.length > 0) summaryParts.push(warnings.map((w) => `⚠ ${w}`).join('\n'));

  return {
    response: toolResponse({
      content: [{ type: 'text', text: summaryParts.join('\n') }],
      structuredContent: facadeResponse as unknown as Record<string, unknown>,
    }),
  };
}

export async function handleBclawLoop(args: Record<string, unknown>, ctx: McpWriteToolContext): Promise<McpToolExecutionOutcome> {
  const { cwd, connectionSessionId } = ctx;
  // pln#542: intent='open' is no longer exposed standalone over MCP — it
  // creates a loop without dispatching the first turn (the documented
  // anti-pattern, now removed instead of documented). Internal callers
  // (bclaw_coordinate, CLI bootstrap) use core openLoop directly.
  if (args?.intent === 'open') {
    return {
      response: createToolErrorResponse(
        'intent_not_exposed',
        "bclaw_loop(intent='open') is not exposed standalone: it creates a loop structure without dispatching any turn, so the work never starts. Use bclaw_coordinate(intent='review', open_loop=true, targetAgents=[…]) or bclaw_coordinate(intent='ideate') — they open the loop AND dispatch the first turn.",
      ),
    };
  }
  // pln#562 step 4 — dispatching a turn hands work to another agent; gate
  // it at the same trust bar as the other dispatch surfaces.
  if (args?.intent === 'turn' && args?.dispatch === true) {
    const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
    if (resolved.error) {
      return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
    }
  }
  const { handleBclawLoop: runLoopIntent } = await import('./loops-handlers.js');
  const targetCwd = resolveProjectCwd(args?.project as string | undefined, cwd);
  const result = runLoopIntent({ args: args as unknown, cwd: targetCwd });
  return {
    response: toolResponse({
      content: [{ type: 'text', text: result.summary }],
      structuredContent: result.response as unknown as Record<string, unknown>,
    }),
  };
}
