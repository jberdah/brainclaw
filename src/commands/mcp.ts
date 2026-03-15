import readline from 'node:readline';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { saveCandidate, generateCandidateId, loadCandidate, archiveCandidate } from '../core/candidates.js';
import { saveClaim, generateClaimId, loadClaim, listClaims } from '../core/claims.js';
import { runAccept } from './accept.js';
import { runReject } from './reject.js';
import { runSessionStart } from './session-start.js';
import { runSessionEnd } from './session-end.js';
import { agentCanWriteDirect, agentCanCurate, getAgentTrustLevel } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { nowISO } from '../core/ids.js';
import { search } from '../core/search.js';
import type { CandidateType, MemoryVisibility } from '../core/schema.js';

export type ContextFormat = 'markdown' | 'json' | 'template';

const SCHEMA_VERSION = '0.3.0';

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpReadToolContext {
  cwd?: string;
}

export const MCP_READ_TOOLS = [
  {
    name: 'bclaw_get_context',
    description: 'Get project memory context for a specific file or path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path or glob pattern to filter memory by.' },
        project: { type: 'string', description: 'Optional explicit project namespace for instruction resolution.' },
        agent: { type: 'string', description: 'Optional agent name for agent-layer instruction resolution.' },
        host: { type: 'string', description: 'Optional host identifier used to include machine-local runtime context.' },
        allHosts: { type: 'boolean', description: 'Include machine-local runtime context from all hosts.' },
        profile: { type: 'string', description: 'Optional profile override: dev, openclaw, ops, research.' },
        includePending: { type: 'boolean', description: 'Include pending candidates in the context.' },
        maxItems: { type: 'number', description: 'Maximum number of ranked items to return.' },
        maxChars: { type: 'number', description: 'Approximate character budget applied after ranking.' },
        format: { type: 'string', description: 'Output format: markdown, json, or template.' },
        explain: { type: 'boolean', description: 'Include ranking reasons in markdown output.' },
        compactTemplate: { type: 'boolean', description: 'Use compact template format when format=template.' }
      }
    }
  },
  {
    name: 'bclaw_read_handoff',
    description: 'Read an open handoff ticket with its captured git diff and state snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The handoff ID.' }
      },
      required: ['id']
    }
  },
  {
    name: 'bclaw_get_agent_board',
    description: 'Get an agent collaboration board with active plans, claims, handoffs, and resolved instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Optional agent name to filter claims and handoffs.' },
        project: { type: 'string', description: 'Optional project namespace.' },
        path: { type: 'string', description: 'Optional target path used to infer project scope.' },
        host: { type: 'string', description: 'Optional host identifier used to include machine-local runtime notes.' },
        allHosts: { type: 'boolean', description: 'Include machine-local runtime notes from all hosts.' },
        includeReputation: { type: 'boolean', description: 'Include bounded reputation summaries for board consumers.' }
      }
    }
  },
  {
    name: 'bclaw_search',
    description: 'Full-text search across all memory items (decisions, constraints, traps, candidates, handoffs) using BM25 scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string.' },
        type: { type: 'string', description: 'Filter by item type (decision, constraint, trap, handoff, candidate, plan).' },
        section: { type: 'string', description: 'Filter by section (state, candidates, runtime).' },
        since: { type: 'string', description: 'Filter items created after this ISO date.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default 10).' }
      },
      required: ['query']
    }
  }
] as const;

/**
 * MCP Server over stdio — brainclaw memory tools for agents (Claude, Cursor, Copilot, etc.)
 * Implements: initialize handshake, tools/list, tools/call with read + write tools, trust-level access control.
 */
