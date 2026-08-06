/**
 * MCP entity write-tool handlers.
 *
 * Extracted from mcp.ts (pln#622 PR4) — mechanical move of the canonical
 * grammar (create/update/remove/transition/move), plan/candidate creation,
 * candidate accept/reject, plan deletion, and handoff correction/update write
 * handlers. Behavior is unchanged; each handler receives the tool-call payload
 * plus a {@link McpWriteEntitiesContext} carrying the per-call scope and the
 * mcp.ts-local helpers that remain in the assembly point (cross-project
 * guards, the execution write-target resolver, the cross-project arg reader,
 * and the legacy error formatter), passed by reference so this module never
 * imports ./mcp.js (dependency-direction guard, pln#622 PR1).
 *
 * @module
 */
import path from 'node:path';
import { appendAuditEntry } from '../core/audit.js';
import { isLocatableId, locateEntity, type LocatableEntity } from '../core/entity-locator.js';
import { nowISO, generateIdWithLabel } from '../core/ids.js';
import { loadState, persistState, saveState } from '../core/state.js';
import { ENTITY_REGISTRY, type EntityName } from '../core/entity-registry.js';
import { createEntity, updateEntity, removeEntity, transitionEntity, type TransitionAuth } from '../core/entity-operations.js';
import { relocateEntity } from '../core/operations/relocate.js';
import { createPlan, deletePlan as deletePlanOp } from '../core/operations/plan.js';
import type { PlanType, Priority } from '../core/schema.js';
import { loadCandidate } from '../core/candidates.js';
import { resolveCrossProjectWritableTarget, resolveProjectCwd, writeCrossProjectSignal } from '../core/cross-project.js';
import { hasMinimumTrustLevel } from '../core/agent-registry.js';
import { createEntityNextActions, transitionNextActions } from '../core/next-actions.js';
import type { ResolvedEffectiveCwd } from '../core/store-resolution.js';
import { acceptCandidate } from './accept.js';
import { rejectCandidate } from './reject.js';
import { applyHandoffUpdates } from './update-handoff.js';
import {
  ensureTrust,
  resolveMutationIdentity,
  resolveCanonicalAuthor,
  renderAutoRepairWarning,
  scopeMetadataForTarget,
  scanMcpWriteText,
  appendSecurityWarnings,
  type CanonicalAuthorAutoRepair,
} from './mcp-write-support.js';
import {
  SCHEMA_VERSION,
  toolResponse,
  createToolErrorResponse,
  type McpToolResponse,
  type McpToolExecutionPayload,
  type McpToolExecutionOutcome,
} from './mcp-contract.js';

/** Result shape of mcp.ts's resolveExecutionWriteTarget (structural mirror, PR3b). */
/** Entity kinds the locator can find by id — the divergence check only applies there. */
const LOCATABLE_FOR_DIVERGENCE = new Set(['assignment','claim','agent_run','plan','loop']);

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
 * Per-call context for the extracted entity write handlers. The function
 * members are mcp.ts helpers SHARED with other write domains (claims) or with
 * non-entity code, so they stay in the assembly point and are passed by
 * reference. `scopeInfo` is the per-call effective scope resolved once in the
 * executor.
 */
export interface McpWriteEntitiesContext {
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
  getCrossProjectArg: (args: Record<string, unknown>, ...keys: string[]) => string | undefined;
  createLegacyToolExecutionErrorResponse: (error: unknown) => McpToolResponse;
  scopeInfo: ResolvedEffectiveCwd;
}

