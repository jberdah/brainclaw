import { memoryExists } from '../core/io.js';
import { listClaims, expireStaleActiveClaims, isClaimExpired, assessClaimLiveness } from '../core/claims.js';
import { resolveStoreChain } from '../core/store-resolution.js';
import type { Claim } from '../core/schema.js';

export interface ListClaimsOptions {
  json?: boolean;
  all?: boolean;
  project?: string;
  plan?: string;
  agent?: string;
  cwd?: string;
  /** Read from local store only, skipping parent stores in the chain. Default: false (chain mode). */
  localOnly?: boolean;
}

export function runListClaims(options: ListClaimsOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = options.cwd ?? process.cwd();

  // Auto-expire claims whose TTL has passed before listing (local store only — writes are always local)
  expireStaleActiveClaims(options.cwd);

  let claims: Claim[];
  if (options.localOnly) {
    claims = listClaims(options.cwd);
  } else {
    const chain = resolveStoreChain(effectiveCwd);
    const seenIds = new Set<string>();
    claims = [];
    for (const store of chain) {
      try {
        // Expire stale claims in each parent store too
        expireStaleActiveClaims(store.cwd);
        for (const claim of listClaims(store.cwd)) {
          if (!seenIds.has(claim.id)) {
            seenIds.add(claim.id);
            claims.push(claim);
          }
        }
      } catch { /* skip unreadable stores */ }
    }
    // Fallback when no chain found
    if (claims.length === 0 && chain.length === 0) {
      claims = listClaims(options.cwd);
    }
  }
  if (!options.all) {
    claims = claims.filter(c => c.status === 'active');
  }
  if (options.project) {
    claims = claims.filter(c => c.project === options.project);
  }
  if (options.plan) {
    claims = claims.filter(c => c.plan_id === options.plan);
  }
  if (options.agent) {
    claims = claims.filter(c => c.agent === options.agent);
  }

  if (options.json) {
    console.log(JSON.stringify(claims, null, 2));
    return;
  }

  if (claims.length === 0) {
    console.log('No active claims.');
    return;
  }

  const label = options.all ? 'claim(s)' : 'active claim(s)';
  console.log(`${claims.length} ${label}:`);
  console.log('');
  for (const c of claims) {
    const expired = isClaimExpired(c) ? ' [EXPIRED]' : '';
    const status = c.status !== 'active' ? ` (${c.status})` : '';
    const extras: string[] = [];
    if (c.session_id) extras.push(`session ${c.session_id.slice(-8)}`);
    if (c.plan_id) extras.push(`plan ${c.plan_id}`);
    if (c.project) extras.push(`project ${c.project}`);
    if (c.expires_at && !isClaimExpired(c)) extras.push(`expires ${c.expires_at.slice(0, 16).replace('T', ' ')}`);
    const suffix = extras.length ? ` [${extras.join(', ')}]` : '';
    // Liveness tag for active claims (omit for released/done)
    let livenessTag = '';
    if (c.status === 'active') {
      const liveness = assessClaimLiveness(c, { cwd: options.cwd });
      if (liveness.status === 'live') livenessTag = ' [LIVE]';
      else if (liveness.status === 'orphaned') livenessTag = ' [ORPHANED]';
      else if (liveness.status === 'never-adopted') livenessTag = ' [NEVER-ADOPTED]';
      else if (liveness.status === 'stale') livenessTag = ' [STALE]';
    }
    console.log(`  [${c.id}] ${c.agent} → ${c.scope}: ${c.description}${suffix}${livenessTag}${status}${expired}`);
  }
}
