import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaimSchema, type Claim, type PlanStatus } from './schema.js';
import { entityRecordDirs, resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO } from './ids.js';
import { JsonStore } from './json-store.js';
import { loadConfig } from './config.js';
import { createWorktree, resetWorktreeToRef, removeWorktree, sanitizeBranchComponent } from './worktree.js';
import { appendAuditEntry } from './audit.js';
import { refreshLiveCompanions } from '../commands/export.js';
import { loadSessionById } from './identity.js';
import { loadState, persistState } from './state.js';
import { createRuntimeEvent } from './events.js';
import { latestActivityMs, readHeartbeat } from './runtime-signals.js';
import { emitRegistryPostImage, registryFaultPoint } from './events/registry-post-image.js';

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

/**
 * Both layouts a claim record can occupy, canonical first (pln#649).
 *
 * The previous shape — `Set([claimsDir(write), claimsDir(read)])` — LOOKED like it
 * covered both and did not: `write` is always canonical, and `read` also returns
 * canonical as soon as that directory holds any file, so the Set collapsed to ONE
 * entry and a legacy claim went invisible mid-migration. Same defect as the one
 * reproduced twice on assignments; found here by a Fable audit before it reached a
 * field report. Now derived from the shared io.ts primitive, so there is one
 * definition instead of four look-alikes.
 */
function claimDirs(cwd?: string): string[] {
  return entityRecordDirs('claims', cwd ?? process.cwd());
}

