import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaimSchema, type Claim, type PlanStatus } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO } from './ids.js';
import { JsonStore } from './json-store.js';
import { loadConfig } from './config.js';
import { createWorktree, resetWorktreeToRef } from './worktree.js';
import { appendAuditEntry } from './audit.js';
import { refreshLiveCompanions } from '../commands/export.js';
import { loadSessionById } from './identity.js';
import { loadState, persistState } from './state.js';
import { createRuntimeEvent } from './events.js';

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

export interface AcquireClaimScopeInput {
  scope: string;
  agent: string;
  agent_id?: string;
  description: string;
  // Optional fields passed through to saveClaim.
  user?: string;
  session_id?: string;
  plan_id?: string;
  model?: string;
}

export interface AcquireClaimScopeResult {
  /** True if we saved a new active claim. */
  acquired: boolean;
  /** The new claim when acquired === true. */
  claim?: Claim;
  /** The other active claim already on the scope when acquired === false. */
  conflicting_claim?: Claim;
}

/**
 * Atomically check for an active claim on `scope` and save a new one if absent.
 *
 * Atomicity is provided by running both operations inside a single mutate() call;
 * the mutation-pipeline mutex serializes filesystem writes on the claims store.
 */
export function acquireClaimScope(input: AcquireClaimScopeInput, cwd?: string): AcquireClaimScopeResult {
  return mutate({ cwd }, () => {
    const conflictingClaim = listClaims(cwd).find(
      (claim) => claim.status === 'active' && claim.scope === input.scope,
    );
    if (conflictingClaim) {
      return { acquired: false, conflicting_claim: conflictingClaim };
    }

    const claim: Claim = {
      id: generateClaimId(),
      agent: input.agent,
      agent_id: input.agent_id,
      user: input.user,
      session_id: input.session_id,
      scope: input.scope,
      description: input.description,
      created_at: nowISO(),
      status: 'active',
      plan_id: input.plan_id,
      model: input.model,
    };

    saveClaim(claim, cwd);
    return { acquired: true, claim };
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

export interface ReleaseClaimCascadeOptions {
  planStatus?: string;
  cwd?: string;
}

export interface ReleaseClaimCascadeResult {
  claim: Claim;
  planTransitioned: boolean;
  /** Set when planStatus=done but other active claims still exist — plan stays in_progress. */
  planWarning?: string;
  planId?: string;
  newPlanStatus?: string;
  otherActiveClaimsCount?: number;
}

/**
 * Release a claim and optionally cascade the status to its linked plan.
 *
 * Rules:
 * - planStatus='done'    → only transition plan if NO OTHER active claims on same plan (last-claim rule).
 *                          If other active claims exist, warn and leave plan in_progress.
 * - planStatus='blocked' → always propagate to plan.
 * - planStatus='todo'/'in_progress' or undefined → no cascade.
 *
 * Emits `plan_cascade_to_done` runtime event when auto-transitioning to done.
 */
export function releaseClaimWithCascade(
  id: string,
  options: ReleaseClaimCascadeOptions = {},
): ReleaseClaimCascadeResult {
  const { planStatus, cwd } = options;

  // Release the claim (idempotent: already-released claims are returned as-is)
  const claim = loadClaim(id, cwd);
  if (claim.status === 'released') {
    return { claim, planTransitioned: false };
  }
  claim.status = 'released';
  claim.released_at = nowISO();
  saveClaim(claim, cwd);

  appendAuditEntry(
    {
      actor: claim.agent,
      actor_id: claim.agent_id,
      action: 'release_claim',
      item_id: id,
      item_type: 'claim',
      scope: claim.scope,
      session_id: claim.session_id,
      host_id: claim.host_id,
    },
    cwd,
  );

  // No cascade requested or no linked plan
  if (!planStatus || !claim.plan_id) {
    return { claim, planTransitioned: false };
  }

  const state = loadState(cwd);
  const plan = state.plan_items.find((item) => item.id === claim.plan_id);
  if (!plan) {
    return { claim, planTransitioned: false };
  }

  const ts = nowISO();

  if (planStatus === 'blocked') {
    // Always propagate blocked status to plan
    plan.status = 'blocked' as PlanStatus;
    plan.updated_at = ts;
    persistState(state, cwd);
    return { claim, planTransitioned: true, planId: plan.id, newPlanStatus: 'blocked' };
  }

  if (planStatus === 'done') {
    // Count OTHER active claims on the same plan (current claim already released above)
    const otherActive = listClaims(cwd).filter(
      (c) => c.status === 'active' && c.plan_id === claim.plan_id && c.id !== id,
    );

    if (otherActive.length > 0) {
      const planWarning = `Plan has ${otherActive.length} other active claim(s); staying in_progress`;
      appendAuditEntry(
        {
          actor: claim.agent,
          action: 'update',
          item_id: plan.id,
          item_type: 'plan',
          after: { cascade_blocked: true, reason: planWarning },
        },
        cwd,
      );
      return {
        claim,
        planTransitioned: false,
        planWarning,
        planId: plan.id,
        newPlanStatus: plan.status,
        otherActiveClaimsCount: otherActive.length,
      };
    }

    // Last active claim released → auto-transition plan to done
    plan.status = 'done' as PlanStatus;
    if (!plan.completed_at) plan.completed_at = ts;
    plan.updated_at = ts;
    persistState(state, cwd);

    createRuntimeEvent(
      {
        agent: claim.agent,
        agent_id: claim.agent_id,
        event_type: 'plan_cascade_to_done',
        claim_id: id,
        plan_id: plan.id,
        session_id: claim.session_id,
        host_id: claim.host_id,
        text: `Plan ${plan.id} auto-transitioned to done — last active claim released by ${claim.agent}`,
      },
      cwd,
    );

    return { claim, planTransitioned: true, planId: plan.id, newPlanStatus: 'done' };
  }

  // planStatus='todo', 'in_progress', or other — no cascade
  return { claim, planTransitioned: false };
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
 * Threshold below which a newly created claim is considered "young" and must not be auto-released,
 * even if it has no session yet (coordinator claims are created before the worker session starts).
 */
const YOUNG_CLAIM_THRESHOLD_MS = 30 * 60_000; // 30 minutes

/**
 * Liveness status for an active claim.
 *
 * - `live`          — adopted session is still alive; do NOT auto-release.
 * - `young`         — claim is too recently created to classify; do NOT auto-release.
 * - `orphaned`      — claim was adopted (session_id + adopted_at set) but the session died (crash).
 * - `stale`         — claim has a session_id but the session is dead and was never formally adopted
 *                     (e.g. directly-created agent claim whose session ended).
 * - `never-adopted` — no session_id ever assigned and claim is older than the stale threshold
 *                     (coordinator claim that was never dispatched).
 */
export type ClaimLivenessStatus = 'live' | 'young' | 'orphaned' | 'stale' | 'never-adopted';

export interface ClaimLivenessAssessment {
  status: ClaimLivenessStatus;
  /** Human-readable explanation of why this status was assigned. */
  reason: string;
  /** Claim age in milliseconds at assessment time. */
  ageMs: number;
  /** Session's last_seen_at age in milliseconds, if a session was found. */
  sessionAgeMs?: number;
}

export interface AssessClaimLivenessOptions {
  /** Auto-release threshold in hours (default: 24). */
  thresholdHours?: number;
  /** Session TTL in milliseconds — overrides config (for testing). */
  sessionTtlMs?: number;
  /** Current timestamp override (for testing). */
  nowMs?: number;
  /** brainclaw store root (for session file reads). */
  cwd?: string;
}

/**
 * Assess the liveness of an active claim against session state.
 *
 * Decision tree:
 *  1. Young (< 30 min) → never auto-release — dispatcher may not have sent the worker yet.
 *  2. Has session_id + session alive → 'live' — long-running work; do NOT release.
 *  3. Has session_id + adopted_at + session dead → 'orphaned' — crash recovery scenario.
 *  4. Has session_id + no adopted_at + session dead → 'stale' — direct agent claim, session ended.
 *  5. No session_id + old → 'never-adopted' — coordinator claim never dispatched.
 *  6. No session_id + within threshold → 'young'.
 */
export function assessClaimLiveness(
  claim: Claim,
  options: AssessClaimLivenessOptions = {},
): ClaimLivenessAssessment {
  const nowMs = options.nowMs ?? Date.now();
  const thresholdMs = (options.thresholdHours ?? DEFAULT_STALE_HOURS) * 3_600_000;
  const ageMs = nowMs - new Date(claim.created_at).getTime();

  // 1. Too young to classify — don't release (worker may not have started yet)
  if (ageMs < YOUNG_CLAIM_THRESHOLD_MS) {
    return {
      status: 'young',
      reason: 'Claim is less than 30 minutes old — too new to classify',
      ageMs,
    };
  }

  // 2–4. Has a session_id — check session liveness
  if (claim.session_id) {
    let sessionAgeMs: number | undefined;
    let sessionAlive = false;
    let sessionMissing = false;
    const sessionTtlMs = options.sessionTtlMs ?? resolveSessionTtlMs(options.cwd);

    try {
      const session = loadSessionById(claim.session_id, options.cwd);
      if (session) {
        sessionAgeMs = nowMs - new Date(session.last_seen_at).getTime();
        sessionAlive = sessionAgeMs < sessionTtlMs;
      } else {
        // File not found — session either ended cleanly (session-end deletes it)
        // or the record was deleted externally. Either way, session cannot return.
        sessionMissing = true;
      }
    } catch {
      // Session file error — treat as dead to avoid hanging claims forever.
      sessionMissing = true;
    }

    if (sessionAlive) {
      return {
        status: 'live',
        reason: `Session ${claim.session_id} is active (last_seen_at within TTL)`,
        ageMs,
        sessionAgeMs,
      };
    }

    // Session is dead or not found.
    if (claim.adopted_at) {
      // Worker was dispatched and formally adopted the claim — this is a crash.
      const sessionDesc = sessionMissing
        ? 'session record cannot be found'
        : `last seen ${Math.round((sessionAgeMs ?? 0) / 3_600_000)}h ago`;
      return {
        status: 'orphaned',
        reason: `Session ${claim.session_id} was adopted at ${claim.adopted_at} but is now dead (${sessionDesc})`,
        ageMs,
        sessionAgeMs,
      };
    }

    // Direct agent claim, no adopted_at, session dead (Phase 4 slice pln#388):
    // once we have confirmed the session cannot return — either the file is
    // missing (clean end) or last_seen_at is well past the TTL — mark stale
    // immediately. The old 24h age threshold forced orphaned claims to hang
    // around purely because of wall-clock age, even though we already knew
    // they belonged to a dead session.
    const sessionConfirmedDead = sessionMissing
      || (sessionAgeMs !== undefined && sessionAgeMs >= sessionTtlMs + YOUNG_CLAIM_THRESHOLD_MS);
    if (sessionConfirmedDead) {
      const reason = sessionMissing
        ? `Session ${claim.session_id} record is gone (ended cleanly or deleted externally)`
        : `Session ${claim.session_id} last_seen_at is ${Math.round((sessionAgeMs ?? 0) / 3_600_000)}h past TTL`;
      return {
        status: 'stale',
        reason,
        ageMs,
        sessionAgeMs,
      };
    }

    // Session last_seen_at just slipped past TTL — allow a short grace window
    // in case the session heartbeat catches up (brief disconnect).
    return {
      status: 'young',
      reason: 'Session is briefly past TTL — waiting for heartbeat or confirmed end',
      ageMs,
      sessionAgeMs,
    };
  }

  // 5–6. No session_id — coordinator claim that was never dispatched
  if (ageMs >= thresholdMs) {
    return {
      status: 'never-adopted',
      reason: `No session ever adopted this claim and it is ${Math.round(ageMs / 3_600_000)}h old (threshold: ${options.thresholdHours ?? DEFAULT_STALE_HOURS}h)`,
      ageMs,
    };
  }

  return {
    status: 'young',
    reason: 'Claim has not been adopted by a session yet but is still within the stale threshold',
    ageMs,
  };
}

/** Resolve session TTL from config, falling back to 4 hours. */
function resolveSessionTtlMs(cwd?: string): number {
  try {
    return parseTtl(loadConfig(cwd).implicit_session_ttl ?? '4h');
  } catch {
    return 4 * 3_600_000;
  }
}

/**
 * Check if a claim is stale based on session-aware liveness.
 * Returns true for 'stale', 'orphaned', and 'never-adopted' statuses.
 * A claim with a live session is never considered stale regardless of age.
 */
export function isClaimStale(claim: Claim, thresholdHours?: number, cwd?: string): boolean {
  if (claim.status !== 'active') return false;
  const { status } = assessClaimLiveness(claim, { thresholdHours, cwd });
  return status === 'stale' || status === 'orphaned' || status === 'never-adopted';
}

export interface StaleClaimResult {
  released: Claim[];
  warned: Claim[];
}

/**
 * Detect and auto-release stale claims across the store.
 *
 * Phase 4 slice pln#388 stp_e2b10ab4: session-aware safety. When a
 * `currentSessionId` is provided, the sweep skips only claims that
 * belong to THAT session — prior-session claims from the same agent
 * are legitimately reclaimable (crash recovery for the same agent on
 * reconnect). Without `currentSessionId` we fall back to the old
 * "skip same agent" rule to stay source-compatible.
 *
 * Uses claims.auto_release_after from config (default 24h).
 * Skips claims whose session is still live ('live') or too young to
 * classify ('young'). Releases 'stale', 'orphaned' (crash recovery),
 * and 'never-adopted' claims.
 */
export function releaseStaleClaimsFromOtherAgents(
  currentAgent?: string,
  cwd?: string,
  currentSessionId?: string,
): StaleClaimResult {
  const config = loadConfig(cwd);
  const thresholdHours = config.claims?.auto_release_after_hours ?? DEFAULT_STALE_HOURS;
  const store = claimStore(cwd);
  const all = store.list();
  const now = nowISO();
  const released: Claim[] = [];
  const warned: Claim[] = [];

  for (const claim of all) {
    if (claim.status !== 'active') continue;

    // Session-aware skip: if the caller names its current session, only that
    // session's claims are off-limits. Otherwise fall back to the legacy
    // "skip same agent" rule.
    if (currentSessionId) {
      if (claim.session_id === currentSessionId) continue;
    } else if (claim.agent === currentAgent) {
      continue;
    }

    const { status } = assessClaimLiveness(claim, { thresholdHours, cwd });
    if (status === 'live' || status === 'young') continue;

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
  worktreeBaseRef?: string;
  resetExistingWorktreeBranch?: boolean;
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
      // Same agent already has this scope — reuse the claim (backward compat,
      // same-agent multi-call). If the caller pinned a base ref, the reused
      // worktree MUST be re-pointed to it; otherwise a dispatch that relied on
      // the ref (e.g. the dirty-guard bypass) would run the worker on a stale
      // worktree — the same silent false-negative the guard exists to prevent
      // (pln#520 Tier 2 / codex r2).
      let reuseWarning: string | undefined;
      if (options.worktreeBaseRef) {
        if (existingScopeClaim.worktree_path) {
          const reset = resetWorktreeToRef(existingScopeClaim.worktree_path, options.worktreeBaseRef);
          if (!reset.ok) {
            reuseWarning = `Reused claim ${existingScopeClaim.id} pinned to ref "${options.worktreeBaseRef}": ${reset.stderr.trim()}`;
          }
        } else {
          reuseWarning = `Reused claim ${existingScopeClaim.id} has no worktree to pin to ref "${options.worktreeBaseRef}".`;
        }
      }
      return {
        claimId: existingScopeClaim.id,
        worktreePath: existingScopeClaim.worktree_path,
        worktreeWarning: reuseWarning,
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
      baseRef: options.worktreeBaseRef,
      // A pinned base ref implies the branch must be reset to it: createWorktree
      // otherwise reuses a pre-existing feat/<scope> branch and ignores baseRef.
      // Deriving it here (not only at the call site) keeps the invariant — "a
      // pinned ref ⇒ the worktree reflects that ref" — owned by this chokepoint.
      resetExistingBranch: options.resetExistingWorktreeBranch || Boolean(options.worktreeBaseRef),
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

/** Link a claim to its Assignment entity (Agent SDK runtime protocol). */
export function linkClaimToAssignment(claimId: string, assignmentId: string, cwd?: string): void {
  const claim = loadClaim(claimId, cwd);
  claim.assignment_id = assignmentId;
  saveClaim(claim, cwd);
}

/**
 * Adopt a claim from a spawned instance's session.
 * Sets session_id + adopted_at on the claim. Refuses if the claim is already
 * adopted by a different live session (prevents race conditions).
 *
 * Codex r1 finding (pln#388 stp_aa095668 review): the whole load/decide/save
 * sequence runs inside a single `mutate` critical section so two reconnecting
 * workers racing on a dead-session claim cannot both succeed — the second
 * adopter re-reads the claim under the lock and observes the first
 * adopter's session_id as live.
 */
export function adoptClaimSession(
  claimId: string,
  sessionId: string,
  cwd?: string,
): { adopted: boolean; reason: string } {
  return mutate({ cwd }, () => {
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
  });
}
