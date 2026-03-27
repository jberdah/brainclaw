import { buildContext } from '../core/context.js';
export type ContextFormat = 'markdown' | 'json' | 'template';
export type McpProtocolVersion = '2024-11-05' | '2025-11-25';
export type McpConnectionState = 'pre_init' | 'awaiting_initialized' | 'ready' | 'closed';
export type JsonRpcId = string | number | null;
export declare const SCHEMA_VERSION = "0.6.0";
export declare const MCP_PROTOCOL_VERSIONS: McpProtocolVersion[];
export declare const MCP_SERVER_NOT_INITIALIZED = -32002;
export interface McpToolResponse {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    schema_version?: string;
    [key: string]: unknown;
}
export interface McpReadToolContext {
    cwd?: string;
}
export interface McpToolExecutionPayload {
    name: string;
    args: Record<string, unknown>;
    cwd: string;
    connectionSessionId?: string;
}
export interface McpToolExecutionOutcome {
    response: McpToolResponse;
    nextConnectionSessionId?: string;
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
    serverInfo: {
        name: string;
        version: string;
    };
    capabilities: {
        tools: {
            listChanged: boolean;
        };
    };
}
export interface McpToolErrorShape {
    kind: string;
    message: string;
    details?: unknown;
}
export type McpToolExecutor = (payload: McpToolExecutionPayload, signal: AbortSignal) => Promise<McpToolExecutionOutcome>;
export declare const MCP_READ_TOOLS: readonly [{
    readonly name: "bclaw_get_context";
    readonly description: "Get project memory context for a specific file or path.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly path: {
                readonly type: "string";
                readonly description: "The file path or glob pattern to filter memory by.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Optional explicit project namespace for instruction resolution.";
            };
            readonly agent: {
                readonly type: "string";
                readonly description: "Optional agent name for agent-layer instruction resolution.";
            };
            readonly host: {
                readonly type: "string";
                readonly description: "Optional host identifier used to include machine-local runtime context.";
            };
            readonly allHosts: {
                readonly type: "boolean";
                readonly description: "Include machine-local runtime context from all hosts.";
            };
            readonly profile: {
                readonly type: "string";
                readonly description: "Optional profile override: dev, openclaw, ops, research.";
            };
            readonly includePending: {
                readonly type: "boolean";
                readonly description: "Include pending candidates in the context.";
            };
            readonly maxItems: {
                readonly type: "number";
                readonly description: "Maximum number of ranked items to return.";
            };
            readonly maxChars: {
                readonly type: "number";
                readonly description: "Approximate character budget applied after ranking.";
            };
            readonly digest: {
                readonly type: "boolean";
                readonly description: "Include a short deterministic digest for the selected context.";
            };
            readonly since_session: {
                readonly type: "string";
                readonly description: "Include a compact memory diff since the given session started.";
            };
            readonly bootstrap: {
                readonly type: "boolean";
                readonly description: "Enable brownfield bootstrap fallback when memory is sparse.";
            };
            readonly refreshBootstrap: {
                readonly type: "boolean";
                readonly description: "Refresh the brownfield bootstrap profile before building context.";
            };
            readonly format: {
                readonly type: "string";
                readonly description: "Output format: markdown, json, or template.";
            };
            readonly explain: {
                readonly type: "boolean";
                readonly description: "Include ranking reasons in markdown output.";
            };
            readonly compactTemplate: {
                readonly type: "boolean";
                readonly description: "Use compact template format when format=template.";
            };
        };
    };
}, {
    readonly name: "bclaw_bootstrap";
    readonly description: "Derive brownfield bootstrap signals, adaptive interview prompts for CLI or IDE chat agents, and an import proposal from repository docs, manifests, native agent files, and git history.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly target: {
                readonly type: "string";
                readonly description: "Optional path or scope to tailor the bootstrap.";
            };
            readonly refresh: {
                readonly type: "boolean";
                readonly description: "Force a fresh bootstrap scan.";
            };
            readonly audience: {
                readonly type: "string";
                readonly description: "Optional interview audience filter: cli, ide_chat, or any.";
            };
            readonly interview: {
                readonly type: "boolean";
                readonly description: "Render interview text instead of the summary text.";
            };
            readonly apply: {
                readonly type: "boolean";
                readonly description: "Apply the current import proposal into canonical memory.";
            };
            readonly uninstall: {
                readonly type: "boolean";
                readonly description: "Uninstall the last bootstrap-managed import.";
            };
            readonly interviewAnswers: {
                readonly type: "array";
                readonly description: "Optional structured interview answers. Each answer may include question_id, response_text, response_items, response_boolean, and explicit suggestions.";
                readonly items: {
                    readonly type: "object";
                };
            };
        };
    };
}, {
    readonly name: "bclaw_get_execution_context";
    readonly description: "Inspect the local execution environment, installable Brainclaw update channel, and optionally agent tooling signals.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly includeAgentTooling: {
                readonly type: "boolean";
                readonly description: "Include AGENTS.md, skills, and local MCP inventory.";
            };
        };
    };
}, {
    readonly name: "bclaw_read_handoff";
    readonly description: "Read an open handoff ticket with its captured git diff and state snapshot.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly id: {
                readonly type: "string";
                readonly description: "The handoff ID.";
            };
        };
        readonly required: readonly ["id"];
    };
}, {
    readonly name: "bclaw_get_agent_board";
    readonly description: "Get an agent collaboration board with active plans, claims, handoffs, and resolved instructions.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly agent: {
                readonly type: "string";
                readonly description: "Optional agent name to filter claims and handoffs.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Optional project namespace.";
            };
            readonly path: {
                readonly type: "string";
                readonly description: "Optional target path used to infer project scope.";
            };
            readonly host: {
                readonly type: "string";
                readonly description: "Optional host identifier used to include machine-local runtime notes.";
            };
            readonly allHosts: {
                readonly type: "boolean";
                readonly description: "Include machine-local runtime notes from all hosts.";
            };
            readonly includeReputation: {
                readonly type: "boolean";
                readonly description: "Include bounded reputation summaries for board consumers.";
            };
            readonly includeSessionMeta: {
                readonly type: "boolean";
                readonly description: "Include session_start/session_end runtime notes (excluded by default to reduce noise).";
            };
        };
    };
}, {
    readonly name: "bclaw_search";
    readonly description: "Full-text search across all memory items (decisions, constraints, traps, candidates, handoffs) using BM25 scoring.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Search query string.";
            };
            readonly type: {
                readonly type: "string";
                readonly description: "Filter by item type (decision, constraint, trap, handoff, candidate, plan).";
            };
            readonly section: {
                readonly type: "string";
                readonly description: "Filter by section (state, candidates, runtime).";
            };
            readonly since: {
                readonly type: "string";
                readonly description: "Filter items created after this ISO date.";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of results to return (default 10).";
            };
            readonly offset: {
                readonly type: "number";
                readonly description: "Number of results to skip (for pagination).";
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "bclaw_estimation_report";
    readonly description: "Show estimation accuracy report for completed plans. Returns ratio of estimated vs actual effort per agent.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly agent: {
                readonly type: "string";
                readonly description: "Filter by agent/author name.";
            };
        };
    };
}, {
    readonly name: "bclaw_list_plans";
    readonly description: "List plan items with optional filters on status, type, assignee, and project.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly all: {
                readonly type: "boolean";
                readonly description: "Include done and dropped plans.";
            };
            readonly status: {
                readonly type: "string";
                readonly description: "Filter by status: todo, in_progress, blocked, done, dropped.";
            };
            readonly type: {
                readonly type: "string";
                readonly description: "Filter by plan type.";
            };
            readonly assignee: {
                readonly type: "string";
                readonly description: "Filter by assignee name.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Filter by project namespace.";
            };
            readonly id: {
                readonly type: "string";
                readonly description: "Get a single plan by ID (exact match).";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of plans to return (default: 20).";
            };
            readonly offset: {
                readonly type: "number";
                readonly description: "Number of plans to skip (for pagination).";
            };
            readonly compact: {
                readonly type: "boolean";
                readonly description: "Return only key fields (id, short_label, text, status, priority) to reduce output size.";
            };
        };
    };
}, {
    readonly name: "bclaw_list_claims";
    readonly description: "List work claims with optional filters on project, plan, and agent.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly all: {
                readonly type: "boolean";
                readonly description: "Include released claims.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Filter by project namespace.";
            };
            readonly plan: {
                readonly type: "string";
                readonly description: "Filter by linked plan id.";
            };
            readonly agent: {
                readonly type: "string";
                readonly description: "Filter by agent name.";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of claims to return (default: 20).";
            };
            readonly offset: {
                readonly type: "number";
                readonly description: "Number of claims to skip (for pagination).";
            };
        };
    };
}, {
    readonly name: "bclaw_list_agents";
    readonly description: "List registered agent identities and optionally include bounded reputation summaries.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly includeReputation: {
                readonly type: "boolean";
                readonly description: "Include bounded reputation summaries for each agent.";
            };
        };
    };
}, {
    readonly name: "bclaw_list_instructions";
    readonly description: "List raw or resolved shared instructions with the same filters exposed by the CLI.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly layer: {
                readonly type: "string";
                readonly description: "Filter by layer: global, project, agent.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Project namespace filter.";
            };
            readonly agent: {
                readonly type: "string";
                readonly description: "Agent name filter.";
            };
            readonly active: {
                readonly type: "boolean";
                readonly description: "Only include active instructions.";
            };
            readonly resolved: {
                readonly type: "boolean";
                readonly description: "Resolve effective instructions for the given scope.";
            };
            readonly path: {
                readonly type: "string";
                readonly description: "Infer project namespace from a target path when strategy=folder.";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of instructions to return (default: 20).";
            };
            readonly offset: {
                readonly type: "number";
                readonly description: "Number of instructions to skip (for pagination).";
            };
        };
    };
}, {
    readonly name: "bclaw_list_candidates";
    readonly description: "List review candidates across pending, accepted, rejected, or all queues.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly status: {
                readonly type: "string";
                readonly description: "Candidate bucket: pending, accepted, rejected, or all.";
            };
            readonly type: {
                readonly type: "string";
                readonly description: "Filter by candidate type.";
            };
            readonly assignee: {
                readonly type: "string";
                readonly description: "Filter pending candidates by assignee tag (assignee:<name>).";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of candidates to return (default: 20).";
            };
            readonly offset: {
                readonly type: "number";
                readonly description: "Number of candidates to skip (for pagination).";
            };
            readonly compact: {
                readonly type: "boolean";
                readonly description: "Return only key fields (id, type, text, status) to reduce output size.";
            };
        };
    };
}, {
    readonly name: "bclaw_get_capabilities";
    readonly description: "List all registered project capabilities with full metadata.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly category: {
                readonly type: "string";
                readonly description: "Filter by capability category.";
            };
            readonly tags: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Filter by tags (any).";
            };
        };
    };
}, {
    readonly name: "bclaw_list_tools";
    readonly description: "List all registered project tools with metadata.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly type: {
                readonly type: "string";
                readonly description: "Filter by tool type (workflow, validator, generator, utility, explorer).";
            };
            readonly tags: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Filter by tags (any).";
            };
        };
    };
}, {
    readonly name: "bclaw_search_tools";
    readonly description: "Search tools by query and tags.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Search query (matches tool name, description, tags).";
            };
            readonly type: {
                readonly type: "string";
                readonly description: "Filter by tool type.";
            };
            readonly tags: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Filter by tags (all must match).";
            };
        };
        readonly required: readonly ["query"];
    };
}, {
    readonly name: "bclaw_doctor";
    readonly description: "Run health checks on the brainclaw memory store. Returns structured check results with ok/warn/error status and metrics.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly migrationCheck: {
                readonly type: "boolean";
                readonly description: "Include detailed schema migration status.";
            };
        };
    };
}, {
    readonly name: "bclaw_history";
    readonly description: "Show full mutation history of a memory item from the audit log.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly id: {
                readonly type: "string";
                readonly description: "Item ID to retrieve history for.";
            };
        };
        readonly required: readonly ["id"];
    };
}, {
    readonly name: "bclaw_audit";
    readonly description: "View the append-only audit log of all memory mutations.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly since: {
                readonly type: "string";
                readonly description: "Show entries since this ISO date.";
            };
            readonly actor: {
                readonly type: "string";
                readonly description: "Filter by actor name or agent ID.";
            };
            readonly action: {
                readonly type: "string";
                readonly description: "Filter by action type (create, accept, reject, etc.).";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Show last N entries (default 20).";
            };
        };
    };
}, {
    readonly name: "bclaw_get_discovery";
    readonly description: "Scan workspace for MCP configs, instruction files, skills, hooks, and agent integrations. Returns a structured discovery profile. Saves result to .brainclaw/discovery/ by default.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly refresh: {
                readonly type: "boolean";
                readonly description: "Force a fresh scan even if a cached profile exists (default: true).";
            };
            readonly noSave: {
                readonly type: "boolean";
                readonly description: "Do not persist the discovery profile.";
            };
        };
    };
}, {
    readonly name: "bclaw_conflict_check";
    readonly description: "Check for claim conflicts between the current agent and other agents. Returns overlapping scopes.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly agent: {
                readonly type: "string";
                readonly description: "Agent name to check conflicts for (default: current agent).";
            };
            readonly agentId: {
                readonly type: "string";
                readonly description: "Registered agent id.";
            };
        };
    };
}, {
    readonly name: "bclaw_who";
    readonly description: "List all active agent sessions on this workspace. Shows user, agent, active project, claims, and last activity for each session.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly all: {
                readonly type: "boolean";
                readonly description: "Include stale sessions (default: false).";
            };
            readonly gc: {
                readonly type: "boolean";
                readonly description: "Remove stale sessions and return count.";
            };
        };
    };
}];
/**
 * Lightweight metrics for the single-writer mutation queue.
 * Exposed via McpTaskRunner.metrics for observability.
 */
