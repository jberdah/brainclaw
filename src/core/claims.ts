import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaimSchema, type Claim } from './schema.js';
import { memoryDir, writeFileAtomic, readFileSync } from './io.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';

const CLAIMS_DIR = 'claims';

function claimsDir(cwd?: string): string {
  return path.join(memoryDir(cwd), CLAIMS_DIR);
}

export function ensureClaimsDir(cwd?: string): void {
  const dir = claimsDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function saveClaim(claim: Claim, cwd?: string): void {
  ensureClaimsDir(cwd);
  const filepath = path.join(claimsDir(cwd), `${claim.id}.json`);
  writeFileAtomic(filepath, JSON.stringify(claim, null, 2) + '\n');
}

export function loadClaim(id: string, cwd?: string): Claim {
  const filepath = path.join(claimsDir(cwd), `${id}.json`);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Claim '${id}' not found`);
  }
  return ClaimSchema.parse(JSON.parse(readFileSync(filepath)));
}

export function listClaims(cwd?: string): Claim[] {
  const dir = claimsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const claims: Claim[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(path.join(dir, file));
      claims.push(ClaimSchema.parse(JSON.parse(raw)));
    } catch (err) {
      logger.debug('Skipping malformed claim file:', file, err);
    }
  }
  return claims.sort((a, b) => a.created_at.localeCompare(b.created_at));
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
