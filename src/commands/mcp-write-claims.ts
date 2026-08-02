/**
 * MCP claim/assignment write-tool handlers.
 *
 * Extracted from mcp.ts (pln#622 PR3b) — mechanical move of the
 * claim / session / assignment / plan-step write handlers. Behavior is
 * unchanged; each handler receives the tool-call payload plus a
 * {@link McpWriteClaimsContext} carrying the helpers that remain in the
 * mcp.ts assembly point because they are shared with other write domains.
 *
 * This module must never import ./mcp.js (dependency-direction guard,
 * pln#622 PR1).
 *
 * @module
 */
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { buildContext } from '../core/context.js';
import { checkBrainclawInstallableUpdate, renderBrainclawInstallableUpdateNotice } from '../core/brainclaw-version.js';
import { loadConfig } from '../core/config.js';
import { generateClaimId, loadClaim, saveClaim, adoptClaimSession, releaseClaimWithCascade, claimBaselineFields } from '../core/claims.js';
import { releaseClaimNextActions } from '../core/next-actions.js';
import { reconcileClaimConformity } from '../core/claim-conformity.js';
import { pushStructuredWarning } from '../core/warnings.js';
import type { WarningDetail } from '../core/facade-schema.js';
import { checkPolicy } from '../core/policy.js';
import { createWorktree as coreCreateWorktree, sanitizeBranchComponent } from '../core/worktree.js';
import { startSession } from './session-start.js';
import { endSession } from './session-end.js';
import { hasMinimumTrustLevel } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO } from '../core/ids.js';
import { buildOperationalIdentity, loadAllSessions } from '../core/identity.js';
import { validateMcpField } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { countActionable } from '../core/messaging.js';
import { addStep as addStepOp, completeStep as completeStepOp, updateStep as updateStepOp, deleteStep as deleteStepOp } from '../core/operations/plan.js';
import type { AgentIdentityDocument, PlanStepStatus } from '../core/schema.js';
import {
  toolResponse,
  createToolErrorResponse,
  normaliseFormat,
  type McpToolResponse,
  type McpToolExecutionPayload,
  type McpToolExecutionOutcome,
  type McpToolErrorShape,
} from './mcp-contract.js';
import { renderContextForMcp } from './mcp-presentation.js';

/** Result shape of mcp.ts's resolveExecutionWriteTarget (structural mirror). */
export interface ExecutionWriteTargetShape {
  /** When set, the caller must return this error response instead of writing. */
  block?: McpToolResponse;
  /** Store cwd the execution write must target. */
  targetCwd: string;
  /** True when a session-scoped switch into the target project was performed. */
  autoSwitched: boolean;
  /** Resolved project echoed back to the caller for visibility. */
  resolvedProject?: { path: string; name?: string };
}

/**
 * Per-call context for the extracted claim/assignment write handlers.
 *
 * `currentModel` is resolved once per write call at the assembly point; the
 * function members are mcp.ts helpers SHARED with other write domains
 * (canonical grammar, plan/candidate handlers, …) — they stay in mcp.ts and
 * are passed by reference so this module never imports ./mcp.js.
 */
export interface McpWriteClaimsContext {
  /** Model resolved once for all write operations in the assembly point. */
  currentModel?: string;
  ensureTrust: (
    args: Record<string, unknown>,
    fields: { nameField: string; idField: string },
    level: 'contributor' | 'trusted' | 'curator',
    cwd?: string,
    sessionId?: string,
  ) => { identity?: AgentIdentityDocument; error?: McpToolErrorShape };
  resolveMutationIdentity: (
    args: Record<string, unknown>,
    fields: { nameField: string; idField: string },
    cwd?: string,
    sessionId?: string,
  ) => { identity?: AgentIdentityDocument; error?: McpToolErrorShape };
  blockCrossProjectExecution: (
    entity: 'claim' | 'plan' | 'session',
    args: Record<string, unknown>,
  ) => McpToolResponse | undefined;
  resolveExecutionWriteTarget: (
    entity: 'claim' | 'plan',
    args: Record<string, unknown>,
    cwd: string,
    connectionSessionId?: string,
  ) => ExecutionWriteTargetShape;
  projectInfoForCwd: (cwd: string) => { path: string; name?: string };
  explicitSessionIdFromEnv: () => string | undefined;
  appendLegacyMcpToolWarning: (response: McpToolResponse, name: string) => McpToolResponse;
  isLegacyMcpToolFacadeDisabled: (name: string) => boolean;
  createLegacyMcpToolDisabledResponse: () => McpToolResponse;
}

export function parseTtl(ttl: string): string | undefined {
  const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
  if (!match) return undefined;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3_600_000 : value * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}

