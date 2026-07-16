/**
 * MCP memory write-tool handlers.
 *
 * Extracted from mcp.ts (pln#622 PR4) — mechanical move of the note /
 * quick-capture / compaction / memory-item mutation / candidate-harvest write
 * handlers. Behavior is unchanged; each handler receives the tool-call payload
 * plus a {@link McpWriteMemoryContext} carrying the model resolved once per
 * write call plus the two mcp.ts-local helpers these handlers reference
 * (session-id-from-env and the cross-project arg reader), passed by reference
 * so this module never imports ./mcp.js (dependency-direction guard, PR1).
 *
 * @module
 */
import { writeCrossProjectSignal, resolveCrossProjectWritableTarget } from '../core/cross-project.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO, generateId } from '../core/ids.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { validateMcpInput, validateMcpField } from '../core/input-validation.js';
import type { CandidateType, MemoryVisibility } from '../core/schema.js';
import type { StoreTarget } from '../core/store-resolution.js';
import { deleteMemoryItem, updateMemoryItem, type MemoryItemType } from '../core/operations/memory-mutation.js';
import { assessMemoryPressure, buildCompactionTemplate, applyCompaction } from '../core/gc-semantic.js';
import { createRuntimeNote } from './runtime-note.js';
import { createCandidateFromInput } from './reflect.js';
import { harvestCandidates } from './harvest.js';
import { ensureTrust } from './mcp-write-support.js';
import {
  toolResponse,
  createToolErrorResponse,
  type McpToolExecutionPayload,
  type McpToolExecutionOutcome,
} from './mcp-contract.js';

/**
 * Per-call context for the extracted memory write handlers. `currentModel` is
 * resolved once per write call at the mcp.ts assembly point; the function
 * members are mcp.ts helpers passed by reference (they remain in mcp.ts because
 * they are shared with other write domains and read paths).
 */
export interface McpWriteMemoryContext {
  /** Model resolved once for all write operations in the assembly point. */
  currentModel?: string;
  explicitSessionIdFromEnv: () => string | undefined;
  getCrossProjectArg: (args: Record<string, unknown>, ...keys: string[]) => string | undefined;
}

// ── Quick-capture keyword classification (memory-only, moved from mcp.ts) ────

interface QuickCaptureClassification {
  target: 'decision' | 'trap' | 'constraint' | 'note';
  reason: string;
  decisionScore: number;
  trapScore: number;
}

function scoreKeywordMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function classifyQuickCapture(text: string): QuickCaptureClassification {
  const normalized = text.trim().toLowerCase();
  const decisionPatterns = [
    /\b(decide|decision|decided|prefer|preferred|policy|convention|standard|standardize|adopt|chosen|choose|settled on)\b/,
    /\b(use|default to|go with|route through|switch to|migrate to|move to)\b/,
    /^(use|prefer|adopt|standardize|route|switch|migrate)\b/,
  ];
  const trapPatterns = [
    /\b(trap|warning|beware|avoid|never|don't|do not|risk|risky|gotcha|workaround)\b/,
    /\b(bug|broken|breaks|failure|fails|failing|flaky|blocked|missing|crash|regression|timeout|deadlock|race condition|leak)\b/,
    /\b(error|incident|problem|issue|hang|stuck|retry)\b/,
  ];

  const decisionScore = scoreKeywordMatches(normalized, decisionPatterns);
  const trapScore = scoreKeywordMatches(normalized, trapPatterns);

  if (decisionScore > 0 && trapScore > 0 && Math.abs(decisionScore - trapScore) <= 1) {
    return {
      target: 'note',
      reason: 'ambiguous_keywords',
      decisionScore,
      trapScore,
    };
  }

  if (trapScore >= 2 && trapScore >= decisionScore + 1) {
    return {
      target: 'trap',
      reason: 'trap_keywords',
      decisionScore,
      trapScore,
    };
  }

  if (decisionScore >= 2 && decisionScore >= trapScore + 1) {
    return {
      target: 'decision',
      reason: 'decision_keywords',
      decisionScore,
      trapScore,
    };
  }

  return {
    target: 'note',
    reason: decisionScore === trapScore && decisionScore > 0 ? 'ambiguous_keywords' : 'low_confidence',
    decisionScore,
    trapScore,
  };
}

function formatQuickCaptureNoteText(text: string, context?: string): string {
  if (!context) {
    return text;
  }
  return `${text}\n\nContext: ${context}`;
}

// ── Handlers ─────────────────────────────────────────────────────────────

export function handleBclawWriteNote(payload: McpToolExecutionPayload, ctx: McpWriteMemoryContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const text = String(args.text ?? '');
  const tags = (args.tags as string[] | undefined) ?? [];
  const inputValidation = validateMcpInput(text, tags);
  if (!inputValidation.ok) {
    return { response: createToolErrorResponse('validation_error', inputValidation.errors[0]?.message ?? 'Invalid input', inputValidation.errors) };
  }
  const identity = resolved.identity!;

  // Cross-project push
  const crossProjectTarget = ctx.getCrossProjectArg(args, 'crossProject', 'cross_project');
  if (crossProjectTarget) {
    try {
      const opIdentity = buildOperationalIdentity(identity.agent_name, cwd, {
        agentId: identity.agent_id,
        sessionId: connectionSessionId,
      });
      const signal = writeCrossProjectSignal(
        resolveCrossProjectWritableTarget(crossProjectTarget, 'runtime_note', cwd),
        'runtime_note',
        {
          schema_version: 2,
          id: generateId('runtime_note'),
          agent: opIdentity.agent,
          agent_id: opIdentity.agent_id,
          project_id: opIdentity.project_id ?? '',
          session_id: opIdentity.session_id,
          text,
          created_at: nowISO(),
          tags,
          visibility: 'shared',
          host_id: opIdentity.host_id ?? '',
          note_type: 'observation',
        },
        cwd,
      );
      return {
        response: toolResponse({
          content: [{ type: 'text', text: `✔ Cross-project runtime note signaled to '${signal.target_project.name}' [${signal.id}]` }],
          signal_id: signal.id,
          entity_type: signal.entity_type,
          note_id: (signal.payload as { id: string }).id,
          target_project: signal.target_project.name,
          target_path: signal.target_project.path,
        }),
      };
    } catch (e: unknown) {
      return { response: createToolErrorResponse('validation_error', e instanceof Error ? e.message : String(e)) };
    }
  }

  const result = createRuntimeNote(text, {
    agent: identity.agent_name,
    agentId: identity.agent_id,
    tag: tags,
    visibility: (args.visibility as MemoryVisibility | undefined) ?? 'shared',
    ttl: args.ttl as string | undefined,
    autoReflect: args.autoReflect as boolean | undefined,
    cwd,
    sessionId: connectionSessionId,
    model: ctx.currentModel,
  }, false);
  return {
    response: toolResponse({
      content: [{ type: 'text', text: `✔ Note created [${result.noteId}]` }],
      note_id: result.noteId,
      session_id: result.sessionId,
      auto_reflect_attempted: result.autoReflectAttempted,
      detected_type: result.detectedType,
      candidate_id: result.candidateId,
      promoted_item_id: result.promotedItemId,
      skip_reason: result.skipReason,
    }),
    nextConnectionSessionId: ctx.explicitSessionIdFromEnv() ? undefined : result.sessionId,
  };
}

export function handleBclawQuickCapture(payload: McpToolExecutionPayload, ctx: McpWriteMemoryContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }

  const text = String(args.text ?? '');
  const inputValidation = validateMcpInput(text);
  if (!inputValidation.ok) {
    return { response: createToolErrorResponse('validation_error', inputValidation.errors[0]?.message ?? 'Invalid input', inputValidation.errors) };
  }

  const context = typeof args.context === 'string' ? args.context.trim() : undefined;
  if (context) {
    const contextCheck = validateMcpField(context, 'context');
    if (!contextCheck.ok) {
      return { response: createToolErrorResponse('validation_error', contextCheck.message) };
    }
  }

  const identity = resolved.identity!;
  // Caller-asserted classification wins (pln#542): the calling agent
  // declares decision/trap/constraint/note; keyword heuristics are the
  // fallback when no type is given.
  const assertedType = typeof args.type === 'string' ? args.type.trim().toLowerCase() : undefined;
  let classification: QuickCaptureClassification;
  if (assertedType === 'decision' || assertedType === 'trap' || assertedType === 'constraint' || assertedType === 'note') {
    classification = { target: assertedType, reason: 'caller_asserted', decisionScore: 0, trapScore: 0 };
  } else if (assertedType !== undefined) {
    return { response: createToolErrorResponse('validation_error', `type must be one of: decision, trap, constraint, note (got '${assertedType}')`) };
  } else {
    classification = classifyQuickCapture(text);
  }
  if (classification.target === 'note') {
    const result = createRuntimeNote(formatQuickCaptureNoteText(text, context), {
      agent: identity.agent_name,
      agentId: identity.agent_id,
      tag: ['quick-capture'],
      visibility: 'shared',
      cwd,
      sessionId: connectionSessionId,
      model: ctx.currentModel,
    }, false);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Quick capture saved as runtime note [${result.noteId}]` }],
        structuredContent: {
          classification: classification.target,
          classification_reason: classification.reason,
          decision_score: classification.decisionScore,
          trap_score: classification.trapScore,
          note_id: result.noteId,
          session_id: result.sessionId,
          context,
          next_actions: [
            { tool: 'bclaw_quick_capture', args: { text: '<same text>', type: 'decision' }, when: 'this was actually a durable decision/trap/constraint — re-capture with an asserted type' },
          ],
        },
      }),
      nextConnectionSessionId: ctx.explicitSessionIdFromEnv() ? undefined : result.sessionId,
    };
  }

  const capture = createCandidateFromInput(text, classification.target, {
    tag: ['quick-capture'],
    author: identity.agent_name,
    authorId: identity.agent_id,
    sessionId: connectionSessionId,
    source: 'mcp:quick-capture',
    path: context,
    cwd,
  }, false, false, true);

  const statusText = capture.writeThrough
    ? `✔ Quick capture promoted as ${classification.target} [${capture.promotedItemId}]`
    : `✔ Quick capture saved as ${classification.target} candidate [${capture.candidateId}]`;
  const captureNextActions = capture.writeThrough
    ? [
        { tool: 'bclaw_get', args: { entity: classification.target, id: capture.promotedItemId }, when: 'to verify the promoted item' },
      ]
    : [
        { tool: 'bclaw_get', args: { entity: 'candidate', id: capture.candidateId }, when: 'to review the pending candidate (contradiction metadata is advisory)' },
      ];
  return {
    response: toolResponse({
      content: [{ type: 'text', text: statusText }],
      structuredContent: {
        classification: classification.target,
        classification_reason: classification.reason,
        decision_score: classification.decisionScore,
        trap_score: classification.trapScore,
        candidate_id: capture.candidateId,
        promoted_item_id: capture.promotedItemId,
        write_through: capture.writeThrough,
        // Advisory only (cnd_abe61d68): contradictions are metadata on
        // the candidate, never a promotion blocker.
        contradiction_summary: capture.contradictionSummary,
        contradictions_detected: capture.contradictionsDetected?.map((item) => ({
          severity: item.severity,
          reason: item.reason,
          conflicts_with: item.conflicts_with,
        })),
        context,
        next_actions: captureNextActions,
      },
    }),
  };
}

export function handleBclawCompact(payload: McpToolExecutionPayload, _ctx: McpWriteMemoryContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }

  const archiveIds = args.archiveIds as string[] | undefined;
  const isPhase2 = archiveIds && archiveIds.length > 0;

  if (isPhase2) {
    // Phase 2: apply compaction — archive specified items and create new memories
    const result = applyCompaction({
      archiveIds,
      newItems: args.newItems as Array<{ type: 'constraint' | 'decision' | 'trap'; text: string; tags?: string[]; severity?: string }> | undefined,
      author: resolved.identity?.agent_name,
      authorId: resolved.identity?.agent_id,
      cwd,
    });

    const lines: string[] = [];
    lines.push(`✔ Compacted ${result.archived_count} item(s).`);
    if (result.created_count > 0) {
      lines.push(`Created ${result.created_count} new memory item(s): ${result.created_ids.join(', ')}`);
    }
    lines.push(`Backup: ${result.backup_path}`);

    return {
      response: toolResponse({
        content: [{ type: 'text', text: lines.join('\n') }],
        ...result,
      }),
    };
  }

  // Phase 1: assess pressure and return compaction template
  const assessment = assessMemoryPressure(cwd);
  const maxItems = (args.maxItems as number | undefined) ?? 20;
  const selected = assessment.eligible_items.slice(0, maxItems);
  const template = selected.length > 0 ? buildCompactionTemplate(selected) : undefined;

  const lines: string[] = [];
  lines.push(`Memory pressure: ${assessment.pressure ? 'YES' : 'no'} (${assessment.done_plans} done plans, ${assessment.closed_handoffs} closed handoffs)`);
  lines.push(`Thresholds: plans >= ${assessment.thresholds.plans}, handoffs >= ${assessment.thresholds.handoffs}`);
  lines.push(`Eligible items: ${assessment.eligible_items.length}`);

  if (template) {
    lines.push('');
    lines.push(template);
  } else {
    lines.push('No items eligible for compaction.');
  }

  return {
    response: toolResponse({
      content: [{ type: 'text', text: lines.join('\n') }],
      pressure: assessment.pressure,
      done_plans: assessment.done_plans,
      closed_handoffs: assessment.closed_handoffs,
      eligible_count: assessment.eligible_items.length,
      eligible_ids: selected.map(i => i.id),
    }),
  };
}

export function handleBclawDeleteMemory(payload: McpToolExecutionPayload, _ctx: McpWriteMemoryContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const itemId = String(args.id ?? '').trim();
  const itemType = String(args.type ?? '').trim();
  if (!itemId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  if (!itemType) return { response: createToolErrorResponse('validation_error', 'Missing required argument: type') };
  if (!['constraint', 'decision', 'trap'].includes(itemType)) {
    return { response: createToolErrorResponse('validation_error', `Invalid type: ${itemType}`) };
  }
  try {
    const result = deleteMemoryItem(itemId, itemType as MemoryItemType, cwd);
    appendAuditEntry(
      { actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'delete', item_id: itemId, item_type: itemType as CandidateType },
      cwd,
    );
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Deleted [${itemId}] (${itemType})` }],
        deleted_id: result.deletedId,
        item_type: result.itemType,
        store_level: result.storeRole,
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

