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
  resolveOrAutoRegisterAgentIdentity,
} from '../core/agent-registry.js';
import { loadClaim } from '../core/claims.js';
import { loadConfig } from '../core/config.js';
import { isObserverMode } from '../core/observer-mode.js';
import { buildOperationalIdentity, loadCurrentSession, loadSessionById, saveCurrentSession } from '../core/identity.js';
import type { ResolvedEffectiveCwd } from '../core/store-resolution.js';
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

// ── Canonical-grammar author resolution + scope metadata (pln#622 PR4) ───────
// Moved from mcp.ts: mutation-author resolution and scope-metadata helpers used
// by the canonical CRUD write handlers (mcp-write-entities.ts). Co-located here
// with resolveMutationIdentity/resolveConnectionPrincipal, which they call.

export interface CanonicalAuthorAutoRepair {
  /** True if the agent identity itself was auto-registered (first use). */
  agent_auto_registered?: boolean;
  /** Session id that was materialized by the auto-repair path, if any. */
  session_auto_created?: string;
}

export interface CanonicalAuthorResolution {
  agent_name: string;
  agent_id?: string;
  /** Undefined when the strict path resolved cleanly (no announcement needed). */
  auto_repair?: CanonicalAuthorAutoRepair;
}

export function explicitSessionIdFromEnv(): string | undefined {
  return process.env.BRAINCLAW_SESSION_ID?.trim()
    || process.env.OPENCLAW_SESSION_ID?.trim()
    || process.env.CLAUDE_SESSION_ID?.trim()
    || process.env.COPILOT_SESSION_ID?.trim();
}

export function projectInfoForCwd(cwd: string): { path: string; name?: string } {
  try {
    const config = loadConfig(cwd);
    return { path: cwd, name: config.project_name };
  } catch {
    return { path: cwd };
  }
}

/**
 * Resolve the agent identity for canonical-grammar mutation verbs
 * (bclaw_create/update/remove/transition), so handlers can auto-fill required
 * fields (e.g. plan.author) instead of letting the create land on disk with a
 * missing field — which would then be silently GC'd by the state sync loop
 * (see fix plan pln_5f44426c).
 *
 * pln#562 step 3 — a write that would create a record with a missing/'unknown'
 * author must never be silent (that produced records that passed creation but
 * were schema-invalid on read and silently GC'd from disk).
 *
 * pln#608 — extended with auto-repair: when the caller has no session but a
 * derivable agent name (arg / $BRAINCLAW_AGENT_NAME / detected AI agent),
 * fall through to `resolveOrAutoRegisterAgentIdentity` and materialize the
 * session via `buildOperationalIdentity({ persistImplicitSession: true })`
 * (same mechanic as switchProject:86-106 and session-start). The freshly-
 * created session is tagged `auto_created` so aggressive harvesting can
 * distinguish it from operator sessions (pln#602). The caller receives
 * `auto_repair` and surfaces it as a warning — never silent.
 *
 * KEEP (still a hard error, doctrine boundary): the identity is ambiguous
 * (no name in args, no env signal, no detectable agent). We do not invent
 * an identity — invoke intent is unclear and the write would misattribute.
 */