export async function handleBclawClaim(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { name, args, cwd, connectionSessionId } = payload;
  // project=X naming a workspace sibling auto-localizes (session+switch then
  // claim locally); federated links / unknown names stay blocked.
  const claimLoc = ctx.resolveExecutionWriteTarget('claim', args, cwd, connectionSessionId);
  if (claimLoc.block) {
    return { response: claimLoc.block };
  }
  const effectiveClaimCwd = claimLoc.targetCwd;
  const claimAutoSwitched = claimLoc.autoSwitched;
  const storeTarget = (args.store as StoreTarget | undefined) ?? 'local';
  const claimCwd = resolveTargetStore(effectiveClaimCwd, storeTarget);
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const claimScope = String(args.scope ?? '').trim();
  const claimDescription = String(args.description ?? '').trim();
  const scopeCheck = validateMcpField(claimScope, 'scope');
  if (!scopeCheck.ok) {
    return { response: createToolErrorResponse('validation_error', scopeCheck.message) };
  }
  const descCheck = validateMcpField(claimDescription, 'description');
  if (!descCheck.ok) {
    return { response: createToolErrorResponse('validation_error', descCheck.message) };
  }
  const resolvedIdentity = resolved.identity!;
  const identity = {
    ...buildOperationalIdentity(resolvedIdentity.agent_name, cwd, {
      agentId: resolvedIdentity.agent_id,
      sessionId: connectionSessionId,
    }),
    project_id: loadConfig(claimCwd).project_id,
  };
  const claimId = generateClaimId();
  let worktreePath: string | undefined;
  let worktreeWarn = '';
  // trp#431: advisory mode skips worktree creation. Default is to create an
  // isolated worktree (multi-agent safety), but when the work already lives
  // (uncommitted) in the main tree a fresh worktree is counterproductive and
  // the agent ends up skipping the claim. Pass advisory:true (or
  // worktree:false) for an advisory-only lock with no worktree.
  const advisoryClaim = args.advisory === true || args.worktree === false;
  if (!advisoryClaim) {
    // Shared slug logic (trp#950): collision-resistant when the scope
    // exceeds the branch-component cap, and identical to createCoordinatorClaim.
    const branchSlug = sanitizeBranchComponent(claimScope);
    const worktreeBranch = (args.worktreeBranch as string | undefined)?.trim() || `feat/${branchSlug}`;
    try {
      worktreePath = coreCreateWorktree(claimCwd, worktreeBranch, {
        sessionId: identity.session_id,
        agent: identity.agent,
      });
    } catch (wtErr) {
      worktreeWarn = `\n⚠ Worktree creation failed: ${wtErr instanceof Error ? wtErr.message : String(wtErr)}`;
    }
  }
  const claimTtl = args.ttl as string | undefined;
  const claimExpiresAt = claimTtl ? parseTtl(claimTtl) : undefined;
  const rawHandoffMode = args.handoffMode as string | undefined;
  if (rawHandoffMode && rawHandoffMode !== 'self-commit' && rawHandoffMode !== 'integrator') {
    return { response: toolResponse({ content: [{ type: 'text', text: `Invalid handoffMode: "${rawHandoffMode}". Must be "self-commit" or "integrator".` }], isError: true }) };
  }
  const handoffMode = (rawHandoffMode as 'self-commit' | 'integrator' | undefined) ?? 'self-commit';
  saveClaim({
    id: claimId,
    agent: identity.agent,
    agent_id: identity.agent_id,
    user: process.env.USER || process.env.USERNAME || undefined,
    project_id: identity.project_id,
    host_id: identity.host_id,
    session_id: identity.session_id,
    scope: claimScope,
    description: claimDescription,
    created_at: nowISO(),
    status: 'active',
    plan_id: args.planId as string | undefined,
    model: ctx.currentModel,
    worktree_path: worktreePath,
    expires_at: claimExpiresAt,
    handoff_mode: handoffMode,
    // pln#636 C0-b / trp#1292 — this handler builds its claim literal instead of
    // going through acquireClaimScope, which is why the baseline was missing on
    // every MCP-created claim and the conformity reconcile never had anything to
    // compare against.
    ...claimBaselineFields(claimCwd),
  }, claimCwd);
  appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'claim', item_id: claimId, item_type: 'claim', scope: claimScope, session_id: identity.session_id, host_id: identity.host_id }, claimCwd);

  // Post-claim policy check: surface constraints/traps as warnings
  const policyResult = checkPolicy({
    scope: claimScope,
    agent: resolvedIdentity.agent_name,
    agentId: resolvedIdentity.agent_id,
    cwd: claimCwd,
  });
  let policyWarn = '';
  const policyWarnings = policyResult.warnings.filter(w => w.kind !== 'no_claim');
  if (policyWarnings.length > 0) {
    policyWarn = '\n\nPolicy warnings for this scope:';
    for (const w of policyWarnings) {
      const idLabel = w.id ? ` (${w.id})` : '';
      policyWarn += `\n  ⚠ [${w.kind}]${idLabel} ${w.message}`;
    }
  }

  const postClaimItems = getTriggeredItems('trigger:post-claim', claimCwd);
  const postClaimText = renderTriggeredItems(postClaimItems);
  const noPlanWarn = !(args.planId as string | undefined)
    ? '\n⚠ No plan item linked to this claim. Run bclaw_create_plan first and pass planId to track this work formally.'
    : '';
  // Branch guardrail: warn if on master/main without a worktree
  let branchWarn = '';
  if (!worktreePath) {
    try {
      const { execSync } = await import('node:child_process');
      const branch = execSync('git branch --show-current', { cwd: claimCwd, encoding: 'utf-8' }).trim();
      if (branch === 'master' || branch === 'main') {
        const branchSlug = sanitizeBranchComponent(claimScope);
        branchWarn = `\n⚠️ You are on ${branch}. Create a feature branch before editing: git checkout -b feat/${branchSlug}`;
      }
    } catch { /* git not available, skip warning */ }
  }
  // Stale-branch detection: warn if behind master
  let staleBranchWarn = '';
  try {
    const { execSync: execSyncSB } = await import('node:child_process');
    const currentBranch = execSyncSB('git branch --show-current', { cwd: claimCwd, encoding: 'utf-8' }).trim();
    if (currentBranch && currentBranch !== 'master' && currentBranch !== 'main') {
      for (const mainBranch of ['master', 'main']) {
        try {
          const behind = execSyncSB(`git rev-list --count ${currentBranch}..${mainBranch}`, { cwd: claimCwd, encoding: 'utf-8' }).trim();
          const count = parseInt(behind, 10);
          if (count > 0) {
            staleBranchWarn = `\n⚠ Branch is ${count} commit(s) behind ${mainBranch}. Consider rebasing before editing.`;
          }
          break;
        } catch { /* branch doesn't exist, try next */ }
      }
    }
  } catch { /* git not available */ }

  const worktreeNote = worktreePath ? `\n  Worktree: ${worktreePath}` : '';
  const expiryNote = claimExpiresAt ? `\n  Expires: ${claimExpiresAt.slice(0, 16).replace('T', ' ')} UTC` : '';
  const handoffNote = handoffMode ? `\n  Handoff: ${handoffMode} (another agent will review and merge)` : '';
  const autoSwitchNote = claimAutoSwitched ? `\n  Auto-switched → ${ctx.projectInfoForCwd(effectiveClaimCwd).name ?? effectiveClaimCwd}` : '';
  const claimText = `✔ Claimed scope [${claimId}]${worktreeNote}${expiryNote}${handoffNote}${autoSwitchNote}${noPlanWarn}${worktreeWarn}${branchWarn}${staleBranchWarn}${policyWarn}${postClaimText ? `\n${postClaimText}` : ''}`;

  return {
    response: ctx.appendLegacyMcpToolWarning(toolResponse({
      content: [{ type: 'text', text: claimText }],
      claim_id: claimId,
      session_id: identity.session_id,
      worktree_path: worktreePath,
      triggered_items: postClaimItems,
      ...(claimAutoSwitched ? { auto_switched: true, resolved_project: ctx.projectInfoForCwd(effectiveClaimCwd) } : {}),
    }), name),
    nextConnectionSessionId: ctx.explicitSessionIdFromEnv() ? undefined : identity.session_id,
  };
}

