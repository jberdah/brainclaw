/**
 * MCP protocol contract — schema version, wire/protocol constants and types,
 * tool-call envelope types, the success/error response envelopes, and the
 * pure format normaliser.
 *
 * Extracted from mcp.ts (pln#622 PR1). This module is intentionally PURE:
 * node builtins and type-only imports at most — no runtime dependency on any
 * business module — so every MCP-facing module (read handlers, presentation,
 * catalog, worker) can import it without creating an import cycle through
 * the mcp.ts assembly point.
 *
 * @module
 */
import type { ResolvedEffectiveCwd } from '../core/store-resolution.js';

export type ContextFormat = 'markdown' | 'json' | 'template';
export type McpProtocolVersion = '2024-11-05' | '2025-11-25';
export type McpConnectionState = 'pre_init' | 'awaiting_initialized' | 'ready' | 'closed';
export type JsonRpcId = string | number | null;

export const SCHEMA_VERSION = '1.0.0';
export const MCP_PROTOCOL_VERSIONS: McpProtocolVersion[] = ['2025-11-25', '2024-11-05'];
export const MCP_SERVER_NOT_INITIALIZED = -32002;

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  schema_version?: string;
  [key: string]: unknown;
}

export interface McpReadToolContext {
  cwd?: string;
  connectionSessionId?: string;
  effectiveScope?: ResolvedEffectiveCwd;
}

export interface McpToolExecutionPayload {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  connectionSessionId?: string;
  effectiveScope?: ResolvedEffectiveCwd;
}

export interface McpToolExecutionOutcome {
  response: McpToolResponse;
  /**
   * Updated connection session ID to persist across tool calls.
   * - `string`    → set / refresh to this value
   * - `null`      → explicitly clear (session ended)
   * - `undefined` → no change; keep the current value (default for most tools)
   */
  nextConnectionSessionId?: string | null;
  /** Tool name — used for usage tracking. */
  toolName?: string;
}

export interface McpTaskRunnerOptions {
  executeTool: McpToolExecutor;
  onResult: (requestId: JsonRpcId, outcome: McpToolExecutionOutcome) => void;
  onInternalError: (requestId: JsonRpcId, error: unknown) => void;
}

export interface McpConnectionOptions {
  cwd: string;
  send: (message: Record<string, unknown>) => void;
  executeTool?: McpToolExecutor;
  /** Start in setup mode: project memory absent at cwd, serve the minimal catalog. */
  uninitialized?: boolean;
}

export interface ParsedMcpMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
  isNotification: boolean;
}

export interface McpInitializeResult {
  protocolVersion: McpProtocolVersion;
  serverInfo: { name: string; version: string };
  capabilities: { tools: { listChanged: boolean } };
  instructions?: string;
}

export interface McpToolErrorShape {
  kind: string;
  message: string;
  details?: unknown;
}

export type McpToolExecutor = (payload: McpToolExecutionPayload, signal: AbortSignal) => Promise<McpToolExecutionOutcome>;

export function toolResponse(
  response: {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    [key: string]: unknown;
  },
  isError: boolean = false,
): McpToolResponse {
  const structuredContent = response.structuredContent
    ? { ...response.structuredContent, schema_version: SCHEMA_VERSION }
    : undefined;
  return {
    ...response,
    structuredContent,
    isError,
    schema_version: SCHEMA_VERSION,
  };
}

export function createToolErrorResponse(kind: string, message: string, details?: unknown): McpToolResponse {
  return toolResponse({
    content: [{ type: 'text', text: `Error: ${message}` }],
    structuredContent: {
      error: {
        kind,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
  }, true);
}

export function normaliseFormat(value: unknown): ContextFormat {
  if (value === 'json' || value === 'template') {
    return value;
  }
  return 'markdown';
}