export function resolveCanonicalAuthor(
  args: Record<string, unknown>,
  cwd?: string,
  connectionSessionId?: string,
): CanonicalAuthorResolution {
  const resolved = resolveMutationIdentity(
    args,
    { nameField: 'agent', idField: 'agentId' },
    cwd,
    connectionSessionId,
  );
  if ('identity' in resolved && resolved.identity) {
    return {
      agent_name: resolved.identity.agent_name,
      agent_id: resolved.identity.agent_id,
    };
  }

  const strictError = 'error' in resolved && resolved.error ? resolved.error : undefined;

  // KEEP (doctrine boundary): a pinned principal that rejected the caller args
  // is a SPOOF/MISMATCH, not an ambiguous first-write. Never auto-repair over
  // it — silently re-attributing would defeat pln#562 step 3. The strict error
  // already carries the pointer to a curator override.
  if (resolveConnectionPrincipal(cwd, connectionSessionId)) {
    throw new Error(
      `cannot resolve mutation author: ${strictError?.message ?? 'principal mismatch'}`,
    );
  }

  // Observer processes are read-only dashboards/inspectors. Even when an env
  // variable leaks an agent name into the observer process, canonical writes
  // must not use the auto-repair path because it can mint identity/session
  // state as a side effect.
  if (isObserverMode()) {
    throw new Error(
      `cannot resolve mutation author: ${strictError?.message ?? 'observer mode cannot auto-repair identity/session state'}`,
    );
  }

  const explicitName = typeof args.agent === 'string' ? args.agent : undefined;
  const explicitId = typeof args.agentId === 'string' ? args.agentId : undefined;
  // resolveOrAutoRegisterAgentIdentity's fall-through helper only reads
  // BRAINCLAW_AGENT / OPENCLAW_AGENT. resolveCurrentAgentIdentity also honors
  // BRAINCLAW_AGENT_NAME, and dispatched workers set both. Normalize here so
  // an env-declared name is a first-class signal to the auto-repair path.
  const envAgentName = explicitName
    ?? (process.env.BRAINCLAW_AGENT_NAME?.trim() || undefined)
    ?? (process.env.BRAINCLAW_AGENT?.trim() || undefined);

  let identity;
  let autoRegistered: boolean;
  try {
    const outcome = resolveOrAutoRegisterAgentIdentity({
      agentName: envAgentName,
      agentId: explicitId,
      cwd,
      allowCurrent: true,
      allowEnv: true,
    });
    identity = outcome.identity;
    autoRegistered = outcome.auto_registered;
  } catch (err) {
    // Genuine ambiguity — no derivable name. Stays a hard error (KEEP: doctrine
    // boundary is "ambiguous intent → refuse with next_action", not silence).
    const detail = err instanceof Error ? err.message : (strictError?.message ?? String(err));
    throw new Error(
      `cannot resolve mutation author: ${detail} `
      + 'Pass a registered agent, set $BRAINCLAW_AGENT_NAME, '
      + 'or register with `brainclaw register-agent <name>` before writing.',
      { cause: err },
    );
  }

  const explicitSessionId = connectionSessionId?.trim() || explicitSessionIdFromEnv();
  const hadSessionBefore = explicitSessionId
    ? Boolean(loadSessionById(explicitSessionId, cwd))
    : Boolean(loadCurrentSession(cwd));

  let sessionAutoCreated: string | undefined;
  try {
    const opIdentity = buildOperationalIdentity(identity.agent_name, cwd, {
      agentId: identity.agent_id,
      sessionId: explicitSessionId,
      persistImplicitSession: true,
    });
    if (!hadSessionBefore && opIdentity.session_id) {
      sessionAutoCreated = opIdentity.session_id;
      const session = loadSessionById(opIdentity.session_id, cwd);
      if (session && !session.auto_created) {
        saveCurrentSession({ ...session, auto_created: true }, cwd);
      }
    }
  } catch { /* best-effort — write can still proceed without a persisted session */ }

  const autoRepair: CanonicalAuthorAutoRepair | undefined = (autoRegistered || sessionAutoCreated)
    ? {
        ...(autoRegistered ? { agent_auto_registered: true } : {}),
        ...(sessionAutoCreated ? { session_auto_created: sessionAutoCreated } : {}),
      }
    : undefined;

  return {
    agent_name: identity.agent_name,
    agent_id: identity.agent_id,
    ...(autoRepair ? { auto_repair: autoRepair } : {}),
  };
}

export function renderAutoRepairWarning(auto_repair: CanonicalAuthorAutoRepair, agent_name: string): string {
  const parts: string[] = [];
  if (auto_repair.agent_auto_registered) {
    parts.push(`agent '${agent_name}' auto-registered (first use). Run \`brainclaw register-agent ${agent_name}\` to set capabilities and trust level.`);
  }
  if (auto_repair.session_auto_created) {
    parts.push(`session ${auto_repair.session_auto_created} auto-created for this write.`);
  }
  return `⚠️ auto-repair: ${parts.join(' ')}`;
}

export function scopeMetadataForTarget(
  args: Record<string, unknown>,
  targetCwd: string,
  effectiveScope: ResolvedEffectiveCwd,
): { resolved_project: { path: string; name?: string }; active_source: ResolvedEffectiveCwd['active_source'] | 'explicit' } {
  const hasExplicitProject = typeof args.project === 'string' && args.project.trim().length > 0;
  return {
    resolved_project: projectInfoForCwd(targetCwd),
    active_source: hasExplicitProject ? 'explicit' : effectiveScope.active_source,
  };
}