export async function handleBclawReleaseClaim(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  const crossProjectError = ctx.blockCrossProjectExecution('claim', args);
  if (crossProjectError) {
    return { response: crossProjectError };
  }
  const claimId = String(args.id ?? '').trim();
  if (!claimId) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  }
  try {
    loadClaim(claimId, cwd); // validate existence before delegating
  } catch {
    return { response: createToolErrorResponse('not_found', `Claim not found: ${claimId}`) };
  }
  // pln#562 step 5 + trp#928 — release is ownership-checked like acquisition
  // and adoption. Under the trp#928 tightening the coordinator override is
  // OPT-IN via coordinator_override:true (implicit "trusted+ = always
  // override" was too magic — a coordinator releasing a worker's claim
  // should be a visible act, not a silent side-effect of trust). The
  // ownership check still enforces:
  //   - owner-of-claim releases (identity matches): allowed, no override needed
  //   - non-owner releases without coordinator_override: rejected loudly (the
  //     error message points the caller at coordinator_override so it is
  //     executable — pln#607 rule).
  //   - non-owner releases with coordinator_override:true but not trusted+:
  //     trust_error (privilege escalation prevention).
  //   - non-owner releases with coordinator_override:true and trusted+:
  //     allowed, audited (auditReleaseOverride).
  const releaseIdentity = ctx.resolveMutationIdentity(args, { nameField: 'agent', idField: 'agentId' }, cwd, connectionSessionId);
  if ('error' in releaseIdentity && releaseIdentity.error) {
    const { kind, message, details } = releaseIdentity.error;
    return { response: createToolErrorResponse(kind, message, details) };
  }
  if (!('identity' in releaseIdentity) || !releaseIdentity.identity) {
    return { response: createToolErrorResponse('identity_error', 'No registered agent identity resolved for bclaw_release_claim.') };
  }
  const coordinatorOverrideRequested = args.coordinator_override === true;
  if (coordinatorOverrideRequested) {
    const trustLevel = releaseIdentity.identity.trust_level ?? 'contributor';
    if (!hasMinimumTrustLevel(trustLevel, 'trusted')) {
      return {
        response: createToolErrorResponse(
          'trust_error',
          `coordinator_override:true requires trust_level 'trusted' or higher — caller is '${trustLevel}'. Ask a curator to elevate the agent, or have the claim owner release it.`,
        ),
      };
    }
  }
  const releaseAuth = {
    agent: releaseIdentity.identity.agent_name,
    agent_id: releaseIdentity.identity.agent_id,
    session_id: connectionSessionId,
    override: coordinatorOverrideRequested,
  };
  // pln#636 C2 — read the claim BEFORE the cascade: release is what closes it,
  // and the conformity comparison needs its baseline + declared footprint.
  // Best-effort by construction; a missing claim just means no advisory.
  let claimBeforeRelease;
  try {
    claimBeforeRelease = loadClaim(claimId, cwd);
  } catch { /* conformity is advisory — never block a release on it */ }
  let cascadeResult;
  try {
    cascadeResult = releaseClaimWithCascade(claimId, {
      planStatus: args.planStatus as string | undefined,
      cwd,
      auth: releaseAuth,
    });
  } catch (err: unknown) {
    return { response: createToolErrorResponse('trust_error', err instanceof Error ? err.message : String(err)) };
  }
  const { planTransitioned, planWarning, planId: cascadePlanId, newPlanStatus: cascadeNewStatus } = cascadeResult;
  const summaryText = [
    `✔ Released claim [${claimId}]`,
    planTransitioned ? ` — plan ${cascadePlanId} → ${cascadeNewStatus}` : '',
    planWarning ? ` ⚠ ${planWarning}` : '',
  ].join('');
  // pln#634 — release is the single most protocol-loaded moment of the daily
  // loop (it is where the plan cascade either fires or refuses), and it shipped
  // pure data. Derived from what the cascade actually decided.
  const releaseActions = releaseClaimNextActions({
    claimId,
    planId: cascadePlanId,
    planTransitioned,
    planWarning,
    requestedPlanStatus: typeof args.planStatus === 'string' ? args.planStatus : undefined,
  });
  // pln#636 C2 — release is the natural reconcile point: the work is finished, so
  // the footprint is final. Emits ONLY on a concrete, path-resolvable violation;
  // every doubt (no baseline, prose scope, reaped worktree) stays silent.
  const conformityWarnings: string[] = [];
  const conformityDetails: WarningDetail[] = [];
  if (claimBeforeRelease) {
    try {
      const conformity = reconcileClaimConformity(claimBeforeRelease, cwd);
      if (conformity.warning) {
        pushStructuredWarning(conformityWarnings, conformityDetails, conformity.warning);
      }
    } catch { /* advisory only */ }
  }
  return {
    response: toolResponse({
      content: [{ type: 'text', text: summaryText }],
      claim_id: claimId,
      ...(planTransitioned ? { plan_id: cascadePlanId, plan_status: cascadeNewStatus } : {}),
      ...(planWarning ? { plan_warning: planWarning, plan_id: cascadePlanId } : {}),
      ...(conformityWarnings.length ? { warnings: conformityWarnings, warning_details: conformityDetails } : {}),
      ...(releaseActions.length ? { next_actions: releaseActions } : {}),
    }),
  };
}