export function runMcp(): void {
  const cwd = process.cwd();
  
  if (!memoryExists(cwd)) {
    console.error('Project memory not initialized. Run `brainclaw init` first.');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const writeTools = [
    {
      name: 'bclaw_write_note',
      description: 'Add a runtime note. Requires contributor trust level or above.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Note content.' },
          agent: { type: 'string', description: 'Agent name.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          visibility: { type: 'string', description: 'Visibility: shared, machine, private.' },
          ttl: { type: 'string', description: 'Optional TTL: 30m, 2h, 7d.' }
        },
        required: ['text', 'agent']
      }
    },
    {
      name: 'bclaw_create_candidate',
      description: 'Create a memory candidate for review. Trusted/curator agents write through directly.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Candidate content.' },
          type: { type: 'string', description: 'Type: constraint, decision, trap, handoff.' },
          agent: { type: 'string', description: 'Author agent name.' },
          tags: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', description: 'Severity for traps: low, medium, high.' }
        },
        required: ['text', 'type', 'agent']
      }
    },
    {
      name: 'bclaw_accept',
      description: 'Accept a pending candidate into canonical memory. Requires trusted or curator trust level.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Candidate ID to accept.' },
          by: { type: 'string', description: 'Reviewer identity.' }
        },
        required: ['id']
      }
    },
    {
      name: 'bclaw_reject',
      description: 'Reject a pending candidate. Requires contributor trust level or above.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Candidate ID to reject.' },
          reason: { type: 'string', description: 'Reason for rejection.' },
          by: { type: 'string', description: 'Reviewer identity.' }
        },
        required: ['id']
      }
    },
    {
      name: 'bclaw_claim',
      description: 'Claim a work scope (advisory lock). Requires contributor trust level or above.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Scope being claimed.' },
          description: { type: 'string', description: 'Description of the work.' },
          agent: { type: 'string', description: 'Agent or person name.' },
          planId: { type: 'string', description: 'Optional linked plan item ID.' }
        },
        required: ['scope', 'description', 'agent']
      }
    },
    {
      name: 'bclaw_release_claim',
      description: 'Release a work claim.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Claim ID to release.' },
          planStatus: { type: 'string', description: 'Optional: update linked plan status.' }
        },
        required: ['id']
      }
    },
    {
      name: 'bclaw_session_start',
      description: 'Start a session and capture initial context.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent name.' },
          context: { type: 'string', description: 'Context target path.' }
        }
      }
    },
    {
      name: 'bclaw_session_end',
      description: 'End a session and optionally auto-reflect observations as candidates.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session ID.' },
          agent: { type: 'string', description: 'Agent name.' },
          summary: { type: 'string', description: 'Session summary text.' },
          autoReflect: { type: 'boolean', description: 'Auto-reflect session notes as candidates.' }
        }
      }
    }
  ];

  const allTools = [...MCP_READ_TOOLS, ...writeTools];

  function sendResult(id: unknown, result: unknown): void {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  function sendError(id: unknown, code: number, message: string, data?: unknown): void {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) }
    }) + '\n');
  }

  function requireTrust(agentName: string, level: 'contributor' | 'trusted' | 'curator', id: unknown): boolean {
    try {
      const trust = getAgentTrustLevel(agentName);
      const order = ['observer', 'contributor', 'trusted', 'curator'];
      if (order.indexOf(trust) < order.indexOf(level)) {
        sendError(id, -32600, `Insufficient trust: agent '${agentName}' has level '${trust}', '${level}' required.`);
        return false;
      }
      return true;
    } catch {
      // Unknown agent defaults to contributor
      if (level === 'trusted' || level === 'curator') {
        sendError(id, -32600, `Agent '${agentName}' not registered. '${level}' trust required.`);
        return false;
      }
      return true;
    }
  }

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let request: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      sendError(null, -32700, 'Parse error');
      return;
    }

    const { id, method, params } = request;

    try {
      // MCP initialize handshake
      if (method === 'initialize') {
        sendResult(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'brainclaw', version: SCHEMA_VERSION },
          capabilities: { tools: {} },
        });
        return;
      }

      // initialized notification (no response expected)
      if (method === 'notifications/initialized' || method === 'initialized') {
        return;
      }

      if (method === 'tools/list') {
        sendResult(id, { tools: allTools });
        return;
      }

      if (method === 'tools/call') {
        const { name, arguments: args = {} } = params as { name: string; arguments?: Record<string, unknown> };

        // ─── READ TOOLS ───────────────────────────────────────────────────

        if (MCP_READ_TOOLS.some((tool) => tool.name === name)) {
          try {
            sendResult(id, handleMcpReadToolCall(name, args, { cwd }));
          } catch (e: unknown) {
            sendError(id, -32603, e instanceof Error ? e.message : String(e));
          }
          return;
        }

        // ─── WRITE TOOLS ──────────────────────────────────────────────────

        if (name === 'bclaw_write_note') {
          const agent = String(args.agent ?? '');
          if (!requireTrust(agent, 'contributor', id)) return;
          const noteId = generateRuntimeNoteId();
          const ttlStr = args.ttl as string | undefined;
          const expiresAt = ttlStr ? parseTtl(ttlStr) : undefined;
          saveRuntimeNote({
            id: noteId,
            agent,
            text: String(args.text ?? ''),
            created_at: nowISO(),
            tags: (args.tags as string[] | undefined) ?? [],
            visibility: (args.visibility as MemoryVisibility | undefined) ?? 'shared',
            expires_at: expiresAt,
            note_type: 'observation',
          });
          appendAuditEntry({ actor: agent, action: 'create', item_id: noteId, item_type: 'runtime_note' });
          sendResult(id, { content: [{ type: 'text', text: `✔ Note created [${noteId}]` }], note_id: noteId, schema_version: SCHEMA_VERSION });
          return;
        }

        if (name === 'bclaw_create_candidate') {
          const agent = String(args.agent ?? '');
          if (!requireTrust(agent, 'contributor', id)) return;
          const candId = generateCandidateId();
          const type = String(args.type ?? 'decision') as CandidateType;
          const writeThrough = agentCanWriteDirect(agent);
          const candidate = {
            id: candId,
            type,
            text: String(args.text ?? ''),
            created_at: nowISO(),
            author: agent,
            tags: (args.tags as string[] | undefined) ?? [],
            status: 'pending' as const,
            severity: type === 'trap' ? ((args.severity as 'low' | 'medium' | 'high' | undefined) ?? 'medium') : undefined,
            star_count: 0,
            starred_by: [],
            usage_count: 0,
            usage_events: [],
          };
          if (writeThrough) {
            // Trusted/curator: bypass inbox — handled by runAccept below indirectly
            // Save as pending first, then accept immediately
            saveCandidate(candidate);
            runAccept(candId, agent);
            appendAuditEntry({ actor: agent, action: 'promote_direct', item_id: candId, item_type: type });
            sendResult(id, { content: [{ type: 'text', text: `✔ Direct write [${candId}] (trusted agent)` }], candidate_id: candId, write_through: true, schema_version: SCHEMA_VERSION });
          } else {
            saveCandidate(candidate);
            appendAuditEntry({ actor: agent, action: 'create', item_id: candId, item_type: type });
            sendResult(id, { content: [{ type: 'text', text: `✔ Candidate created [${candId}] (pending review)` }], candidate_id: candId, write_through: false, schema_version: SCHEMA_VERSION });
          }
          return;
        }

        if (name === 'bclaw_accept') {
          const by = String(args.by ?? args.agent ?? '');
          if (!requireTrust(by, 'trusted', id)) return;
          const candId = String(args.id ?? '');
          try {
            runAccept(candId, by);
            sendResult(id, { content: [{ type: 'text', text: `✔ Accepted [${candId}]` }], schema_version: SCHEMA_VERSION });
          } catch (e: unknown) {
            sendError(id, -32603, e instanceof Error ? e.message : String(e));
          }
          return;
        }

        if (name === 'bclaw_reject') {
          const by = String(args.by ?? args.agent ?? '');
          if (!requireTrust(by, 'contributor', id)) return;
          const candId = String(args.id ?? '');
          try {
            runReject(candId, args.reason as string | undefined, by);
            sendResult(id, { content: [{ type: 'text', text: `✔ Rejected [${candId}]` }], schema_version: SCHEMA_VERSION });
          } catch (e: unknown) {
            sendError(id, -32603, e instanceof Error ? e.message : String(e));
          }
          return;
        }

        if (name === 'bclaw_claim') {
          const agent = String(args.agent ?? '');
          if (!requireTrust(agent, 'contributor', id)) return;
          const claimId = generateClaimId();
          saveClaim({
            id: claimId,
            agent,
            scope: String(args.scope ?? ''),
            description: String(args.description ?? ''),
            created_at: nowISO(),
            status: 'active',
            plan_id: args.planId as string | undefined,
          });
          appendAuditEntry({ actor: agent, action: 'claim', item_id: claimId, item_type: 'claim' });
          sendResult(id, { content: [{ type: 'text', text: `✔ Claimed scope [${claimId}]` }], claim_id: claimId, schema_version: SCHEMA_VERSION });
          return;
        }

        if (name === 'bclaw_release_claim') {
          const claimId = String(args.id ?? '');
          let claimObj;
          try { claimObj = loadClaim(claimId); } catch (e: unknown) {
            sendError(id, -32602, `Claim not found: ${claimId}`);
            return;
          }
          const updatedClaim = { ...claimObj, status: 'released' as const, released_at: nowISO() };
          saveClaim(updatedClaim);
          appendAuditEntry({ actor: claimObj.agent, action: 'release_claim', item_id: claimId, item_type: 'claim' });
          sendResult(id, { content: [{ type: 'text', text: `✔ Released claim [${claimId}]` }], schema_version: SCHEMA_VERSION });
          return;
        }

        if (name === 'bclaw_session_start') {
          try {
            runSessionStart({
              agent: args.agent as string | undefined,
              context: args.context as string | undefined,
              json: false,
            });
            sendResult(id, { content: [{ type: 'text', text: '✔ Session started' }], schema_version: SCHEMA_VERSION });
          } catch (e: unknown) {
            sendError(id, -32603, e instanceof Error ? e.message : String(e));
          }
          return;
        }

        if (name === 'bclaw_session_end') {
          try {
            runSessionEnd({
              session: args.session as string | undefined,
              agent: args.agent as string | undefined,
              summary: args.summary as string | undefined,
              autoReflect: args.autoReflect as boolean | undefined,
              json: false,
            });
            sendResult(id, { content: [{ type: 'text', text: '✔ Session ended' }], schema_version: SCHEMA_VERSION });
          } catch (e: unknown) {
            sendError(id, -32603, e instanceof Error ? e.message : String(e));
          }
          return;
        }

        sendError(id, -32601, `Unknown tool: ${name}`);
        return;
      }

      sendError(id, -32601, `Method not found: ${method ?? '(none)'}`);
    } catch (e: unknown) {
      sendError(id, -32603, e instanceof Error ? e.message : 'Internal error');
    }
  });
}

