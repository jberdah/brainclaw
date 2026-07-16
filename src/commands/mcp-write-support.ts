/**
 * Shared MCP write-path support helpers.
 *
 * Extracted mechanically from mcp.ts (pln#622 PR3a): identity resolution and
 * trust gating shared by every write-tool domain (coordination, sequences,
 * steps, canonical grammar, …). mcp.ts re-exports the historical test surface
 * (`__resetConnectionPrincipalForTests`, `PinnedConnectionPrincipal`).
 *
 * Import rule (pln#622 PR1 guard): this module must never import ./mcp.js.
 *
 * @module
 */
import {
  AgentIdentityResolutionError,
  AgentTrustError,
  findAgentIdentityById,
  findAgentIdentityByName,
  normalizeAgentName,
  requireMinimumTrustLevel,
  requireRegisteredAgentIdentity,
  resolveCurrentAgentIdentity,
} from '../core/agent-registry.js';
import { loadClaim } from '../core/claims.js';
import { loadSessionById } from '../core/identity.js';
import type { McpToolErrorShape } from './mcp-contract.js';

/**
 * Per-call context carried from the tool executor (mcp.ts) into the write
 * handler modules: the effective cwd, the MCP connection's session id, and
 * the model resolved once for all write operations.
 */
export interface McpWriteToolContext {
  cwd: string;
  connectionSessionId?: string;
  currentModel?: string;
}

// ── Authenticated connection principal (pln#562 step 3) ──────────────────────

/**
 * Identity pinned for the lifetime of an MCP connection. Resolved ONCE from
 * server-side facts (BRAINCLAW_CLAIM_ID assignment binding, then process-env
 * detection) — never from caller-supplied tool args, which any client can
 * spoof. Mutations verify caller args against this pin; only a curator may
 * explicitly override it.
 */
export interface PinnedConnectionPrincipal {
  agent_name: string;
  agent_id: string;
  session_id?: string;
  pid: number;
  source: 'claim_binding' | 'server_detection';
}

let principalCache: { key: string; value: PinnedConnectionPrincipal | undefined } | undefined;

/** Test hook — the principal is otherwise pinned for the process lifetime. */
export function __resetConnectionPrincipalForTests(): void {
  principalCache = undefined;
}

/**
 * Resolve the connection principal. The MCP server is one process per
 * connection, so a process-level pin IS the per-connection pin; the cache key
 * guards the identity-bearing env vars so in-process test harnesses that
 * switch agents between calls re-resolve instead of leaking the first pin.
 */
export function resolveConnectionPrincipal(cwd?: string, sessionId?: string): PinnedConnectionPrincipal | undefined {
  const env = process.env;
  const key = [
    env.BRAINCLAW_CLAIM_ID ?? '', env.BRAINCLAW_AGENT_ID ?? '',
    env.BRAINCLAW_AGENT_NAME ?? '', env.BRAINCLAW_AGENT ?? '',
    cwd ?? '', sessionId ?? '',
  ].join('|');
  if (principalCache && principalCache.key === key) return principalCache.value;

  let value: PinnedConnectionPrincipal | undefined;

  // 1. Assignment binding: a dispatched worker carries BRAINCLAW_CLAIM_ID; the
  //    claim names the identity the coordinator dispatched — authoritative.
  const claimId = env.BRAINCLAW_CLAIM_ID?.trim();
  if (claimId) {
    try {
      const claim = loadClaim(claimId, cwd);
      const identity = (claim.agent_id ? findAgentIdentityById(claim.agent_id, cwd) : undefined)
        ?? findAgentIdentityByName(claim.agent, cwd);
      if (identity) {
        value = {
          agent_name: identity.agent_name,
          agent_id: identity.agent_id,
          session_id: claim.session_id ?? sessionId,
          pid: process.pid,
          source: 'claim_binding',
        };
      }
    } catch { /* claim may not exist in this store — fall through */ }
  }

  // 2. Server-side detection (env-pinned or detected REGISTERED identity —
  //    read-only since pln#562 step 2, never mints).
  if (!value) {
    const identity = resolveCurrentAgentIdentity(cwd);
    if (identity) {
      value = {
        agent_name: identity.agent_name,
        agent_id: identity.agent_id,
        session_id: sessionId,
        pid: process.pid,
        source: 'server_detection',
      };
    }
  }

  principalCache = { key, value };
  return value;
}