export function handleBclawUpdateMemory(payload: McpToolExecutionPayload, _ctx: McpWriteMemoryContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const itemId = String(args.id ?? '').trim();
  const itemType = String(args.type ?? '').trim();
  const newText = args.text ? String(args.text).trim() : undefined;
  const newTags = Array.isArray(args.tags) ? args.tags.map((t) => String(t).trim()) : undefined;
  const newStatus = args.status ? String(args.status).trim() : undefined;
  const moveToStore = args.moveToStore ? String(args.moveToStore).trim() : undefined;

  if (!itemId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  if (!itemType) return { response: createToolErrorResponse('validation_error', 'Missing required argument: type') };
  if (!['constraint', 'decision', 'trap'].includes(itemType)) {
    return { response: createToolErrorResponse('validation_error', `Invalid type for update: ${itemType}`) };
  }
  if (!newText && !newTags && !newStatus && !moveToStore) {
    return { response: createToolErrorResponse('validation_error', 'At least one of text, tags, status, or moveToStore must be provided') };
  }
  if (moveToStore && !['local', 'repo', 'workspace', 'user'].includes(moveToStore)) {
    return { response: createToolErrorResponse('validation_error', `Invalid moveToStore target: ${moveToStore}`) };
  }
  if (newStatus && itemType !== 'trap') {
    return { response: createToolErrorResponse('validation_error', 'status updates are only supported for traps') };
  }
  if (newStatus && !['active', 'resolved', 'expired'].includes(newStatus)) {
    return { response: createToolErrorResponse('validation_error', `Invalid trap status: ${newStatus}`) };
  }
  try {
    const result = updateMemoryItem({
      id: itemId,
      type: itemType as MemoryItemType,
      text: newText,
      tags: newTags,
      status: newStatus,
      moveToStore: moveToStore as StoreTarget | undefined,
    }, cwd);
    appendAuditEntry(
      { actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: itemId, item_type: itemType as CandidateType },
      cwd,
    );
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Updated [${itemId}] (${itemType})` }],
        updated_id: result.updatedId,
        item_type: result.itemType,
        previous_store: result.previousStore,
        new_store: result.newStore,
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

export function handleBclawHarvestCandidates(payload: McpToolExecutionPayload, _ctx: McpWriteMemoryContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const resolvedIdentity = resolved.identity!;
  const worktreePaths = Array.isArray(args.worktreePaths) ? (args.worktreePaths as string[]) : undefined;
  const dryRun = args.dryRun === true;
  const harvestResult = harvestCandidates({
    worktreePaths,
    dryRun,
    cwd,
    agent: resolvedIdentity.agent_name,
  });
  const dryTag = dryRun ? ' (dry-run)' : '';
  const summary = `✔ Harvest complete${dryTag}: ${harvestResult.harvested.length} imported, ${harvestResult.skipped.length} skipped, ${harvestResult.errors.length} error(s).`;
  return {
    response: toolResponse({
      content: [{ type: 'text', text: summary }],
      harvested: harvestResult.harvested.length,
      skipped: harvestResult.skipped.length,
      errors: harvestResult.errors,
      candidates: harvestResult.harvested.map((c) => ({ id: c.id, type: c.type })),
      dry_run: dryRun,
    }),
  };
}