export function handleBclawCreatePlan(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const crossProjectError = ctx.blockCrossProjectExecution('plan', args);
  if (crossProjectError) {
    return { response: crossProjectError };
  }
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }

  const planText = String(args.text ?? '').trim();
  if (!planText) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
  }

  // S2 (pln#623): scan write text on the MCP path (same control point as the CLI).
  const scan = scanMcpWriteText(planText, cwd);
  if (scan.blockResponse) return { response: scan.blockResponse };

  try {
    const created = createPlan({
      text: planText,
      author: resolved.identity!.agent_name,
      type: args.type as PlanType | undefined,
      priority: args.priority as Priority | undefined,
      assignee: args.assignee as string | undefined,
      project: args.project as string | undefined,
      tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
      relatedPaths: Array.isArray(args.related_paths) ? args.related_paths as string[] : undefined,
      dependsOn: Array.isArray(args.depends_on) ? args.depends_on as string[] : undefined,
      estimatedEffort: typeof args.estimate === 'number'
        ? args.estimate
        : typeof args.estimated_effort === 'number'
          ? args.estimated_effort
          : undefined,
    }, cwd);
    appendAuditEntry({
      actor: resolved.identity!.agent_name,
      actor_id: resolved.identity!.agent_id,
      action: 'create',
      item_id: created.id,
      item_type: 'plan',
    }, cwd);
    return {
      response: appendSecurityWarnings(toolResponse({
        content: [{ type: 'text', text: `✔ Plan added: [${created.shortLabel}] ${created.text}` }],
        plan_id: created.id,
        short_label: created.shortLabel,
        text: created.text,
      }), scan.warnings),
    };
  } catch (error: unknown) {
    return { response: ctx.createLegacyToolExecutionErrorResponse(error) };
  }
}

export function handleBclawCreateCandidate(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }

  const candidateText = String(args.text ?? '').trim();
  if (!candidateText) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: text') };
  }

  const candidateType = String(args.type ?? '').trim();
  if (!['constraint', 'decision', 'trap', 'handoff'].includes(candidateType)) {
    return { response: createToolErrorResponse('validation_error', 'type must be one of: constraint, decision, trap, handoff') };
  }

  // S2 (pln#623): scan write text on the MCP path (same control point as the CLI).
  const scan = scanMcpWriteText(candidateText, cwd);
  if (scan.blockResponse) return { response: scan.blockResponse };

  try {
    const created = createEntity('candidate', {
      text: candidateText,
      type: candidateType,
      author: resolved.identity!.agent_name,
      tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
      source: 'agent',
      ...(typeof args.origin === 'string' ? { origin: String(args.origin) } : {}),
      ...(typeof args.severity === 'string' ? { severity: String(args.severity) } : {}),
      ...(typeof args.from === 'string' ? { from: String(args.from) } : {}),
      ...(typeof args.to === 'string' ? { to: String(args.to) } : {}),
      ...(typeof args.narrative === 'string' ? { narrative: String(args.narrative) } : {}),
      ...(Array.isArray(args.related_paths) ? { related_paths: args.related_paths as string[] } : {}),
      ...(typeof args.plan_id === 'string' ? { plan_id: String(args.plan_id) } : {}),
    }, cwd);
    appendAuditEntry({
      actor: resolved.identity!.agent_name,
      actor_id: resolved.identity!.agent_id,
      action: 'create',
      item_id: created.id,
      item_type: 'candidate',
    }, cwd);

    const targetProjectArg = ctx.getCrossProjectArg(args, 'targetProject', 'target_project');
    if (targetProjectArg) {
      const signal = writeCrossProjectSignal(
        resolveCrossProjectWritableTarget(targetProjectArg, 'candidate', cwd),
        'candidate',
        loadCandidate(created.id, cwd),
        cwd,
      );
      return {
        response: appendSecurityWarnings(toolResponse({
          content: [{ type: 'text', text: `✔ Candidate created [${created.id}] and signaled to '${signal.target_project.name}' [${signal.id}]` }],
          candidate_id: created.id,
          short_label: created.short_label,
          signal_id: signal.id,
          entity_type: signal.entity_type,
          target_project: signal.target_project.name,
          target_path: signal.target_project.path,
        }), scan.warnings),
      };
    }

    return {
      response: appendSecurityWarnings(toolResponse({
        content: [{ type: 'text', text: `✔ Candidate created [${created.id}]` }],
        candidate_id: created.id,
        short_label: created.short_label,
      }), scan.warnings),
    };
  } catch (error: unknown) {
    return { response: ctx.createLegacyToolExecutionErrorResponse(error) };
  }
}