export async function handleBclawSessionStart(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { name, args, cwd, connectionSessionId } = payload;
  if (ctx.isLegacyMcpToolFacadeDisabled(name)) {
    return { response: ctx.createLegacyMcpToolDisabledResponse() };
  }
  const crossProjectError = ctx.blockCrossProjectExecution('session', args);
  if (crossProjectError) {
    return { response: crossProjectError };
  }
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  // For identity_error on session start, let startSession handle auto-registration
  // instead of returning an immediate error (implements "don't require pre-registration to start").
  if (resolved.error && resolved.error.kind !== 'identity_error') {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const result = await startSession({
    agent: resolved.identity?.agent_name ?? (typeof args.agent === 'string' ? args.agent : undefined),
    agentId: resolved.identity?.agent_id ?? (typeof args.agentId === 'string' ? args.agentId : undefined),
    context: args.context as string | undefined,
    maintenanceMode: args.maintenanceMode === 'fast' ? 'fast' : 'full',
    cwd,
  });

  const postSessionStartItems = getTriggeredItems('trigger:post-session-start', cwd);
  const postSessionStartText = renderTriggeredItems(postSessionStartItems);
  const sessionUpdateConfig = loadConfig(cwd);
  const sessionUpdateCheck = checkBrainclawInstallableUpdate(sessionUpdateConfig, cwd, { useDefaultNpmSource: true });
  const sessionUpdateNotice = renderBrainclawInstallableUpdateNotice(sessionUpdateCheck);
  // Stale-surfaces advisory. This REPLACES a hand-rolled guardrail that lived
  // here: a regex over the first 200 chars of 3 hardcoded files. That was a
  // second, divergent freshness check running next to the proper one — the same
  // dual-source drift class as the two LANE-RESULT shapes (pln#638 PR-4). The
  // pln#638 2b reconcile in startSession covers ~25 registry-derived paths with
  // a real parser; its result was computed by this very call and then dropped
  // from the response (Fable audit P0.2). Now it IS the guardrail.
  const staleInstructionsWarn = result.stale_surfaces ? `\n⚠️ ${result.stale_surfaces.message}` : '';
  // Claim adoption: if BRAINCLAW_CLAIM_ID is set (spawned by dispatcher),
  // adopt the claim by writing session_id into it. This links claim→session.
  let adoptedClaimId: string | undefined;
  const envClaimId = process.env.BRAINCLAW_CLAIM_ID;
  if (envClaimId && result.session_id) {
    try {
      const adoptResult = adoptClaimSession(envClaimId, result.session_id, cwd);
      if (adoptResult.adopted) {
        adoptedClaimId = envClaimId;
      }
    } catch { /* best-effort — claim may not exist or be already adopted */ }
  }

  const sessionStartMsgParts = ['✔ Session started'];
  if (result.auto_registered) {
    sessionStartMsgParts.push(`\n⚠️ Agent '${result.agent}' was auto-registered (first use). Run \`brainclaw register-agent ${result.agent}\` to set capabilities and trust level.`);
  }
  if (adoptedClaimId) sessionStartMsgParts.push(`\n🔗 Adopted claim ${adoptedClaimId} — use bclaw_read_inbox with claimId to see your assignment.`);
  if (result.shared_checkout_warning) {
    const others = result.shared_checkout_warning.other_sessions.map((s) => s.agent).join(', ');
    sessionStartMsgParts.push(`\n⚠️ Shared checkout: ${others} also working in this worktree — claim your scope before editing.`);
  }
  if (staleInstructionsWarn) sessionStartMsgParts.push(staleInstructionsWarn);
  if (sessionUpdateNotice) sessionStartMsgParts.push(sessionUpdateNotice);
  if (postSessionStartText) sessionStartMsgParts.push(postSessionStartText);
  if (result.memory_pressure) {
    sessionStartMsgParts.push(`\n⚠️ Memory pressure detected: ${result.memory_pressure.done_plans} done plans, ${result.memory_pressure.closed_handoffs} closed handoffs (${result.memory_pressure.eligible_items} eligible for compaction). Consider running bclaw_compact to archive old items and create durable summaries.`);
  }
  // Inbox notification
  const agentNameForInbox = resolved.identity?.agent_name ?? result.agent;
  if (agentNameForInbox) {
    const actionableCount = countActionable(agentNameForInbox, cwd);
    if (actionableCount > 0) {
      sessionStartMsgParts.push(`\n📬 You have ${actionableCount} actionable message(s) in your inbox. Use bclaw_read_inbox to check.`);
    }
  }
  const sessionStartMsg = sessionStartMsgParts.join('\n');

  const contentParts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: sessionStartMsg }];
  const inboxPending = agentNameForInbox ? countActionable(agentNameForInbox, cwd) : 0;
  const structured: Record<string, unknown> = {
    session_id: result.session_id,
    agent: result.agent,
    context_target: result.context_target,
    inbox_pending: inboxPending,
    ...(result.auto_registered ? { auto_registered: true } : {}),
    ...(result.memory_pressure ? { memory_pressure: result.memory_pressure } : {}),
    // pln#638 2b — the field startSession computes; it was previously dropped
    // here, making the whole feature reachable only via CLI --json.
    ...(result.stale_surfaces
      ? { warnings: [result.stale_surfaces.message], warning_details: [result.stale_surfaces] }
      : {}),
    // Fifth computed-then-dropped field, caught by the seam guard: other live
    // sessions on the same checkout. An agent about to edit needs this more
    // than a human does.
    ...(result.shared_checkout_warning ? { shared_checkout_warning: result.shared_checkout_warning } : {}),
  };

  if (args.includeContext) {
    const contextAgent = resolved.identity?.agent_name ?? result.agent;
    const previousSession = loadAllSessions(cwd)
      .find((session) => session.agent === contextAgent && session.session_id !== result.session_id);
    const ctxResult = buildContext({
      target: args.context as string | undefined,
      agent: contextAgent,
      profile: args.contextProfile as 'dev' | 'dense' | 'openclaw' | 'ops' | 'research' | 'compact' | 'copilot' | 'quick' | 'briefing' | undefined,
      cwd,
      sinceSession: previousSession?.session_id,
    });
    const format = normaliseFormat(args.contextFormat);
    const ctxText = renderContextForMcp(ctxResult, format, {});
    contentParts.push({ type: 'text', text: ctxText || 'No relevant memory found.' });
    structured.context = ctxResult;
  }

  if (args.includeBoard) {
    const board = buildCoordinationSnapshot({
      agent: resolved.identity?.agent_name ?? result.agent,
      autoAcknowledge: true,
      cwd,
    });
    const boardLines: string[] = [];
    boardLines.push(`Active plans: ${board.active_plans.length}`);
    for (const plan of board.active_plans.slice(0, 10)) {
      const claims = plan.claims.length ? ` claims=${plan.claims.map((c) => c.agent).join(',')}` : '';
      boardLines.push(`- [${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})${claims}`);
    }
    boardLines.push(`Active claims: ${board.active_claims.length}`);
    for (const claim of board.active_claims.slice(0, 10)) {
      boardLines.push(`- [${claim.id}] ${claim.agent} -> ${claim.scope}`);
    }
    if (board.active_sequence) {
      boardLines.push(`Active sequence: ${board.active_sequence.name} (${board.active_sequence.status})`);
      for (const item of board.active_sequence.items.slice(0, 5)) {
        const lane = item.lane ? ` lane=${item.lane}` : '';
        boardLines.push(`- #${item.rank} ${item.planId}${lane}`);
      }
    }
    boardLines.push(`Open handoffs: ${board.open_handoffs.length}`);
    for (const handoff of board.open_handoffs.slice(0, 5)) {
      boardLines.push(`- [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}`);
    }
    if (board.inbox_pending > 0) {
      boardLines.push(`📬 Inbox: ${board.inbox_pending} pending message(s)`);
    }
    contentParts.push({ type: 'text', text: boardLines.join('\n') });
    structured.board = board;
  }

  return {
    response: ctx.appendLegacyMcpToolWarning(toolResponse({
      content: contentParts,
      ...structured,
    }), name),
    nextConnectionSessionId: ctx.explicitSessionIdFromEnv() ? undefined : result.session_id,
  };
}

