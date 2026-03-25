import type { AgentTrustLevel } from '../core/schema.js';
export interface SetTrustOptions {
    level?: AgentTrustLevel;
    resetBreaker?: boolean;
    json?: boolean;
    cwd?: string;
}
export declare function runSetTrust(agentName: string, options: SetTrustOptions): void;
//# sourceMappingURL=set-trust.d.ts.map