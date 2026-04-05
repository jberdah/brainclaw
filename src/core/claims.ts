import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaimSchema, type Claim } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO } from './ids.js';
import { JsonStore } from './json-store.js';
import { loadConfig } from './config.js';

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
