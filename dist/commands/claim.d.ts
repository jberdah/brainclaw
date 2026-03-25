import { type StoreTarget } from '../core/store-resolution.js';
export interface ClaimOptions {
    agent?: string;
    agentId?: string;
    scope: string;
    project?: string;
    plan?: string;
    ttl?: string;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runClaim(description: string, options: ClaimOptions): void;
//# sourceMappingURL=claim.d.ts.map