export function normaliseFormat(value: unknown): ContextFormat {
  if (value === 'json' || value === 'template') {
    return value;
  }
  return 'markdown';
}

export function renderContextForMcp(
  result: ReturnType<typeof buildContext>,
  format: ContextFormat,
  options: { explain?: boolean; compactTemplate?: boolean },
): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  if (format === 'template') {
    const compact = options.compactTemplate || result.profile === 'openclaw';
    return renderContextPromptTemplate(result, compact);
  }
  return renderContextMarkdown(result, options.explain);
}

export function parseTtl(ttl: string): string | undefined {
  const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
  if (!match) return undefined;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3_600_000 : value * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}

export function handleMcpReadToolCall(
  name: string,
  args: Record<string, unknown> = {},
  context: McpReadToolContext = {},
): McpToolResponse {
  const cwd = context.cwd ?? process.cwd();

  if (name === 'bclaw_get_context') {
    const result = buildContext({
      target: args.path as string | undefined,
      project: args.project as string | undefined,
      agent: args.agent as string | undefined,
      host: args.host as string | undefined,
      allHosts: args.allHosts as boolean | undefined,
      profile: args.profile as 'dev' | 'openclaw' | 'ops' | 'research' | undefined,
      includePending: args.includePending as boolean | undefined,
      maxItems: args.maxItems as number | undefined,
      maxChars: args.maxChars as number | undefined,
      cwd,
    });
    const format = normaliseFormat(args.format);
    const content = renderContextForMcp(result, format, {
      explain: args.explain as boolean | undefined,
      compactTemplate: args.compactTemplate as boolean | undefined,
    });
    return {
      content: [{ type: 'text', text: content || 'No relevant memory found.' }],
      structuredContent: { ...result, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_read_handoff') {
    const state = loadState(cwd);
    const handoff = state.open_handoffs.find((entry) => entry.id === args.id);
    let text = `Handoff not found: ${String(args.id)}`;
    if (handoff) {
      text = `From: ${handoff.from}\nTo: ${handoff.to}\nTask: ${handoff.text}\n\n`;
      if (handoff.snapshot?.diff) {
        text += `--- Uncommitted Git Diff ---\n\`\`\`diff\n${handoff.snapshot.diff}\n\`\`\`\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'bclaw_get_agent_board') {
    const board = buildCoordinationSnapshot({
      agent: args.agent as string | undefined,
      project: args.project as string | undefined,
      target: args.path as string | undefined,
      host: args.host as string | undefined,
      allHosts: args.allHosts as boolean | undefined,
      includeReputation: args.includeReputation as boolean | undefined,
      cwd,
    });
    const lines: string[] = [];
    lines.push(`Agent board${board.agent ? ` for ${board.agent}` : ''}${board.project ? ` (${board.project})` : ''}`);
    lines.push('');
    if (board.project_id) lines.push(`Project ID: ${board.project_id}`);
    if (board.agent && board.agent_id) lines.push(`Agent ID: ${board.agent_id}`);
    lines.push(`Current host: ${board.current_host}`);
    if (board.all_hosts) lines.push('Host filter: all-hosts');
    else if (board.host_filter) lines.push(`Host filter: ${board.host_filter}`);
    if (args.includeReputation && board.reputation_summary) {
      lines.push(`Reputation: tracked=${board.reputation_summary.tracked_agents}, avg_trust=${board.reputation_summary.avg_internal_trust}`);
      if (board.agent_reputation) {
        lines.push(`Agent trust: ${board.agent_reputation.internal_trust} (cq=${board.agent_reputation.contribution_quality}, rv=${board.agent_reputation.review_reliability}, ct=${board.agent_reputation.continuity_hygiene})`);
      }
    }
    lines.push(`Active plans: ${board.active_plans.length}`);
    for (const plan of board.active_plans.slice(0, 10)) {
      const claims = plan.claims.length ? ` claims=${plan.claims.map((claim) => claim.agent).join(',')}` : '';
      lines.push(`- [${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})${claims}`);
    }
    lines.push(`Active claims: ${board.active_claims.length}`);
    for (const claim of board.active_claims.slice(0, 10)) {
      const identity = claim.agent_id ? ` [${claim.agent_id}]` : '';
      const session = claim.session_id ? ` session=${claim.session_id}` : '';
      lines.push(`- [${claim.id}] ${claim.agent}${identity} -> ${claim.scope}${claim.plan_id ? ` (plan ${claim.plan_id})` : ''}${session}`);
    }
    lines.push(`Runtime notes: ${board.runtime_notes.length}`);
    for (const note of board.runtime_notes.slice(-10)) {
      const scope = note.visibility === 'shared' ? 'shared' : `${note.visibility}:${note.host_id ?? 'unknown-host'}`;
      const identity = note.agent_id ? ` [${note.agent_id}]` : '';
      lines.push(`- [${note.id}] ${note.agent}${identity}: ${note.text}${note.plan_id ? ` (plan ${note.plan_id})` : ''} [${scope}]`);
    }
    lines.push(`Open handoffs: ${board.open_handoffs.length}`);
    for (const handoff of board.open_handoffs.slice(0, 10)) {
      lines.push(`- [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}`);
    }
    lines.push(`Resolved instructions: ${board.resolved_instructions.length}`);
    for (const instruction of board.resolved_instructions.slice(0, 10)) {
      lines.push(`- [${instruction.id}] <${instruction.layer}${instruction.scope ? `:${instruction.scope}` : ''}> ${instruction.text}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { ...board, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_search') {
    const query = String(args.query ?? '');
    if (!query) {
      throw new Error('Missing required argument: query');
    }
    const results = search({
      query,
      section: (args.section ?? args.type) as string | undefined,
      since: args.since as string | undefined,
      maxResults: typeof args.limit === 'number' ? args.limit : 10,
      cwd,
    });
    const lines = results.map((result) => `[${result.id}] (${result.section}) score=${result.score.toFixed(2)}: ${result.text.slice(0, 120)}`);
    return {
      content: [{ type: 'text', text: results.length > 0 ? lines.join('\n') : 'No results found.' }],
      structuredContent: { results, total: results.length, schema_version: SCHEMA_VERSION },
    };
  }

  throw new Error(`Unknown read tool: ${name}`);
}
