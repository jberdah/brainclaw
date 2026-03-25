import crypto from 'node:crypto';
import fs from 'node:fs';
import { ClaimSchema } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO } from './ids.js';
import { JsonStore } from './json-store.js';
function claimsDir(cwd, mode = 'read') {
    return resolveEntityDir('claims', cwd ?? process.cwd(), mode);
}
export function ensureClaimsDir(cwd) {
    const dir = claimsDir(cwd, 'write');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function claimStore(cwd) {
    return new JsonStore({
        dirPath: claimsDir(cwd, 'read'),
        documentType: 'claim',
        getId: (claim) => claim.id,
        sort: (a, b) => a.created_at.localeCompare(b.created_at),
    });
}
export function saveClaim(claim, cwd) {
    mutate({ cwd }, () => {
        ensureClaimsDir(cwd);
        const writeStore = new JsonStore({
            dirPath: claimsDir(cwd, 'write'),
            documentType: 'claim',
            getId: (c) => c.id,
            sort: (a, b) => a.created_at.localeCompare(b.created_at),
        });
        writeStore.save(ClaimSchema.parse(claim));
    });
}
export function loadClaim(id, cwd) {
    return claimStore(cwd).load(id);
}
export function listClaims(cwd) {
    return claimStore(cwd).list();
}
export function releaseClaim(id, cwd) {
    const claim = loadClaim(id, cwd);
    claim.status = 'released';
    claim.released_at = nowISO();
    saveClaim(claim, cwd);
    return claim;
}
export function generateClaimId() {
    const rand = crypto.randomBytes(4).toString('hex');
    return `clm_${rand}`;
}
export function isClaimExpired(claim) {
    if (!claim.expires_at)
        return false;
    return new Date(claim.expires_at) < new Date();
}
/** Mark active claims past their expires_at as released. Returns count of expired claims. */
export function expireStaleActiveClaims(cwd) {
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
//# sourceMappingURL=claims.js.map