export function handleBclawAccept(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'by', idField: 'byId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  try {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
    }
    const result = acceptCandidate(id, resolved.identity!.agent_name, cwd, resolved.identity!.agent_id);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Promoted to ${result.candidate_type} [${result.promoted_item_id}]` }],
        candidate_id: result.candidate_id,
        candidate_type: result.candidate_type,
        promoted_item_id: result.promoted_item_id,
        actor: result.actor,
      }),
    };
  } catch (error: unknown) {
    return { response: ctx.createLegacyToolExecutionErrorResponse(error) };
  }
}

export function handleBclawReject(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'by', idField: 'byId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  try {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
    }
    const result = rejectCandidate(
      id,
      typeof args.reason === 'string' ? args.reason : undefined,
      resolved.identity!.agent_name,
      cwd,
      resolved.identity!.agent_id,
    );
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Candidate rejected [${result.candidate_id}]` }],
        candidate_id: result.candidate_id,
        actor: result.actor,
      }),
    };
  } catch (error: unknown) {
    return { response: ctx.createLegacyToolExecutionErrorResponse(error) };
  }
}

export function handleBclawDeletePlan(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const dpLoc = ctx.resolveExecutionWriteTarget('plan', args, cwd, connectionSessionId);
  if (dpLoc.block) {
    return { response: dpLoc.block };
  }
  const dpTargetCwd = dpLoc.targetCwd;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const dpId = String(args.id ?? '').trim();
  if (!dpId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  try {
    const result = deletePlanOp(dpId, dpTargetCwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Plan deleted: [${result.id}] ${result.text.slice(0, 80)}` }],
        plan_id: result.id,
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

export function handleBclawCorrectHandoff(payload: McpToolExecutionPayload, _ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  // Phase 3 slice 3e — P6.1 tombstone correction. Writes a new
  // handoff that supersedes the original. Both records stay on
  // disk (federation-safe); the original becomes pinned via
  // `superseded_by`.
  const originalId = String(args.originalId ?? '').trim();
  if (!originalId) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: originalId') };
  }
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const resolvedIdentity = resolved.identity!;
  const state = loadState(cwd);
  const original = state.open_handoffs.find((h) => h.id === originalId);
  if (!original) {
    return { response: createToolErrorResponse('not_found', `Handoff not found: ${originalId}`) };
  }
  if (original.superseded_by) {
    return { response: createToolErrorResponse('validation_error', `Handoff ${originalId} was already superseded by ${original.superseded_by}. Correct the current tip instead.`) };
  }
  // Phase 3 slice 3e fixup (Sonnet review #3): refuse to supersede a
  // handoff in a terminal status per EntityRegistry. A closed handoff
  // is immutable history — corrections would logically dangle.
  if (original.status && ENTITY_REGISTRY.handoff.terminal.includes(original.status)) {
    return { response: createToolErrorResponse('validation_error', `Handoff ${originalId} is in terminal status '${original.status}'. Cannot supersede a closed handoff.`) };
  }
  const { id: newId, short_label } = generateIdWithLabel('open_handoffs', cwd);
  const reason = typeof args.reason === 'string' && args.reason ? args.reason : undefined;
  const overrideText = typeof args.text === 'string' && args.text ? args.text : undefined;
  const correctionText = overrideText
    ?? `${original.text}\n\n---\n[correction] ${reason ?? 'superseded by later record'}`;
  const overrideNarrative = typeof args.narrative === 'string' && args.narrative ? args.narrative : original.narrative;
  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : original.tags;
  const correction = {
    ...original,
    id: newId,
    short_label,
    text: correctionText,
    narrative: overrideNarrative,
    tags,
    created_at: nowISO(),
    author: resolvedIdentity.agent_name,
    author_id: resolvedIdentity.agent_id,
    session_id: connectionSessionId,
    review: undefined,
    supersedes: originalId,
  };
  delete (correction as Record<string, unknown>).superseded_by;
  original.superseded_by = newId;
  state.open_handoffs.push(correction as typeof original);
  persistState(state, cwd);
  appendAuditEntry({
    actor: resolvedIdentity.agent_name,
    actor_id: resolvedIdentity.agent_id,
    action: 'create',
    item_id: newId,
    item_type: 'handoff',
    scope: `supersedes:${originalId}`,
  }, cwd);
  return {
    response: toolResponse({
      content: [{ type: 'text', text: `✔ correction handoff [${short_label ?? newId}] supersedes ${originalId}` }],
      id: newId,
      short_label,
      supersedes: originalId,
      schema_version: SCHEMA_VERSION,
    }),
  };
}

export function handleBclawUpdateHandoff(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const handoffId = String(args.id ?? '').trim();
  if (!handoffId) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  }
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const resolvedIdentity = resolved.identity!;
  const state = loadState(cwd);
  const handoff = state.open_handoffs.find((h) => h.id === handoffId);
  if (!handoff) {
    return { response: createToolErrorResponse('not_found', `Handoff not found: ${handoffId}`) };
  }
  applyHandoffUpdates(handoff, {
    status: args.status as 'open' | 'accepted' | 'closed' | undefined,
    to: typeof args.to === 'string' ? String(args.to) : undefined,
    narrative: typeof args.narrative === 'string' ? String(args.narrative) : undefined,
    files_touched: Array.isArray(args.files_touched) ? args.files_touched as string[] : undefined,
    pre_conditions: Array.isArray(args.pre_conditions) ? args.pre_conditions as string[] : undefined,
    post_conditions: Array.isArray(args.post_conditions) ? args.post_conditions as string[] : undefined,
    tests_to_verify: Array.isArray(args.tests_to_verify) ? args.tests_to_verify as string[] : undefined,
    linked_plans: Array.isArray(args.linked_plans) ? args.linked_plans as string[] : undefined,
    reviewer: typeof args.reviewer === 'string' ? String(args.reviewer) : undefined,
    review_verdict: args.review_verdict as 'approve' | 'request_changes' | undefined,
    reviewed_by: typeof args.reviewed_by === 'string' ? String(args.reviewed_by) : undefined,
    review_summary: typeof args.review_summary === 'string' ? String(args.review_summary) : undefined,
    blocking_issues: Array.isArray(args.blocking_issues) ? args.blocking_issues as string[] : undefined,
    suggestions: Array.isArray(args.suggestions) ? args.suggestions as string[] : undefined,
  });
  saveState(state, cwd);
  appendAuditEntry({ actor: resolvedIdentity.agent_name, actor_id: resolvedIdentity.agent_id, action: 'update', item_id: handoffId, item_type: 'handoff' }, cwd);
  const targetProjectArg = ctx.getCrossProjectArg(args, 'targetProject', 'target_project');
  if (targetProjectArg) {
    try {
      const targetLink = resolveCrossProjectWritableTarget(targetProjectArg, 'handoff', cwd);
      const signal = writeCrossProjectSignal(targetLink, 'handoff', handoff, cwd);
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Handoff updated locally and signaled to ${targetLink.projectName} [${signal.id}]` }],
          signal_id: signal.id,
          entity_type: signal.entity_type,
          handoff_id: handoffId,
          status: handoff.status,
          to: handoff.to,
          review: handoff.review,
          target_project: targetLink.projectName,
          target_path: targetLink.absolutePath,
          schema_version: SCHEMA_VERSION,
        }),
      };
    } catch (error: unknown) {
      return { response: createToolErrorResponse('validation_error', error instanceof Error ? error.message : String(error)) };
    }
  }
  return {
    response: toolResponse({
      content: [{ type: 'text', text: `✔ Handoff updated: [${handoffId}] ${handoff.from} → ${handoff.to} (${handoff.status})` }],
      handoff_id: handoffId,
      status: handoff.status,
      to: handoff.to,
      review: handoff.review,
      schema_version: SCHEMA_VERSION,
    }),
  };
}