export interface McpTaskRunnerMetrics {
    /** Total tasks executed since server start. */
    totalExecuted: number;
    /** Total tasks cancelled before execution. */
    totalCancelled: number;
    /** Current queue depth (waiting tasks). */
    queueDepth: number;
    /** Peak queue depth observed. */
    peakQueueDepth: number;
    /** Last task execution duration in ms. */
    lastDurationMs: number;
    /** Last task queue wait time in ms (time between enqueue and start). */
    lastWaitMs: number;
}
export declare function createToolErrorResponse(kind: string, message: string, details?: unknown): McpToolResponse;
export declare function parseMcpLine(line: string): ParsedMcpMessage;
export declare function createInitializeResult(protocolVersion: McpProtocolVersion): McpInitializeResult;
export declare class McpTaskRunner {
    private readonly executeTool;
    private readonly onResult;
    private readonly onInternalError;
    private active;
    private queue;
    private _totalExecuted;
    private _totalCancelled;
    private _peakQueueDepth;
    private _lastDurationMs;
    private _lastWaitMs;
    constructor(options: McpTaskRunnerOptions);
    get activeRequestId(): JsonRpcId | undefined;
    get queuedRequestIds(): JsonRpcId[];
    /** Current single-writer queue metrics. */
    get metrics(): McpTaskRunnerMetrics;
    enqueue(requestId: JsonRpcId, payload: McpToolExecutionPayload): void;
    cancel(requestId: JsonRpcId): 'active' | 'queued' | 'missing';
    close(): void;
    private drain;
    private runTask;
}
export declare class McpServerConnection {
    readonly cwd: string;
    state: McpConnectionState;
    protocolVersion?: McpProtocolVersion;
    connectionSessionId?: string;
    /** Version of brainclaw code loaded in this process at boot time. */
    private readonly bootVersion;
    /** Throttle disk version checks — at most once per 60s. */
    private lastVersionCheckAt;
    private versionMismatchAdvisory;
    private readonly send;
    private readonly taskRunner;
    constructor(options: McpConnectionOptions);
    /**
     * Compare the version loaded in memory with the version on disk.
     * Returns an advisory string if they differ, undefined otherwise.
     * Throttled to one disk read per 60 seconds.
     */
    private checkVersionMismatch;
    /**
     * Append a usage record to .brainclaw/usage.jsonl.
     * Fire-and-forget — usage tracking must never block tool responses.
     */
    private trackUsage;
    handleLine(line: string): void;
    close(): void;
    private handleCancellation;
    private sendResult;
    private sendError;
}
/**
 * Bi-modal stdin parser that accepts both Content-Length framed messages
 * (MCP/LSP standard) and legacy newline-delimited JSON.
 *
 * Detection: if the first non-empty data starts with "Content-Length:",
 * we use Content-Length mode for the rest of the connection.
 * Otherwise, we fall back to newline-delimited mode.
 */
export declare class StdioTransport {
    private buffer;
    private mode;
    private onMessage;
    private onClose;
    constructor(onMessage: (line: string) => void, onClose: () => void);
    start(): void;
    private drain;
    private drainContentLength;
    private drainNewline;
}
export declare function runMcp(): void;
export declare function normaliseFormat(value: unknown): ContextFormat;
export declare function renderContextForMcp(result: ReturnType<typeof buildContext>, format: ContextFormat, options: {
    explain?: boolean;
    compactTemplate?: boolean;
}): string;
export declare function parseTtl(ttl: string): string | undefined;
export declare function handleMcpReadToolCall(name: string, args?: Record<string, unknown>, context?: McpReadToolContext): McpToolResponse;
export declare function executeMcpToolCall(payload: McpToolExecutionPayload): Promise<McpToolExecutionOutcome>;
//# sourceMappingURL=mcp.d.ts.map