export async function handleBclawSessionEnd(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  const crossProjectError = ctx.blockCrossProjectExecution('session', args);
  if (crossProjectError) {
    return { response: crossProjectError };
  }
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const result = await endSession({
    session: args.session as string | undefined,
    agent: resolved.identity?.agent_name,
    agentId: resolved.identity?.agent_id,
    summary: args.summary as string | undefined,
    narrative: args.narrative as string | undefined,
    autoReflect: args.autoReflect as boolean | undefined,
    autoRelease: args.autoRelease as boolean | undefined,
    reflectHandoff: args.reflectHandoff as boolean | undefined,
    dispatchReview: args.dispatchReview as boolean | undefined,
    reviewer: args.reviewer as string | undefined,
    reflect: args.reflect as boolean | undefined,
    cwd,
  });
  const preSessionEndItems = getTriggeredItems('trigger:pre-session-end', cwd);
  const preSessionEndText = renderTriggeredItems(preSessionEndItems);
  const endUpdateConfig = loadConfig(cwd);
  const endUpdateCheck = checkBrainclawInstallableUpdate(endUpdateConfig, cwd, { useDefaultNpmSource: true });
  const endUpdateNotice = renderBrainclawInstallableUpdateNotice(endUpdateCheck);

  const parts: string[] = ['✔ Session ended'];
  if (endUpdateNotice) parts.push(endUpdateNotice);
  if (preSessionEndText) parts.push(preSessionEndText);
  // pln#636 C2 session-end sweep — the backstop trigger. endSession computed
  // these and this handler dropped them (Fable audit P1): of the four C2
  // boundaries, this one emitted nowhere. Text part + structured channel below.
  if (result.scope_warnings?.length) {
    for (const w of result.scope_warnings) parts.push(`\n⚠️ ${w.message}`);
  }
  if (result.reflection_prompt) {
    parts.push('\n📝 Session reflection — please answer these questions:');
    for (let i = 0; i < result.reflection_prompt.questions.length; i++) {
      parts.push(`  ${i + 1}. ${result.reflection_prompt.questions[i]}`);
    }
    parts.push(`\n${result.reflection_prompt.instruction}`);
  }

  return {
    response: toolResponse({
      content: [{ type: 'text', text: parts.join('\n') }],
      session_id: result.session_id,
      notes_in_session: result.notes_in_session,
      candidates_created: result.candidates_created,
      context_diff: result.context_diff,
      triggered_items: preSessionEndItems,
      ...(result.handoff ? { handoff: result.handoff } : {}),
      ...(result.reflection_prompt ? { reflection_prompt: result.reflection_prompt } : {}),
      ...(result.scope_warnings?.length
        ? {
            warnings: result.scope_warnings.map((w) => w.message),
            warning_details: result.scope_warnings,
          }
        : {}),
    }),
    nextConnectionSessionId: null,
  };
}

