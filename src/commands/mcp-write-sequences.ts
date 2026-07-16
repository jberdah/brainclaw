/**
 * MCP sequence write-tool handlers.
 *
 * Extracted from mcp.ts (pln#622 PR4) — mechanical move of the
 * create / update / delete sequence write handlers. Behavior is unchanged;
 * each handler receives the tool-call payload plus a
 * {@link McpWriteSequencesContext} carrying the model resolved once per write
 * call at the assembly point.
 *
 * This module must never import ./mcp.js (dependency-direction guard,
 * pln#622 PR1).
 *
 * @module
 */
import { appendAuditEntry } from '../core/audit.js';
import { createSequence, updateSequence, deleteSequence } from '../core/sequence.js';
import type { SequenceItemInput, SequenceStatus } from '../core/schema.js';
import { ensureTrust } from './mcp-write-support.js';
import {
  toolResponse,
  createToolErrorResponse,
  type McpToolExecutionPayload,
  type McpToolExecutionOutcome,
} from './mcp-contract.js';

/**
 * Per-call context for the extracted sequence write handlers. `currentModel`
 * is resolved once per write call at the mcp.ts assembly point and stamped on
 * newly created sequences.
 */
export interface McpWriteSequencesContext {
  /** Model resolved once for all write operations in the assembly point. */
  currentModel?: string;
}

export function handleBclawCreateSequence(payload: McpToolExecutionPayload, ctx: McpWriteSequencesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const sequenceName = String(args.name ?? '').trim();
  if (!sequenceName) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: name') };
  }
  try {
    const result = createSequence({
      name: sequenceName,
      description: args.description as string | undefined,
      status: args.status as SequenceStatus | undefined,
      owner: args.owner as string | undefined,
      items: Array.isArray(args.items) ? args.items as SequenceItemInput[] : [],
      tags: Array.isArray(args.tags) ? args.tags as string[] : [],
      author: resolved.identity!.agent_name,
      authorId: resolved.identity!.agent_id,
      model: ctx.currentModel,
    }, cwd);
    appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'create', item_id: result.id, item_type: 'sequence' }, cwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Sequence added: [${result.id}] ${sequenceName}` }],
        sequence_id: result.id,
      }),
    };
  } catch (err: unknown) {
    return { response: createToolErrorResponse('operation_error', err instanceof Error ? err.message : String(err)) };
  }
}

export function handleBclawUpdateSequence(payload: McpToolExecutionPayload, _ctx: McpWriteSequencesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'contributor', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const sequenceId = String(args.id ?? '').trim();
  if (!sequenceId) {
    return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  }
  try {
    const result = updateSequence({
      id: sequenceId,
      name: args.name as string | undefined,
      description: args.description as string | undefined,
      status: args.status as SequenceStatus | undefined,
      owner: args.owner as string | undefined,
      items: Array.isArray(args.items) ? args.items as SequenceItemInput[] : undefined,
      tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
    }, cwd);
    appendAuditEntry({ actor: resolved.identity!.agent_name, actor_id: resolved.identity!.agent_id, action: 'update', item_id: result.id, item_type: 'sequence' }, cwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Sequence updated: [${result.id}] ${result.name}` }],
        sequence_id: result.id,
        status: result.status,
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

export function handleBclawDeleteSequence(payload: McpToolExecutionPayload, _ctx: McpWriteSequencesContext): McpToolExecutionOutcome {
  const { args, cwd, connectionSessionId } = payload;
  const resolved = ensureTrust(args, { nameField: 'agent', idField: 'agentId' }, 'trusted', cwd, connectionSessionId);
  if (resolved.error) {
    return { response: createToolErrorResponse(resolved.error.kind, resolved.error.message, resolved.error.details) };
  }
  const dsqId = String(args.id ?? '').trim();
  if (!dsqId) return { response: createToolErrorResponse('validation_error', 'Missing required argument: id') };
  try {
    const result = deleteSequence(dsqId, cwd);
    return {
      response: toolResponse({
        content: [{ type: 'text', text: `✔ Sequence deleted: [${result.id}] ${result.name}` }],
        sequence_id: result.id,
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
