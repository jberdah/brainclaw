import type { AgentKind, AgentTrustLevel } from '../core/schema.js';
export interface RegisterAgentOptions {
    kind?: AgentKind;
    capability?: string[];
    replaceCapabilities?: boolean;
    generateFingerprint?: boolean;
    setCurrent?: boolean;
    curator?: boolean;
    trustLevel?: AgentTrustLevel;
    json?: boolean;
}
export declare function runRegisterAgent(agentName: string, options?: RegisterAgentOptions): void;
//# sourceMappingURL=register-agent.d.ts.map