export function resolveMutationIdentity(args: Record<string, unknown>, fields: { nameField: string; idField: string }, cwd?: string, sessionId?: string) {
  try {
    const explicitName = typeof args[fields.nameField] === 'string' ? String(args[fields.nameField]) : undefined;
    const explicitId = typeof args[fields.idField] === 'string' ? String(args[fields.idField]) : undefined;

    // pln#562 step 3 — pinned connection principal. When the server resolved
    // an authenticated principal, caller args are verified against it:
    // matching/absent args → principal; mismatching args → curator-only
    // explicit override, otherwise the mismatch is REJECTED loudly. Silently
    // re-attributing a spoofed/mistaken identity to the principal would hide
    // caller bugs — fail-loud is the contract (mcp-protocol.test 'rejects
    // unregistered identities and mismatched id/name pairs').
    const principal = resolveConnectionPrincipal(cwd, sessionId);
    if (principal) {
      // Re-load per call (cheap) so trust changes propagate mid-connection;
      // the BINDING (who you are) stays pinned.
      const principalDoc = findAgentIdentityById(principal.agent_id, cwd);
      if (principalDoc) {
        const mismatch =
          (explicitName !== undefined && normalizeAgentName(explicitName) !== normalizeAgentName(principal.agent_name))
          || (explicitId !== undefined && explicitId !== principal.agent_id);
        if (!mismatch) {
          return { identity: principalDoc };
        }
        if ((principalDoc.trust_level ?? 'contributor') === 'curator') {
          return {
            identity: requireRegisteredAgentIdentity({
              agentName: explicitName,
              agentId: explicitId,
              cwd,
              allowCurrent: true,
              allowEnv: true,
            }),
          };
        }
        return {
          error: {
            kind: 'identity_error',
            message: `Caller-supplied identity (agent=${explicitName ?? '<none>'}, agentId=${explicitId ?? '<none>'}) does not match the pinned connection principal '${principal.agent_name}' (${principal.agent_id}). Omit the identity args, or have a curator perform the override.`,
          },
        };
      }
    }

    // No pinned principal (unregistered connection): legacy chain.
    // Session-pinned identity: if no explicit agent in args, use the session's pinned agent
    let agentName = explicitName;
    if (!agentName && sessionId) {
      const session = loadSessionById(sessionId, cwd);
      if (session?.agent) {
        agentName = session.agent;
      }
    }
    return {
      identity: requireRegisteredAgentIdentity({
        agentName,
        agentId: explicitId,
        cwd,
        allowCurrent: true,
        allowEnv: true,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof AgentIdentityResolutionError) {
      return {
        error: {
          kind: error.kind,
          message: error.message,
          details: error.details,
        } satisfies McpToolErrorShape,
      };
    }
    return {
      error: {
        kind: 'identity_error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies McpToolErrorShape,
    };
  }
}

export function ensureTrust(
  args: Record<string, unknown>,
  fields: { nameField: string; idField: string },
  level: 'contributor' | 'trusted' | 'curator',
  cwd?: string,
  sessionId?: string,
): { identity?: ReturnType<typeof requireRegisteredAgentIdentity>; error?: McpToolErrorShape } {
  const resolved = resolveMutationIdentity(args, fields, cwd, sessionId);
  if ('error' in resolved) {
    return resolved;
  }

  try {
    requireMinimumTrustLevel(resolved.identity, level);
    return resolved;
  } catch (error: unknown) {
    if (error instanceof AgentTrustError) {
      return {
        error: {
          kind: error.kind,
          message: error.message,
          details: error.details,
        },
      };
    }
    return {
      error: {
        kind: 'trust_error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