export async function handleBclawAssignmentUpdate(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  // Contributor trust: lowest dispatchable level. The agent-owner guard
  // below ensures only the assigned agent can update its own assignment.
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  try {
    const assignmentId = typeof args.assignment_id === 'string' ? args.assignment_id : undefined;
    const status = typeof args.status === 'string' ? args.status : undefined;
    if (!assignmentId) return { response: createToolErrorResponse('input_error', 'assignment_id is required') };
    if (!status) return { response: createToolErrorResponse('input_error', 'status is required') };
    const message = args.message as string | undefined;
    const errorMessage = args.error_message as string | undefined;
    const blocker = args.blocker as string | undefined;
    const actionRequiredInput = args.action_required as Record<string, unknown> | undefined;
    const artifacts = Array.isArray(args.artifacts) ? args.artifacts as Array<{ type: string; ref: string; description?: string }> : undefined;

    // Warn if no active session (audit trail will be incomplete)
    const effectiveSessionId = connectionSessionId ?? 'unknown';

    const { loadAssignment, transitionAssignment: transitionAsgn, recordProgress: recordProg } = await import('../core/assignments.js');

    const assignment = loadAssignment(assignmentId, cwd);
    if (!assignment) {
      return { response: createToolErrorResponse('not_found', `Assignment not found: ${assignmentId}`) };
    }

    // Agent guard: only the assigned agent can update
    const callerAgent = resolved.identity!.agent_name;
    if (assignment.agent !== callerAgent) {
      return { response: createToolErrorResponse('trust_error', `Agent ${callerAgent} cannot update assignment owned by ${assignment.agent}`) };
    }

    if (status === 'progress') {
      const updated = recordProg(assignmentId, {
        message,
        artifacts,
        actor: callerAgent,
        actor_id: resolved.identity!.agent_id,
        session_id: effectiveSessionId,
      }, cwd);
      return {
        response: {
          content: [{ type: 'text', text: `Assignment ${assignmentId} heartbeat recorded` }],
          structuredContent: { assignment_id: assignmentId, status: updated.status, last_heartbeat_at: updated.last_heartbeat_at },
        },
      };
    }

    // Map status to FSM transition
    const statusReason = status === 'failed' ? errorMessage
      : status === 'blocked' ? blocker
      : message;

    const result = transitionAsgn(assignmentId, status as import('../core/schema.js').AssignmentStatus, {
      session_id: effectiveSessionId,
      status_reason: statusReason,
      artifacts,
      error_message: errorMessage,
      actor: callerAgent,
      actor_id: resolved.identity!.agent_id,
    }, cwd);

    // pln#636 C2 — reconcile the linked claim's scope BEFORE the cascade below
    // releases it (after release there is no claim left to read). This is the
    // lifecycle boundary a worker crosses when it reports its own completion.
    const asgnConformityWarnings: string[] = [];
    const asgnConformityDetails: WarningDetail[] = [];
    if (status === 'completed' && assignment.claim_id) {
      try {
        const linkedClaim = loadClaim(assignment.claim_id, cwd);
        if (linkedClaim) {
          const conformity = reconcileClaimConformity(linkedClaim, cwd);
          if (conformity.warning) {
            pushStructuredWarning(asgnConformityWarnings, asgnConformityDetails, conformity.warning);
          }
        }
      } catch { /* advisory only — never block a completion report */ }
    }

    // trp#928 — cascade-release the assignment's linked claim on completion.
    // Before this landing an obedient worker had to make TWO calls to close
    // the loop (bclaw_assignment_update status=completed AND
    // bclaw_release_claim); dispatch briefs enumerate both, but not every
    // sandboxed worker gets through both, and the coordinator's harvest path
    // only releases on --integrate — so contributor-driven completions left
    // claims active. The worker's own identity owns the claim (session
    // adoption), so ownership matches and no coordinator_override is needed.
    // Silent success/failure is unacceptable: log per-claim outcome.
    if (status === 'completed' && assignment.claim_id) {
      try {
        const { releaseClaimsCascade, logCascadeReleaseResult } = await import('../core/claims.js');
        const cascade = releaseClaimsCascade([assignment.claim_id], {
          cwd,
          planStatus: 'done',
          auth: {
            agent: callerAgent,
            agent_id: resolved.identity!.agent_id,
            session_id: effectiveSessionId,
            override: false,
          },
        });
        logCascadeReleaseResult({
          actor: callerAgent,
          trigger: 'assignment_completed',
          assignment_id: assignmentId,
          claim_id: assignment.claim_id,
          cascade,
          cwd,
        });
      } catch { /* never block the update on cascade release */ }
    }

    // When accepted: auto-acknowledge the inbox message (replaces bclaw_ack_message)
    if (status === 'accepted' && assignment.message_id) {
      try {
        const { ackMessage } = await import('../core/messaging.js');
        // pln#562 step 4 — scope the ack to this assignment's claim so a
        // same-named sibling instance cannot consume the message.
        ackMessage(assignment.message_id, callerAgent, cwd, { claimId: assignment.claim_id });
      } catch { /* best-effort: don't fail the update if ack fails */ }
    }

    let createdActionId: string | undefined;
    if (status === 'blocked' && actionRequiredInput) {
      const kind = String(actionRequiredInput.kind ?? '').trim();
      const title = String(actionRequiredInput.title ?? '').trim();
      const prompt = String(actionRequiredInput.prompt ?? '').trim();
      if (!['approval', 'user_input', 'clarification', 'plan_approval'].includes(kind) || !title || !prompt) {
        return { response: createToolErrorResponse('validation_error', 'action_required must include kind, title, and prompt when status=blocked') };
      }
      const { createActionRequired } = await import('../core/actions.js');
      const { findLatestAgentRunForAssignment } = await import('../core/agentruns.js');
      const latestRun = findLatestAgentRunForAssignment(assignmentId, cwd);
      const action = createActionRequired({
        assignment_id: assignmentId,
        run_id: latestRun?.id,
        claim_id: assignment.claim_id,
        message_id: assignment.message_id,
        plan_id: assignment.plan_id,
        sequence_id: assignment.sequence_id,
        agent: callerAgent,
        agent_id: resolved.identity!.agent_id,
        session_id: effectiveSessionId,
        kind: kind as import('../core/schema.js').ActionRequiredKind,
        scope: assignment.scope,
        title,
        prompt,
        options: Array.isArray(actionRequiredInput.options) ? actionRequiredInput.options.map(String) : [],
        response_schema: (actionRequiredInput.response_schema && typeof actionRequiredInput.response_schema === 'object')
          ? actionRequiredInput.response_schema as Record<string, unknown>
          : undefined,
        tags: Array.isArray(actionRequiredInput.tags) ? actionRequiredInput.tags.map(String) : ['action-required'],
      }, cwd);
      createdActionId = action.id;
    }

    return {
      response: {
        content: [{ type: 'text', text: `Assignment ${assignmentId} updated: ${result.previous_status} → ${status}` }],
        structuredContent: {
          assignment_id: assignmentId,
          status,
          previous_status: result.previous_status,
          ...(result.assignment.accepted_at && { accepted_at: result.assignment.accepted_at }),
          ...(result.assignment.started_at && { started_at: result.assignment.started_at }),
          ...(result.assignment.completed_at && { completed_at: result.assignment.completed_at }),
          last_heartbeat_at: result.assignment.last_heartbeat_at,
          ...(createdActionId ? { action_id: createdActionId } : {}),
          ...(asgnConformityWarnings.length
            ? { warnings: asgnConformityWarnings, warning_details: asgnConformityDetails }
            : {}),
        },
      },
    };
  } catch (err) {
    return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
  }
}

