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
}

/**
 * Create a coordinator-owned claim with worktree isolation.
 * Encapsulates: generateClaimId + createWorktree + saveClaim + audit.
 * Used by both bclaw_dispatch and bclaw_coordinate assign/reroute.
 */
export function createCoordinatorClaim(options: CoordinatorClaimOptions): CoordinatorClaimResult {
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

  return { claimId, worktreePath, worktreeWarning };
}
