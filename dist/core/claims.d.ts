import { type Claim } from './schema.js';
export declare function ensureClaimsDir(cwd?: string): void;
export declare function saveClaim(claim: Claim, cwd?: string): void;
export declare function loadClaim(id: string, cwd?: string): Claim;
export declare function listClaims(cwd?: string): Claim[];
export declare function releaseClaim(id: string, cwd?: string): Claim;
export declare function generateClaimId(): string;
export declare function isClaimExpired(claim: Claim): boolean;
/** Mark active claims past their expires_at as released. Returns count of expired claims. */
export declare function expireStaleActiveClaims(cwd?: string): number;
//# sourceMappingURL=claims.d.ts.map