export function ensureClaimsDir(cwd?: string): void {
  const dir = claimsDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function claimStoreForDir(dirPath: string): JsonStore<Claim> {
  return new JsonStore<Claim>({
    dirPath,
    documentType: 'claim',
    getId: (claim) => claim.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

function writeClaimStore(cwd?: string): JsonStore<Claim> {
  return claimStoreForDir(claimsDir(cwd, 'write'));
}

function loadClaimFromAnyDir(id: string, cwd?: string): Claim {
  for (const dirPath of claimDirs(cwd)) {
    const store = claimStoreForDir(dirPath);
    if (store.exists(id)) return store.load(id);
  }
  throw new Error(`claim '${id}' not found`);
}

function saveClaimUnlocked(
  claim: Claim,
  cwd?: string,
  options?: { refreshCompanions?: boolean },
): void {
  ensureClaimsDir(cwd);
  const store = writeClaimStore(cwd);
  const parsed = ClaimSchema.parse(claim);
  // pln#568 (I2): journal the post-image BEFORE the projection write, so a
  // crash can only leave the journal ahead of the projection, never behind.
  const created = !store.exists(parsed.id);
  emitRegistryPostImage('claim', parsed, { created, agent: parsed.agent, agent_id: parsed.agent_id, session_id: parsed.session_id, cwd });
  registryFaultPoint('after_registry_journal');
  store.save(parsed);
  const writeDir = claimsDir(cwd, 'write');
  for (const dirPath of claimDirs(cwd)) {
    if (dirPath === writeDir) continue;
    const legacyPath = path.join(dirPath, `${claim.id}.json`);
    try {
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch {
      // Best effort: listClaims() reads both dirs, so a missed cleanup remains visible.
    }
  }
  // Auto-refresh live companions after claim changes (non-fatal). Sweep loops
  // pass refreshCompanions:false and refresh ONCE after the loop — review
  // follow-up O5: a per-save refresh inside the critical section compounded an
  // O(store) cost on every iteration.
  if (options?.refreshCompanions !== false) {
    try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
  }
}

export function saveClaim(claim: Claim, cwd?: string): void {
  mutate({ cwd }, () => {
    saveClaimUnlocked(claim, cwd);
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
  /** pln#636 C0-b — declared file footprint, when the creator knows it. */
  paths?: string[];
}

/**
 * pln#636 C0-b — resolve the commit a claim starts from.
 *
 * Recorded once, at creation, and never updated: it is the fixed point a later
 * "what did this claim actually touch?" comparison needs. The design review
 * rejected both alternatives — neither HEAD-at-read-time nor the worktree dirty
 * set is authoritative once a lane commits mid-work.
 *
 * BEST-EFFORT BY CONSTRUCTION. A non-git project, a detached state, or a missing
 * git binary yields `undefined`, and a claim without a baseline is simply
 * `unverifiable` downstream. Claim acquisition must never fail because a
 * conformity nicety could not be computed.
 */
export function resolveClaimBaseSha(cwd?: string): string | undefined {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (result.status !== 0) return undefined;
    const sha = result.stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The baseline fields every NEW claim must carry, ready to spread into a claim
 * literal: `{ ...claimBaselineFields(cwd) }`.
 *
 * WHY A HELPER AND NOT AN INLINE CALL. `base_sha` shipped in 1.19.0 stamped from
 * exactly ONE place — inside `acquireClaimScope` — and it turned out nothing
 * user-facing calls that function. All four real creation paths
 * (`bclaw_work(execute)`, `bclaw_claim`, the CLI `claim create`, and
 * `createCoordinatorClaim`) build their claim literal inline and call `saveClaim`
 * directly, so NO real claim ever got a baseline and the whole conformity
 * reconcile that depends on it was inert (trp#1292). A named, greppable helper is
 * what makes "did this creation path stamp the baseline?" answerable, and it is
 * asserted per surface rather than only on the core function — testing
 * `acquireClaimScope` directly is exactly what hid the gap.
 *
 * Returns an EMPTY object rather than `{ base_sha: undefined }` so a claim created
 * outside a git repo has no such key at all, matching the "optional, never
 * backfilled" contract the schema documents.
 *
 * Deliberately NOT applied inside `saveClaim`: that function also persists
 * UPDATES (release, patch, adoption), and the baseline must be a fixed point —
 * re-stamping it on every save is precisely the moving-ground failure that made
 * `git diff HEAD` unusable in the first place.
 */
export function claimBaselineFields(cwd?: string): { base_sha?: string } {
  const base_sha = resolveClaimBaseSha(cwd);
  return base_sha ? { base_sha } : {};
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
  // Resolved OUTSIDE the mutate callback: one git call per acquisition, and it
  // stays off the critical section (mutate serializes filesystem writes on the
  // claims store, so a subprocess spawn inside it would widen the lock window).
  const baseline = claimBaselineFields(cwd);
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
      // pln#636 C0-b — capture the baseline while we know it. Absent when the
      // project is not a git repo; downstream treats that as unverifiable.
      ...baseline,
      ...(input.paths?.length ? { paths: input.paths } : {}),
    };

    saveClaimUnlocked(claim, cwd);
    return { acquired: true, claim };
  });
}

export function loadClaim(id: string, cwd?: string): Claim {
  return loadClaimFromAnyDir(id, cwd);
}

export function listClaims(cwd?: string): Claim[] {
  const byId = new Map<string, Claim>();
  for (const dirPath of claimDirs(cwd)) {
    for (const claim of claimStoreForDir(dirPath).list()) {
      if (!byId.has(claim.id)) byId.set(claim.id, claim);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Caller identity for release ownership checks (pln#562 step 5).
 * Acquisition and adoption are guarded; release must be too — otherwise any
 * process can release another instance's claim and break hard_after gating.
 *
 * When omitted (legacy internal callers: stale sweeps, reconciler, session
 * end on own claims), no check is applied. When provided, the caller must
 * match the claim's session/agent identity, or carry `override` (coordinator
 * privilege) — which is audited.
 */
export interface ReleaseClaimAuth {
  agent?: string;
  agent_id?: string;
  session_id?: string;
  /** Coordinator override: allowed to release another principal's claim. Audited. */
  override?: boolean;
}

function assertReleaseOwnership(claim: Claim, auth: ReleaseClaimAuth | undefined): { overrideUsed: boolean } {
  if (!auth) return { overrideUsed: false };
  const ownerMatches =
    (auth.session_id !== undefined && claim.session_id !== undefined && auth.session_id === claim.session_id)
    || (auth.agent_id !== undefined && claim.agent_id !== undefined && auth.agent_id === claim.agent_id)
    || (auth.agent !== undefined && claim.agent === auth.agent);
  if (ownerMatches) return { overrideUsed: false };
  if (auth.override) return { overrideUsed: true };
  // pln#607 rule + trp#928 — the error must be executable as-is: the caller
  // should be able to copy the coordinator_override:true param straight from the
  // message into their next bclaw_release_claim call. "Coordinator-level callers
  // may release with override" was diagnostically useless before — no param name,
  // no path forward. Ghost claim clm_ed9b8386 stayed active for weeks because
  // this error was raised, swallowed by a best-effort catch, and never surfaced.
  throw new Error(
    `claim '${claim.id}' is held by '${claim.agent}'${claim.session_id ? ` (session ${claim.session_id})` : ''}; `
    + `caller '${auth.agent ?? auth.agent_id ?? auth.session_id ?? 'unknown'}' does not own it. `
    + `Retry with coordinator_override:true (requires trusted+ trust level; the release is audited).`,
  );
}

function auditReleaseOverride(claim: Claim, auth: ReleaseClaimAuth, cwd?: string): void {
  appendAuditEntry(
    {
      actor: auth.agent ?? 'coordinator',
      actor_id: auth.agent_id,
      action: 'release_claim',
      item_id: claim.id,
      item_type: 'claim',
      scope: claim.scope,
      session_id: auth.session_id,
      after: { ownership_override: true, claim_owner: claim.agent },
    },
    cwd,
  );
}

export function releaseClaim(id: string, cwd?: string, auth?: ReleaseClaimAuth): Claim {
  let overrideUsed = false;
  const released = mutate({ cwd }, () => {
    const claim = loadClaim(id, cwd);
    overrideUsed = assertReleaseOwnership(claim, auth).overrideUsed;
    claim.status = 'released';
    claim.released_at = nowISO();
    saveClaimUnlocked(claim, cwd);
    return claim;
  });
  if (overrideUsed && auth) {
    auditReleaseOverride(released, auth, cwd);
  }
  return released;
}

/**
 * Release a claim ONLY if it is still `active`, reporting whether THIS call
 * performed the active→released transition.
 *
 * pln#641 review round-2 P1: `releaseClaim` sets `released` unconditionally —
 * an already-released claim is silently re-released — so any caller that
 * check-then-releases to decide whether to AUDIT the transition lies under a
 * concurrent external release (the check passes, the write "succeeds", the
 * caller emits an event for a transition it never performed). Here the status
 * check runs INSIDE the same store mutation that writes the release, so the
 * answer is exact: `released: true` means this call, and no one else, moved
 * the claim out of `active`.
 */
export function releaseClaimIfActive(
  id: string,
  cwd?: string,
  auth?: ReleaseClaimAuth,
): { released: boolean; claim: Claim | undefined } {
  let overrideUsed = false;
  let transitioned = false;
  const result = mutate({ cwd }, () => {
    const claim = loadClaim(id, cwd);
    if (!claim || claim.status !== 'active') return claim;
    overrideUsed = assertReleaseOwnership(claim, auth).overrideUsed;
    claim.status = 'released';
    claim.released_at = nowISO();
    saveClaimUnlocked(claim, cwd);
    transitioned = true;
    return claim;
  });
  if (transitioned && overrideUsed && auth && result) {
    auditReleaseOverride(result, auth, cwd);
  }
  return { released: transitioned, claim: result };
}

/**
 * Mark an active claim as `stale` — a distinct terminal state from `released`
 * used when a claim is being torn down because its owner is gone (session
 * expired, worker died, coordinator abandoned the lane). Same ownership rules
 * as releaseClaim (trusted+ coordinators may override with audit).
 *
 * trp#928 — the `active → stale` transition documented on the entity registry
 * had no imperative path before; callers had to fall back to mass sweeps
 * (`expireStaleActiveClaims`) or write status directly. Now bclaw_transition
 * (entity=claim, to='stale') reaches this function via entity-operations.
 */
export function markClaimStale(id: string, cwd?: string, auth?: ReleaseClaimAuth): Claim {
  let overrideUsed = false;
  const staled = mutate({ cwd }, () => {
    const claim = loadClaim(id, cwd);
    overrideUsed = assertReleaseOwnership(claim, auth).overrideUsed;
    claim.status = 'stale';
    claim.released_at = nowISO();
    saveClaimUnlocked(claim, cwd);
    return claim;
  });
  appendAuditEntry(
    {
      actor: staled.agent,
      actor_id: staled.agent_id,
      action: 'release_claim',
      item_id: staled.id,
      item_type: 'claim',
      scope: staled.scope,
      session_id: staled.session_id,
      host_id: staled.host_id,
      after: { status: 'stale' },
    },
    cwd,
  );
  if (overrideUsed && auth) {
    auditReleaseOverride(staled, auth, cwd);
  }
  return staled;
}

export interface ReleaseClaimCascadeOptions {
  planStatus?: string;
  cwd?: string;
  /** Caller identity for the release ownership check (pln#562 step 5). */
  auth?: ReleaseClaimAuth;
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
  const { planStatus, cwd, auth } = options;
  let overrideUsed = false;

  const result = mutate({ cwd }, () => {
    // Release the claim (idempotent: already-released claims are returned as-is)
    const claim = loadClaim(id, cwd);
    if (claim.status === 'released') {
      return { claim, planTransitioned: false } as ReleaseClaimCascadeResult;
    }
    overrideUsed = assertReleaseOwnership(claim, auth).overrideUsed;
    claim.status = 'released';
    claim.released_at = nowISO();
    saveClaimUnlocked(claim, cwd);

    // No cascade requested or no linked plan
    if (!planStatus || !claim.plan_id) {
      return { claim, planTransitioned: false } as ReleaseClaimCascadeResult;
    }

    const state = loadState(cwd);
    const plan = state.plan_items.find((item) => item.id === claim.plan_id);
    if (!plan) {
      return { claim, planTransitioned: false } as ReleaseClaimCascadeResult;
    }

    const ts = nowISO();

    if (planStatus === 'blocked') {
      // Always propagate blocked status to plan
      plan.status = 'blocked' as PlanStatus;
      plan.updated_at = ts;
      persistState(state, cwd);
      return { claim, planTransitioned: true, planId: plan.id, newPlanStatus: 'blocked' } as ReleaseClaimCascadeResult;
    }

    if (planStatus === 'done') {
      // Count OTHER active claims on the same plan (current claim already released above)
      const otherActive = listClaims(cwd).filter(
        (c) => c.status === 'active' && c.plan_id === claim.plan_id && c.id !== id,
      );

      if (otherActive.length > 0) {
        const planWarning = `Plan has ${otherActive.length} other active claim(s); staying in_progress`;
        return {
          claim,
          planTransitioned: false,
          planWarning,
          planId: plan.id,
          newPlanStatus: plan.status,
          otherActiveClaimsCount: otherActive.length,
        } as ReleaseClaimCascadeResult;
      }

      // Last active claim released → auto-transition plan to done
      plan.status = 'done' as PlanStatus;
      if (!plan.completed_at) plan.completed_at = ts;
      plan.updated_at = ts;
      persistState(state, cwd);

      return { claim, planTransitioned: true, planId: plan.id, newPlanStatus: 'done' } as ReleaseClaimCascadeResult;
    }

    // planStatus='todo', 'in_progress', or other — no cascade
    return { claim, planTransitioned: false } as ReleaseClaimCascadeResult;
  });

  appendAuditEntry(
    {
      actor: result.claim.agent,
      actor_id: result.claim.agent_id,
      action: 'release_claim',
      item_id: id,
      item_type: 'claim',
      scope: result.claim.scope,
      session_id: result.claim.session_id,
      host_id: result.claim.host_id,
    },
    cwd,
  );

  if (overrideUsed && auth) {
    auditReleaseOverride(result.claim, auth, cwd);
  }

  if (result.planWarning && result.planId) {
    appendAuditEntry(
      {
        actor: result.claim.agent,
        action: 'update',
        item_id: result.planId,
        item_type: 'plan',
        after: { cascade_blocked: true, reason: result.planWarning },
      },
      cwd,
    );
  }

  if (result.newPlanStatus === 'done' && result.planId) {
    createRuntimeEvent(
      {
        agent: result.claim.agent,
        agent_id: result.claim.agent_id,
        event_type: 'plan_cascade_to_done',
        claim_id: id,
        plan_id: result.planId,
        session_id: result.claim.session_id,
        host_id: result.claim.host_id,
        text: `Plan ${result.planId} auto-transitioned to done — last active claim released by ${result.claim.agent}`,
      },
      cwd,
    );
  }

  return result;
}

export function generateClaimId(): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `clm_${rand}`;
}

export function isClaimExpired(claim: Claim): boolean {
  if (!claim.expires_at) return false;
  return new Date(claim.expires_at) < new Date();
}

/**
 * Per-claim outcome of a cascade release attempt. trp#928 — the previous silent
 * cascade produced no evidence when a claim failed to release (clm_ed9b8386
 * remained active for weeks after the plan closed). Return one entry per claim
 * so the caller can log/report which released and which skipped and why.
 */
export interface CascadeReleaseEntry {
  claim_id: string;
  released: boolean;
  /** 'released' | 'already_terminal' | 'ownership_denied' | 'not_found' | 'error' */
  reason: string;
  /** Present when reason='error' — the error's Error.message. */
  error?: string;
  /** Present when a claim's release used the coordinator override. */
  override_used?: boolean;
}

export interface CascadeReleaseResult {
  entries: CascadeReleaseEntry[];
  released_count: number;
  skipped_count: number;
  error_count: number;
}

/**
 * Release every ACTIVE claim linked to a given target (plan / assignment / loop
 * slot claim). trp#928 — the cascade must LOG per-claim (released or
 * skipped+reason) so a silent ownership failure is observable at the harvest /
 * loop-close boundary. Ownership follows the same ReleaseClaimAuth contract as
 * releaseClaim: a system caller (auth undefined) bypasses the check; a caller
 * with auth honors ownership + coordinator_override.
 */
export function releaseClaimsCascade(
  claimIds: readonly string[],
  options: {
    cwd?: string;
    auth?: ReleaseClaimAuth;
    /** Passed through to releaseClaimWithCascade for the last-claim rule when relevant. */
    planStatus?: string;
  } = {},
): CascadeReleaseResult {
  const entries: CascadeReleaseEntry[] = [];
  // Deduplicate — callers may pass the same claim id via both an assignment and
  // a slot; a duplicate would double-audit.
  const seen = new Set<string>();
  for (const id of claimIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let claim: Claim | undefined;
    try {
      claim = loadClaim(id, options.cwd);
    } catch {
      entries.push({ claim_id: id, released: false, reason: 'not_found' });
      continue;
    }
    if (claim.status !== 'active') {
      entries.push({ claim_id: id, released: false, reason: 'already_terminal' });
      continue;
    }
    try {
      const rel = releaseClaimWithCascade(id, {
        planStatus: options.planStatus,
        cwd: options.cwd,
        auth: options.auth,
      });
      const overrideUsed = options.auth?.override === true
        && !ownerMatches(claim, options.auth);
      entries.push({
        claim_id: id,
        released: rel.claim.status === 'released',
        reason: rel.claim.status === 'released' ? 'released' : 'error',
        ...(overrideUsed ? { override_used: true } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The specific ownership-check error thrown by assertReleaseOwnership
      // gets its own reason bucket so a caller can surface an executable hint
      // (retry with coordinator_override:true) instead of a generic error.
      const reason = /coordinator_override/i.test(message) ? 'ownership_denied' : 'error';
      entries.push({ claim_id: id, released: false, reason, error: message });
    }
  }
  const released_count = entries.filter((e) => e.released).length;
  const error_count = entries.filter((e) => e.reason === 'error' || e.reason === 'ownership_denied').length;
  return {
    entries,
    released_count,
    skipped_count: entries.length - released_count - error_count,
    error_count,
  };
}

/**
 * Extract of assertReleaseOwnership's owner check without the throw. Used by
 * releaseClaimsCascade to know whether a successful release used the override
 * path (so it can be reported in the per-claim log).
 */
function ownerMatches(claim: Claim, auth: ReleaseClaimAuth): boolean {
  return (
    (auth.session_id !== undefined && claim.session_id !== undefined && auth.session_id === claim.session_id)
    || (auth.agent_id !== undefined && claim.agent_id !== undefined && auth.agent_id === claim.agent_id)
    || (auth.agent !== undefined && claim.agent === auth.agent)
  );
}

/**
 * Find every active claim linked to a plan (via plan_id). Used by
 * bclaw_transition(entity='plan', to='done') to implement the
 * `release_linked_claims_if_last` cascade tag advertised on the entity
 * registry (before trp#928 the tag was documentation only; the imperative
 * cascade never ran).
 */
export function findActiveClaimsForPlan(planId: string, cwd?: string): Claim[] {
  return listClaims(cwd).filter((c) => c.plan_id === planId && c.status === 'active');
}

/**
 * Emit a runtime event summarising a cascade release outcome, one entry per
 * claim in the metadata. trp#928 — every cascade caller (plan-done,
 * loop close, assignment→completed, harvest --integrate) MUST log per-claim
 * status so silent failures are observable via bclaw_find(entity='agent_run')
 * / bclaw_find(entity='claim'). Best-effort: never breaks the parent flow.
 */
export function logCascadeReleaseResult(input: {
  actor: string;
  trigger: 'plan_done' | 'loop_close' | 'assignment_completed' | 'harvest_integrate';
  plan_id?: string;
  loop_id?: string;
  assignment_id?: string;
  claim_id?: string;
  cascade: CascadeReleaseResult;
  cwd?: string;
}): void {
  const { released_count, skipped_count, error_count, entries } = input.cascade;
  if (entries.length === 0) return;
  const text = `cascade[${input.trigger}]: released=${released_count} skipped=${skipped_count} errors=${error_count}`
    + ` — ${entries.map((e) => `${e.claim_id}:${e.reason}`).join(', ')}`;
  try {
    createRuntimeEvent({
      agent: input.actor,
      event_type: 'assignment_progress',
      text,
      tags: ['cascade', 'claim-release', input.trigger, ...(error_count > 0 ? ['ownership-issue'] : [])],
      plan_id: input.plan_id,
      assignment_id: input.assignment_id,
      claim_id: input.claim_id,
      metadata: {
        trigger: input.trigger,
        released_count,
        skipped_count,
        error_count,
        entries,
        ...(input.loop_id ? { loop_id: input.loop_id } : {}),
      },
    }, input.cwd);
  } catch { /* best-effort logging — never break the parent flow */ }
}

/** Mark active claims past their expires_at as released. Returns count of expired claims. */
export function expireStaleActiveClaims(cwd?: string): number {
  return mutate({ cwd }, () => {
    const all = listClaims(cwd);
    let count = 0;
    const now = nowISO();
    for (const claim of all) {
      if (claim.status === 'active' && isClaimExpired(claim)) {
        claim.status = 'released';
        claim.released_at = now;
        saveClaimUnlocked(claim, cwd, { refreshCompanions: false });
        count++;
      }
    }
    if (count > 0) {
      try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
    }
    return count;
  });
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
  /**
   * pln#636 — age of the freshest FILE evidence (heartbeat sentinel or worktree
   * / log filesystem activity) when that is what proved the claim alive.
   */
  evidenceAgeMs?: number;
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
  /**
   * pln#636 — how fresh file evidence must be to prove life. Defaults to the
   * same window an assignment gets: `heartbeat_ttl_ms` (schema.ts) defaults to
   * 30 min, so by default a claim and its assignment cannot disagree about
   * whether the same worker is alive. Pass this explicitly when a caller knows
   * the assignment's TTL was overridden by policy.
   */
  evidenceTtlMs?: number;
}

/** Default freshness window for file evidence — matches the default `heartbeat_ttl_ms`. */
const DEFAULT_EVIDENCE_TTL_MS = 30 * 60_000;

/**
 * How far into the future a file timestamp may sit before we stop trusting it.
 *
 * WHY THIS TOLERANCE EXISTS, and why the naive `age < 0 → ignore` was wrong.
 * `fs.stat().mtimeMs` is sub-millisecond on NTFS while `Date.now()` is coarser,
 * so a heartbeat written microseconds ago routinely stats as *newer than now* —
 * i.e. the freshest evidence possible was the evidence most likely to be thrown
 * away. That reproduced as a nondeterministic liveness verdict: the same claim
 * read `live` on an idle machine and `never-adopted` under load.
 *
 * A file dated slightly ahead is therefore clamped to age 0 (maximally fresh),
 * while one dated grossly ahead is discarded — that is a genuinely wrong clock or
 * a hand-forged timestamp, and inventing liveness from it would let a dead
 * worker hold a claim forever.
 */
const FUTURE_EVIDENCE_TOLERANCE_MS = 5 * 60_000;

/**
 * pln#636 — age of the freshest FILE evidence that this claim's worker is alive.
 *
 * WHY FILE EVIDENCE AND NOT A SESSION. A sandboxed spawned worker cannot reach
 * MCP, so it cannot maintain any server-side liveness record — which is exactly
 * why the project moved proof-of-life to filesystem sentinels: the dispatcher
 * injects a "Liveness — DO THIS FIRST" step into every brief, and the worker
 * writes/refreshes a heartbeat in the ONE location a sandbox can write (its own
 * worktree). `assignment-sweeper` already honours that evidence; claims did not,
 * which meant a demonstrably-alive sandboxed worker kept its assignment but had
 * its CLAIM aged out on wall-clock alone (trp_4d0fc2ef). This closes that
 * asymmetry by reading the same signals.
 *
 * Deliberately reads the leaf `runtime-signals` module rather than
 * `collectEvidence`: agentrun-reconciler imports `loadClaim` from here, so
 * importing it back would create a cycle.
 *
 * Returns undefined when there is nothing to read — no assignment, no signals —
 * and never throws.
 */
function freshestEvidenceAgeMs(claim: Claim, nowMs: number, cwd?: string): number | undefined {
  if (!claim.assignment_id) return undefined;
  const root = cwd ?? process.cwd();
  let freshest: number | undefined;
  const consider = (ms: number | undefined): void => {
    if (ms === undefined) return;
    const age = nowMs - ms;
    // Slightly-future timestamps are a clock-granularity artefact, not skew —
    // clamp them to "just now". Grossly-future ones are untrustworthy: ignore
    // rather than invent liveness. See FUTURE_EVIDENCE_TOLERANCE_MS.
    if (age < -FUTURE_EVIDENCE_TOLERANCE_MS) return;
    const normalised = age < 0 ? 0 : age;
    if (freshest === undefined || normalised < freshest) freshest = normalised;
  };
  try {
    const hb = readHeartbeat(root, claim.assignment_id, claim.worktree_path);
    if (hb.exists) consider(hb.mtimeMs);
  } catch { /* evidence is best-effort */ }
  try {
    consider(latestActivityMs(root, claim.assignment_id, claim.worktree_path));
  } catch { /* evidence is best-effort */ }
  return freshest;
}

/**
 * Assess the liveness of an active claim.
 *
 * Decision tree:
 *  0. Young (< 30 min) → never auto-release — dispatcher may not have sent the worker yet.
 *  1. FRESH FILE EVIDENCE → 'live', whatever the session says. This branch comes
 *     first because it is the only proof a sandboxed, MCP-less worker can
 *     produce, and it is the same evidence the assignment sweeper trusts.
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

  // 1. FILE EVIDENCE FIRST (pln#636, trp_4d0fc2ef). A sandboxed worker proves
  //    life by writing a heartbeat into its worktree — the only place it can
  //    write — and by touching files there. That evidence outranks any session
  //    reasoning: a worker actively committing is alive whether or not a session
  //    record exists, and a coordinator-created claim has no session_id at all.
  const evidenceAgeMs = freshestEvidenceAgeMs(claim, nowMs, options.cwd);
  const evidenceTtlMs = options.evidenceTtlMs ?? DEFAULT_EVIDENCE_TTL_MS;
  if (evidenceAgeMs !== undefined && evidenceAgeMs < evidenceTtlMs) {
    return {
      status: 'live',
      reason: `File evidence is fresh (${Math.round(evidenceAgeMs / 60_000)}min ago) — the worker is demonstrably active`,
      ageMs,
      evidenceAgeMs,
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
  return mutate({ cwd }, () => {
    const all = listClaims(cwd);
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
      saveClaimUnlocked(claim, cwd, { refreshCompanions: false });
      released.push(claim);
    }

    if (released.length > 0) {
      try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
    }
    return { released, warned };
  });
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
  // Set when the reuse candidate turns out to be RELEASED under the store lock
  // (review PR#167 P1): the scope is genuinely free, so control falls through
  // to the fresh-claim path instead of handing the dispatcher a dead claim.
  let reuseCandidateGone = false;
  if (existingScopeClaim) {
    if (existingScopeClaim.agent === options.agent) {
      // Same agent already has this scope — reuse the claim (backward compat,
      // same-agent multi-call). If the caller pinned a base ref, the reused
      // worktree MUST be re-pointed to it; otherwise a dispatch that relied on
      // the ref (e.g. the dirty-guard bypass) would run the worker on a stale
      // worktree — the same silent false-negative the guard exists to prevent
      // (pln#520 Tier 2 / codex r2).
      let reuseWarning: string | undefined;
      let reusedWorktreePath = existingScopeClaim.worktree_path;
      if (reusedWorktreePath) {
        if (options.worktreeBaseRef) {
          const reset = resetWorktreeToRef(reusedWorktreePath, options.worktreeBaseRef);
          if (!reset.ok) {
            reuseWarning = `Reused claim ${existingScopeClaim.id} pinned to ref "${options.worktreeBaseRef}": ${reset.stderr.trim()}`;
          }
        }
      } else {
        // trp_72b4e9b3(2) — a claim persisted after a failed worktree creation
        // (e.g. the path collision this trap documents) used to WEDGE the scope:
        // every later dispatch reused this worktree-less claim and the spawn
        // refused ("Reused claim has no worktree to pin"). Heal it here:
        // provision the worktree the claim should have had (createWorktree now
        // ADOPTS an existing same-branch worktree, so the original collision
        // cause resolves too) and patch the claim. On failure the old warning
        // stands — visible, and the next call retries.
        try {
          reusedWorktreePath = createWorktree(options.cwd, `feat/${sanitizeBranchComponent(options.scope)}`, {
            sessionId: options.sessionId,
            agent: options.agent,
            baseRef: options.worktreeBaseRef,
            resetExistingBranch: options.resetExistingWorktreeBranch || Boolean(options.worktreeBaseRef),
          });
          const healedPath = reusedWorktreePath;
          // Review PR#167 P1 — the patch REVALIDATES under the store lock.
          // Provisioning takes seconds; if a release wins that window, the
          // reused claim id must NEVER reach the dispatcher (it would spawn an
          // assignment bound to a RELEASED claim). 'gone' falls through to the
          // fresh-claim path below — the scope is genuinely free now, and the
          // just-provisioned worktree is re-found by createWorktree's adoption.
          const healed = mutate({ cwd: options.cwd }, (): 'patched' | 'already' | 'gone' => {
            const fresh = loadClaim(existingScopeClaim.id, options.cwd);
            if (!fresh || fresh.status !== 'active') return 'gone';
            if (!fresh.worktree_path) {
              fresh.worktree_path = healedPath;
              saveClaimUnlocked(fresh, options.cwd);
            }
            return fresh.worktree_path === healedPath ? 'patched' : 'already';
          });
          if (healed === 'gone') reuseCandidateGone = true;
        } catch (err) {
          reuseWarning = `Reused claim ${existingScopeClaim.id} has no worktree, and provisioning one failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (!reuseCandidateGone) {
        return {
          claimId: existingScopeClaim.id,
          worktreePath: reusedWorktreePath,
          worktreeWarning: reuseWarning,
          reusedExisting: true,
        };
      }
    } else {
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
  }

  const claimId = generateClaimId();
  // Resolved OUTSIDE the lock below, for the same reason acquireClaimScope does
  // it: a subprocess spawn inside the mutate callback would widen the critical
  // section that serializes writes on the claims store.
  const baseline = claimBaselineFields(options.cwd);
  let worktreePath: string | undefined;
  let worktreeWarning: string | undefined;

  // Create isolated worktree (matching bclaw_claim MCP handler behavior).
  // can_45316d5c: the slug must be a valid git ref component — scopes like
  // `.github/workflows` previously produced `feat/.github-…` (leading dot),
  // which git rejects and the whole spawn failed.
  const branchSlug = sanitizeBranchComponent(options.scope);
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

  const result = mutate({ cwd: options.cwd }, () => {
    const racedScopeClaim = listClaims(options.cwd).find(
      (claim) => claim.status === 'active' && claim.scope === options.scope,
    );
    if (racedScopeClaim) {
      if (racedScopeClaim.agent === options.agent) {
        return {
          claimId: racedScopeClaim.id,
          worktreePath: racedScopeClaim.worktree_path,
          worktreeWarning,
          reusedExisting: true,
        } as CoordinatorClaimResult;
      }
      return {
        claimId: racedScopeClaim.id,
        worktreePath: racedScopeClaim.worktree_path,
        reusedExisting: true,
        scopeConflict: true,
        conflictAgent: racedScopeClaim.agent,
      } as CoordinatorClaimResult;
    }

    saveClaimUnlocked({
      id: claimId,
      agent: options.agent,
      scope: options.scope,
      description: options.description,
      plan_id: options.planId,
      created_at: nowISO(),
      status: 'active',
      worktree_path: worktreePath,
      ...baseline, // pln#636 C0-b / trp#1292 — dispatched lanes need it most
    }, options.cwd);

    return { claimId, worktreePath, worktreeWarning, reusedExisting: false } as CoordinatorClaimResult;
  });

  // Review follow-up O1 (lop_e2d566765b8b4ce3): when the in-lock re-check finds
  // a raced claim, the worktree created moments earlier (outside the lock) is
  // orphaned — nobody would ever remove it. Decision: delete it (it is seconds
  // old and contains only birth artifacts; a reuse-pool is not worth the
  // bookkeeping). Best-effort and outside the critical section.
  if (result.reusedExisting && worktreePath && worktreePath !== result.worktreePath) {
    try {
      removeWorktree(options.cwd, worktreePath, { force: true });
    } catch { /* best-effort GC — a leftover dir is caught by worktree clean */ }
  }

  if (!result.reusedExisting && !result.scopeConflict) {
    appendAuditEntry({
      actor: options.dispatcherAgent,
      action: 'claim',
      item_id: result.claimId,
      item_type: 'claim',
      scope: options.scope,
    }, options.cwd);
  }

  return result;
}

// ── Claim lifecycle helpers for multi-instance dispatch ────

/**
 * Attach the assignment message ID to a claim (for tracing claim→message→instance).
 * Called by the dispatcher after sending the inbox message.
 */
export function attachAssignmentMessageToClaim(claimId: string, messageId: string, cwd?: string): void {
  mutate({ cwd }, () => {
    const claim = loadClaim(claimId, cwd);
    claim.assignment_message_id = messageId;
    saveClaimUnlocked(claim, cwd);
  });
}

/**
 * sprint 1.5 — patch a claim's worktree_path so a coordinator can register a
 * manually created worktree (or correct a stale path) without hand-editing the
 * store. Surfaced through bclaw_update(entity="claim", patch={worktree_path}).
 */
export function patchClaimWorktreePath(claimId: string, worktreePath: string | undefined, cwd?: string): Claim {
  return mutate({ cwd }, () => {
    const claim = loadClaim(claimId, cwd);
    claim.worktree_path = worktreePath;
    saveClaimUnlocked(claim, cwd);
    return claim;
  });
}

/** Link a claim to its Assignment entity (Agent SDK runtime protocol). */
export function linkClaimToAssignment(claimId: string, assignmentId: string, cwd?: string): void {
  mutate({ cwd }, () => {
    const claim = loadClaim(claimId, cwd);
    claim.assignment_id = assignmentId;
    saveClaimUnlocked(claim, cwd);
  });
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
    saveClaimUnlocked(claim, cwd);
    return { adopted: true, reason: 'ok' };
  });
}