export async function handleBclawAssignmentAction(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  try {
    const actionId = typeof args.action_id === 'string' ? args.action_id : undefined;
    const outcome = typeof args.outcome === 'string' ? args.outcome : undefined;
    if (!actionId) return { response: createToolErrorResponse('input_error', 'action_id is required') };
    if (!outcome || !['resolved', 'rejected', 'cancelled'].includes(outcome)) {
      return { response: createToolErrorResponse('validation_error', 'outcome must be one of: resolved, rejected, cancelled') };
    }

    const { resolveActionRequired, loadActionRequired } = await import('../core/actions.js');

    // Guard: an agent cannot resolve its own action (defeats approval workflow)
    const pendingAction = loadActionRequired(actionId, cwd);
    if (pendingAction && pendingAction.agent === resolved.identity!.agent_name) {
      return { response: createToolErrorResponse('trust_error', `Agent '${resolved.identity!.agent_name}' cannot resolve its own action. A supervisor or different agent must respond.`) };
    }

    const action = resolveActionRequired(actionId, {
      outcome: outcome as 'resolved' | 'rejected' | 'cancelled',
      text: typeof args.text === 'string' ? args.text : undefined,
      payload: args.payload && typeof args.payload === 'object' ? args.payload as Record<string, unknown> : undefined,
      responded_by: resolved.identity!.agent_name,
      responded_by_id: resolved.identity!.agent_id,
      session_id: connectionSessionId ?? 'unknown',
    }, cwd);

    return {
      response: {
        content: [{ type: 'text', text: `Action ${actionId} ${action.status}` }],
        structuredContent: {
          action_id: action.id,
          assignment_id: action.assignment_id,
          run_id: action.run_id,
          status: action.status,
          resolved_at: action.resolved_at,
          response: action.response,
        },
      },
    };
  } catch (err) {
    return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
  }
}