export function handleBclawCreate(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  try {
    const entity = String(args.entity ?? '') as EntityName;
    // Execution entities (plan/claim) auto-localize into a workspace sibling
    // when project=X names one: session+switch then write locally. Only
    // federated links / unknown names are blocked (signaling-only boundary).
    let targetCwd: string;
    let autoSwitched = false;
    if (entity === 'claim' || entity === 'plan') {
      const loc = ctx.resolveExecutionWriteTarget(entity, args, cwd, connectionSessionId);
      if (loc.block) return { response: loc.block };
      targetCwd = loc.targetCwd;
      autoSwitched = loc.autoSwitched;
    } else {
      targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
    }
    const rawData = (args.data ?? {}) as Record<string, unknown>;
    const targetScope = scopeMetadataForTarget(args, targetCwd, ctx.scopeInfo);

    // Auto-fill identity fields. Without this, a caller who omits author/agent
    // creates a schema-invalid record that is silently dropped on read and
    // GC'd from disk on the next mutation.
    // Identity is resolved against the SOURCE cwd (the agent's own
    // project/registry), not the target — an agent doesn't need to be
    // registered in the target project to write into it. An explicitly
    // supplied data.author is honored as content-level attribution
    // (cross-project signaling writers may not be registered locally);
    // when author is MISSING, resolution is mandatory and failure is a
    // hard validation_error (pln#562 step 3) — never author:'unknown'.
    const data: Record<string, unknown> = { ...rawData };
    let actor = typeof data.author === 'string' ? data.author : undefined;
    let actorId = typeof data.agent_id === 'string' ? data.agent_id : undefined;
    let autoRepair: CanonicalAuthorAutoRepair | undefined;
    if (data.author === undefined) {
      const author = resolveCanonicalAuthor(args, cwd, connectionSessionId);
      data.author = author.agent_name;
      if (data.agent === undefined) data.agent = author.agent_name;
      if (data.agent_id === undefined && author.agent_id) data.agent_id = author.agent_id;
      actor = author.agent_name;
      actorId = author.agent_id;
      autoRepair = author.auto_repair;
    } else if (data.agent === undefined) {
      data.agent = data.author;
    }

    // S2 (pln#623): scan the primary text field on the MCP path, mirroring the
    // CLI write adapters (which scan the entity text before persisting).
    const createScan = scanMcpWriteText(typeof data.text === 'string' ? data.text : '', targetCwd);
    if (createScan.blockResponse) return { response: createScan.blockResponse };

    const result = createEntity(entity, data, targetCwd);
    appendAuditEntry(
      { actor: actor ?? 'unknown', ...(actorId ? { actor_id: actorId } : {}), action: 'create', item_id: result.id, item_type: entity },
      targetCwd,
    );
    const createText = `✔ created ${entity} ${result.id}${autoSwitched ? ` (auto-switched → ${targetScope.resolved_project.name ?? targetScope.resolved_project.path})` : ''}`;
    const createContent = autoRepair
      ? [{ type: 'text' as const, text: createText }, { type: 'text' as const, text: renderAutoRepairWarning(autoRepair, actor ?? 'unknown') }]
      : [{ type: 'text' as const, text: createText }];
    // pln#634 — a freshly created plan whose steps are never added is the most
    // common half-finished shape in the store; a sequence with no readiness
    // check is the second. Only those two emit a follow-up.
    const createActions = createEntityNextActions({ entity, id: result.id });
    return {
      response: appendSecurityWarnings(toolResponse({
        content: createContent,
        structuredContent: {
          ...result,
          resolved_project: targetScope.resolved_project,
          active_source: autoSwitched ? 'auto_switch' : targetScope.active_source,
          ...(autoSwitched ? { auto_switched: true } : {}),
          ...(autoRepair ? { auto_repair: autoRepair } : {}),
          ...(createActions.length ? { next_actions: createActions } : {}),
        },
      }), createScan.warnings),
    };
  } catch (error: unknown) {
    return { response: createToolErrorResponse('validation_error', (error as Error).message) };
  }
}

