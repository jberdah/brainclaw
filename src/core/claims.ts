import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaimSchema, type Claim } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO } from './ids.js';
import { JsonStore } from './json-store.js';
import { loadConfig } from './config.js';
import { createWorktree } from './worktree.js';
import { appendAuditEntry } from './audit.js';
import { refreshLiveCompanions } from '../commands/export.js';
import { loadSessionById } from './identity.js';

/** Parse duration string like '4h', '30m' to ms. */
function parseTtl(value: string): number {
  const match = /^(\d+)([mhd])$/i.exec(value.trim());
  if (!match) return 4 * 3_600_000;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 3_600_000;
  return amount * 86_400_000;
}

function claimsDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('claims', cwd ?? process.cwd(), mode);
}

export function ensureClaimsDir(cwd?: string): void {
  const dir = claimsDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function claimStore(cwd?: string): JsonStore<Claim> {
  return new JsonStore<Claim>({
    dirPath: claimsDir(cwd, 'read'),
    documentType: 'claim',
    getId: (claim) => claim.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

export function saveClaim(claim: Claim, cwd?: string): void {
  mutate({ cwd }, () => {
    ensureClaimsDir(cwd);
    const writeStore = new JsonStore<Claim>({
      dirPath: claimsDir(cwd, 'write'),
      documentType: 'claim',
      getId: (c) => c.id,
      sort: (a, b) => a.created_at.localeCompare(b.created_at),
    });
    writeStore.save(ClaimSchema.parse(claim));
    // Auto-refresh live companions after claim changes (non-fatal)
    try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
  });
}

export function loadClaim(id: string, cwd?: string): Claim {
  return claimStore(cwd).load(id);
}

export function listClaims(cwd?: string): Claim[] {
  return claimStore(cwd).list();
}

export function releaseClaim(id: string, cwd?: string): Claim {
  const claim = loadClaim(id, cwd);
  claim.status = 'released';
  claim.released_at = nowISO();
  saveClaim(claim, cwd);
  return claim;
}

export function generateClaimId(): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `clm_${rand}`;
}

export function isClaimExpired(claim: Claim): boolean {
  if (!claim.expires_at) return false;
  return new Date(claim.expires_at) < new Date();
}

/** Mark active claims past their expires_at as released. Returns count of expired claims. */
export function expireStaleActiveClaims(cwd?: string): number {
  const store = claimStore(cwd);
  const all = store.list();
  let count = 0;
  const now = nowISO();
  for (const claim of all) {
    if (claim.status === 'active' && isClaimExpired(claim)) {
      claim.status = 'released';
      claim.released_at = now;
      store.save(claim);
      count++;
    }
  }
  return count;
}

/** Default stale threshold: 24 hours. */
const DEFAULT_STALE_HOURS = 24;

/**
 * Check if a claim is stale based on inactivity.
 * A claim is stale if created_at is older than threshold and no session is active for the agent.
 */
export function isClaimStale(claim: Claim, thresholdHours?: number): boolean {
  if (claim.status !== 'active') return false;
  const hours = thresholdHours ?? DEFAULT_STALE_HOURS;
  const ageMs = Date.now() - new Date(claim.created_at).getTime();
  return ageMs > hours * 3600_000;
}

export interface StaleClaimResult {
  released: Claim[];
  warned: Claim[];
}

/**
 * Detect and auto-release stale claims from other agents.
 * Uses claims.auto_release_after from config (default 24h).
 * Skips claims from the current agent (they should use session_end --auto-release).
 */
export function releaseStaleClaimsFromOtherAgents(currentAgent?: string, cwd?: string): StaleClaimResult {
  const config = loadConfig(cwd);
  const thresholdHours = config.claims?.auto_release_after_hours ?? DEFAULT_STALE_HOURS;
  const store = claimStore(cwd);
  const all = store.list();
  const now = nowISO();
  const released: Claim[] = [];
  const warned: Claim[] = [];

  for (const claim of all) {
    if (claim.status !== 'active') continue;
    if (claim.agent === currentAgent) continue; // skip own claims
    if (!isClaimStale(claim, thresholdHours)) continue;

    claim.status = 'released';
    claim.released_at = now;
    store.save(claim);
    released.push(claim);
  }

  return { released, warned };
}

// ── Coordinator-owned claim ─────────────────────────────────

export interface CoordinatorClaimOptions {
  agent: string;
  scope: string;
  description: string;
  planId?: string;
  dispatcherAgent: string;
  sessionId?: string;
  cwd: string;
}

export interface CoordinatorClaimResult {
  claimId: string;
  worktreePath?: string;
  worktreeWarning?: string;
  reusedExisting?: boolean;
  /** True if the scope is locked by a DIFFERENT agent — dispatcher should skip this plan. */
  scopeConflict?: boolean;
  /** Agent that holds the conflicting scope claim. */
  conflictAgent?: string;
}

/**
 * Create a coordinator-owned claim with worktree isolation.
 * Encapsulates: generateClaimId + createWorktree + saveClaim + audit.
 * Used by both bclaw_dispatch and bclaw_coordinate assign/reroute.
 */
export function createCoordinatorClaim(options: CoordinatorClaimOptions): CoordinatorClaimResult {
  // Scope lock is GLOBAL: any active claim on the same scope blocks, regardless of agent.
  const existingScopeClaim = listClaims(options.cwd).find(
    (claim) => claim.status === 'active' && claim.scope === options.scope,
  );
  if (existingScopeClaim) {
    if (existingScopeClaim.agent === options.agent) {
      // Same agent already has this scope — reuse the claim (backward compat, same-agent multi-call).
      return {
        claimId: existingScopeClaim.id,
        worktreePath: existingScopeClaim.worktree_path,
        reusedExisting: true,
      };
    }
    // DIFFERENT agent has an active claim on this scope — scope is locked.
    // Return the existing claim info + a conflict flag so the dispatcher can skip.
    return {
      claimId: existingScopeClaim.id,
      worktreePath: existingScopeClaim.worktree_path,
      reusedExisting: true,
      scopeConflict: true,
      conflictAgent: existingScopeClaim.agent,
    };
  }

  const claimId = generateClaimId();
  let worktreePath: string | undefined;
  let worktreeWarning: string | undefined;

  // Create isolated worktree (matching bclaw_claim MCP handler behavior)
  const branchSlug = options.scope.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 48);
  const worktreeBranch = `feat/${branchSlug}`;
  try {
    worktreePath = createWorktree(options.cwd, worktreeBranch, {
      sessionId: options.sessionId,
      agent: options.agent,
    });
  } catch (err) {
    worktreeWarning = `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  saveClaim({
    id: claimId,
    agent: options.agent,
    scope: options.scope,
    description: options.description,
    plan_id: options.planId,
    created_at: nowISO(),
    status: 'active',
    worktree_path: worktreePath,
  }, options.cwd);

  appendAuditEntry({
    actor: options.dispatcherAgent,
    action: 'claim',
    item_id: claimId,
    item_type: 'claim',
    scope: options.scope,
  }, options.cwd);

  return { claimId, worktreePath, worktreeWarning, reusedExisting: false };
}

// ── Claim lifecycle helpers for multi-instance dispatch ────

/**
 * Attach the assignment message ID to a claim (for tracing claim→message→instance).
 * Called by the dispatcher after sending the inbox message.
 */
export function attachAssignmentMessageToClaim(claimId: string, messageId: string, cwd?: string): void {
  const claim = loadClaim(claimId, cwd);
  claim.assignment_message_id = messageId;
  saveClaim(claim, cwd);
}

/**
 * Adopt a claim from a spawned instance's session.
 * Sets session_id + adopted_at on the claim. Refuses if the claim is already
 * adopted by a different live session (prevents race conditions).
 */
export function adoptClaimSession(
  claimId: string,
  sessionId: string,
  cwd?: string,
): { adopted: boolean; reason: string } {
  const claim = loadClaim(claimId, cwd);
  if (claim.status !== 'active') {
    return { adopted: false, reason: `Claim ${claimId} is not active (status: ${claim.status})` };
  }
  if (claim.session_id && claim.session_id !== sessionId) {
    // Check if the existing session is still alive — allow re-adoption if dead/stale
    let isAlive = false;
    try {
      const existingSession = loadSessionById(claim.session_id, cwd);
      if (existingSession) {
        let ttlMs = 4 * 3_600_000; // default 4h
        try { ttlMs = parseTtl(loadConfig(cwd).implicit_session_ttl ?? '4h'); } catch { /* use default */ }
        const lastSeen = new Date(existingSession.last_seen_at).getTime();
        isAlive = !isNaN(lastSeen) && (Date.now() - lastSeen) < ttlMs;
      }
    } catch { /* session file error — treat as dead */ }
    if (isAlive) {
      return { adopted: false, reason: `Claim ${claimId} already adopted by live session ${claim.session_id}` };
    }
    // Existing session is dead/stale — allow re-adoption
  }
  claim.session_id = sessionId;
  claim.adopted_at = nowISO();
  saveClaim(claim, cwd);
  return { adopted: true, reason: 'ok' };
}