export async function handleBclawAddStep(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  const stepLoc = ctx.resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
  if (stepLoc.block) {
    return { response: stepLoc.block };
  }
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const stepPlanId = String(args.planId ?? '').trim();
  const stepData = args.data && typeof args.data === 'object' && !Array.isArray(args.data)
    ? args.data as Record<string, unknown>
    : {};
  if ((args.text !== undefined || args.assignee !== undefined) && Object.keys(stepData).length > 0) {
    console.warn('[brainclaw:warn] bclaw_add_step received legacy top-level fields alongside data.*; using data.* values');
  }
  const stepTextRaw = stepData.text ?? stepData.title ?? args.text;
  const stepText = typeof stepTextRaw === 'string' ? stepTextRaw.trim() : '';
  const stepAssignee = (stepData.assignee ?? args.assignee) as string | undefined;
  const stepEstimated = (stepData.estimated_effort ?? args.estimated_effort) as number | string | undefined;
  const stepActual = (stepData.actual_effort ?? args.actual_effort) as string | undefined;
  if (!stepPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
  if (!stepText) return { response: createToolErrorResponse('validation_error', 'Missing required argument: data.text') };
  const stepTargetCwd = stepLoc.targetCwd;
  try {
    const result = addStepOp({ planId: stepPlanId, text: stepText, assignee: stepAssignee, estimatedEffort: stepEstimated, actualEffort: stepActual }, stepTargetCwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Step added: [${result.stepId}] ${stepText} (${result.doneSteps}/${result.totalSteps} done)` }],
        step_id: result.stepId,
        plan_id: result.planId,
        progress: { done: result.doneSteps, total: result.totalSteps },
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return { response: createToolErrorResponse('not_found', msg) };
    }
    return { response: createToolErrorResponse('operation_error', msg) };
  }
}

export async function handleBclawCompleteStep(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  const csLoc = ctx.resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
  if (csLoc.block) {
    return { response: csLoc.block };
  }
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const csPlanId = String(args.planId ?? '').trim();
  const csStepId = String(args.stepId ?? '').trim();
  if (!csPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
  if (!csStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
  const csTargetCwd = csLoc.targetCwd;
  try {
    const result = completeStepOp({ planId: csPlanId, stepId: csStepId }, csTargetCwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Step completed: [${result.stepId}] (${result.doneSteps}/${result.totalSteps} done)` }],
        step_id: result.stepId,
        plan_id: result.planId,
        progress: { done: result.doneSteps, total: result.totalSteps },
        all_done: result.doneSteps === result.totalSteps,
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return { response: createToolErrorResponse('not_found', msg) };
    }
    return { response: createToolErrorResponse('operation_error', msg) };
  }
}

export async function handleBclawUpdateStep(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  const usLoc = ctx.resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
  if (usLoc.block) {
    return { response: usLoc.block };
  }
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const usPlanId = String(args.planId ?? '').trim();
  const usStepId = String(args.stepId ?? '').trim();
  if (!usPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
  if (!usStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
  const validStatuses = ['todo', 'in_progress', 'testing', 'done', 'blocked'];
  if (args.status && !validStatuses.includes(String(args.status))) {
    return { response: createToolErrorResponse('validation_error', `Invalid status: ${args.status}. Valid: ${validStatuses.join(', ')}`) };
  }
  const usTargetCwd = usLoc.targetCwd;
  try {
    const result = updateStepOp({
      planId: usPlanId,
      stepId: usStepId,
      status: args.status as PlanStepStatus | undefined,
      text: args.text as string | undefined,
      assignee: args.assignee as string | undefined,
      estimatedEffort: args.estimated_effort as number | string | undefined,
      actualEffort: args.actual_effort as string | undefined,
    }, usTargetCwd);
    const changes: string[] = [];
    if (args.status) changes.push(`status=${args.status}`);
    if (args.text) changes.push('text updated');
    if (args.assignee !== undefined) changes.push(`assignee=${args.assignee || 'unassigned'}`);
    if (args.estimated_effort !== undefined) changes.push(`estimate=${args.estimated_effort}`);
    if (args.actual_effort !== undefined) changes.push(`actual=${args.actual_effort}`);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Step updated: [${result.stepId}] ${changes.join(', ')} (${result.doneSteps}/${result.totalSteps} done)` }],
        step_id: result.stepId,
        plan_id: result.planId,
        progress: { done: result.doneSteps, total: result.totalSteps },
        all_done: result.doneSteps === result.totalSteps,
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return { response: createToolErrorResponse('not_found', msg) };
    }
    return { response: createToolErrorResponse('operation_error', msg) };
  }
}

export async function handleBclawDeleteStep(payload: McpToolExecutionPayload, ctx: McpWriteClaimsContext): Promise<McpToolExecutionOutcome> {
  const { args, cwd, connectionSessionId } = payload;
  const dsLoc = ctx.resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
  if (dsLoc.block) {
    return { response: dsLoc.block };
  }
  const resolved = ctx.ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const dsPlanId = String(args.planId ?? '').trim();
  const dsStepId = String(args.stepId ?? '').trim();
  if (!dsPlanId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: planId') };
  if (!dsStepId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: stepId') };
  const dsTargetCwd = dsLoc.targetCwd;
  try {
    const result = deleteStepOp({ planId: dsPlanId, stepId: dsStepId }, dsTargetCwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Step deleted: [${result.stepId}] (${result.doneSteps}/${result.totalSteps} remaining)` }],
        step_id: result.stepId,
        plan_id: result.planId,
        progress: { done: result.doneSteps, total: result.totalSteps },
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return { response: createToolErrorResponse('not_found', msg) };
    }
    return { response: createToolErrorResponse('operation_error', msg) };
  }
}