export function handleBclawUpdate(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  try {
    const entity = String(args.entity ?? '') as EntityName;
    const id = String(args.id ?? '');
    const patch = (args.patch ?? {}) as Record<string, unknown>;
    const targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
    const targetScope = scopeMetadataForTarget(args, targetCwd, ctx.scopeInfo);
    const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
    // S2 (pln#623): scan the patched text field on the MCP path (CLI parity).
    const updateScan = scanMcpWriteText(typeof patch.text === 'string' ? patch.text : '', targetCwd);
    if (updateScan.blockResponse) return { response: updateScan.blockResponse };
    const result = updateEntity(entity, id, patch, targetCwd);
    appendAuditEntry(
      { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'update', item_id: id, item_type: entity },
      targetCwd,
    );
    const updateText = `✔ updated ${entity} ${id}`;
    const updateContent = auto_repair
      ? [{ type: 'text' as const, text: updateText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
      : [{ type: 'text' as const, text: updateText }];
    return {
      response: appendSecurityWarnings(toolResponse({
        content: updateContent,
        structuredContent: {
          ...result,
          resolved_project: targetScope.resolved_project,
          active_source: targetScope.active_source,
          ...(auto_repair ? { auto_repair } : {}),
        },
      }), updateScan.warnings),
    };
  } catch (error: unknown) {
    return { response: createToolErrorResponse('validation_error', (error as Error).message) };
  }
}

export function handleBclawRemove(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  try {
    const entity = String(args.entity ?? '') as EntityName;
    const id = String(args.id ?? '');
    const purge = args.purge === true;
    const targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
    const targetScope = scopeMetadataForTarget(args, targetCwd, ctx.scopeInfo);
    const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
    const result = removeEntity(entity, id, targetCwd, purge);
    appendAuditEntry(
      { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'delete', item_id: id, item_type: entity, reason: purge ? 'purged' : 'archived' },
      targetCwd,
    );
    const removeText = `✔ removed ${entity} ${id}`;
    const removeContent = auto_repair
      ? [{ type: 'text' as const, text: removeText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
      : [{ type: 'text' as const, text: removeText }];
    return {
      response: toolResponse({
        content: removeContent,
        structuredContent: {
          ...result,
          resolved_project: targetScope.resolved_project,
          active_source: targetScope.active_source,
          ...(auto_repair ? { auto_repair } : {}),
        },
      }),
    };
  } catch (error: unknown) {
    return { response: createToolErrorResponse('validation_error', (error as Error).message) };
  }
}

export function handleBclawMove(payload: McpToolExecutionPayload, _ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  try {
    const entity = String(args.entity ?? '') as EntityName;
    const id = String(args.id ?? '');
    const toProject = String(args.to_project ?? '');
    const fromProject = typeof args.from_project === 'string' ? args.from_project : undefined;
    const force = args.force === true;
    const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
    const result = relocateEntity({ entity, id, toProject, fromProject, force, cwd, actor: agent_name, actorId: agent_id });
    const warn = result.warnings.length ? ` (${result.warnings.length} warning(s))` : '';
    const moveText = `✔ moved ${entity} ${id} → ${result.to}${warn}`;
    const moveContent = auto_repair
      ? [{ type: 'text' as const, text: moveText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
      : [{ type: 'text' as const, text: moveText }];
    return {
      response: toolResponse({
        content: moveContent,
        structuredContent: {
          ...result,
          ...(auto_repair ? { auto_repair } : {}),
        },
      }),
    };
  } catch (error: unknown) {
    return { response: createToolErrorResponse('validation_error', (error as Error).message) };
  }
}

export function handleBclawTransition(payload: McpToolExecutionPayload, ctx: McpWriteEntitiesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  try {
    const entity = String(args.entity ?? '') as EntityName;
    // Same auto-localize as bclaw_create: a workspace sibling named by
    // project=X is switched into and transitioned locally; only federated
    // links / unknown names are blocked (signaling-only boundary).
    let targetCwd: string;
    let autoSwitched = false;
    if (entity === 'claim' || entity === 'plan') {
      const loc = ctx.resolveExecutionWriteTarget(entity, args, cwd, connectionSessionId);
      if (loc.block) return { response: loc.block };
      targetCwd = loc.targetCwd;
      autoSwitched = loc.autoSwitched;
    } else {
      targetCwd = resolveProjectCwd(args.project as string | undefined, cwd);
    }
    const id = String(args.id ?? '');
    const to = String(args.to ?? '');
    const reason = args.reason as string | undefined;

    // ── pln#649 / dec#153: ENTITY vs EXPLICIT PROJECT, the first divergence with a
    // real consumer. This is the ONLY canonical-grammar surface where both authorities
    // are supplied at once — an entity id AND `project=` — and it is the very call
    // documented in trp#1327 as the coordinator's workaround, so operators reach it.
    //
    // Today a divergence produces a misleading `not found in <B>`: the record exists,
    // just not where the caller named. dec#153 says an explicit divergence must be
    // REFUSED and NAMED, so the caller learns which of their two statements was wrong
    // instead of doubting the id.
    //
    // Disclosure rule from the two routed surfaces: the caller already knows the
    // project they typed, so naming it back is free — but WHERE the entity really
    // lives is new information, so that is a count, not a name.
    if (args.project !== undefined && id && isLocatableId(id) && LOCATABLE_FOR_DIVERGENCE.has(entity)) {
      const located = locateEntity(entity as LocatableEntity, id, cwd);
      const target = path.resolve(targetCwd);
      const inTarget = located.matches.some((m) => path.resolve(m.cwd) === target);
      if (located.matches.length > 0 && !inTarget) {
        return {
          response: createToolErrorResponse(
            'validation_error',
            `${entity} '${id}' does not live in project '${String(args.project)}' — it exists in `
            + `${located.matches.length} other reachable project(s). Refusing: the entity and the project you named `
            + 'disagree, and guessing which one you meant is how a write lands in the wrong project. '
            + 'Drop `project` to be routed by the entity, or name the project that owns it.',
            { entity, id, requested_project: String(args.project), located_elsewhere_count: located.matches.length },
          ),
        };
      }
    }

    const targetScope = scopeMetadataForTarget(args, targetCwd, ctx.scopeInfo);
    const { agent_name, agent_id, auto_repair } = resolveCanonicalAuthor(args, cwd, connectionSessionId);
    // trp#928 — claim transitions consume the ReleaseClaimAuth ownership
    // check (released/stale both mutate a claim owned by SOME agent). Reuse
    // the same coordinator_override opt-in as bclaw_release_claim so both
    // paths have identical trust semantics and the same executable error.
    let transitionAuth: TransitionAuth | undefined;
    if (entity === 'claim') {
      const transitionIdentity = resolveMutationIdentity(args, { nameField: 'agent', idField: 'agentId' }, targetCwd, connectionSessionId);
      const coordinatorOverrideRequested = args.coordinator_override === true;
      if (coordinatorOverrideRequested) {
        const identity = 'identity' in transitionIdentity ? transitionIdentity.identity : undefined;
        const trustLevel = identity?.trust_level ?? 'contributor';
        if (!hasMinimumTrustLevel(trustLevel, 'trusted')) {
          return {
            response: createToolErrorResponse(
              'trust_error',
              `coordinator_override:true requires trust_level 'trusted' or higher — caller is '${trustLevel}'.`,
            ),
          };
        }
      }
      transitionAuth = 'identity' in transitionIdentity && transitionIdentity.identity
        ? {
            agent: transitionIdentity.identity.agent_name,
            agent_id: transitionIdentity.identity.agent_id,
            session_id: connectionSessionId,
            override: coordinatorOverrideRequested,
          }
        : undefined;
    }
    const result = transitionEntity(entity, id, to, targetCwd, reason, transitionAuth);
    appendAuditEntry(
      { actor: agent_name, ...(agent_id ? { actor_id: agent_id } : {}), action: 'update', item_id: id, item_type: entity, reason: `transition ${result.from} → ${to}${reason ? ` (${reason})` : ''}` },
      targetCwd,
    );
    const transitionText = `✔ ${entity} ${id}: ${result.from} → ${to}${autoSwitched ? ` (auto-switched → ${targetScope.resolved_project.name ?? targetScope.resolved_project.path})` : ''}`;
    const transitionContent = auto_repair
      ? [{ type: 'text' as const, text: transitionText }, { type: 'text' as const, text: renderAutoRepairWarning(auto_repair, agent_name) }]
      : [{ type: 'text' as const, text: transitionText }];
    // pln#634 — only the two transitions that imply an unambiguous next call
    // emit anything (plan → in_progress / blocked); everything else is terminal
    // for the caller and returns nothing rather than inventing busywork.
    const transitionActions = transitionNextActions({ entity, id, to });
    return {
      response: toolResponse({
        content: transitionContent,
        structuredContent: {
          ...result,
          resolved_project: targetScope.resolved_project,
          active_source: autoSwitched ? 'auto_switch' : targetScope.active_source,
          ...(autoSwitched ? { auto_switched: true } : {}),
          ...(auto_repair ? { auto_repair } : {}),
          ...(transitionActions.length ? { next_actions: transitionActions } : {}),
        },
      }),
    };
  } catch (error: unknown) {
    return { response: createToolErrorResponse('validation_error', (error as Error).message) };
  }
}
