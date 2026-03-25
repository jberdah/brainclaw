import type { AgentKind } from '../core/schema.js';
export interface EnableAgentOptions {
    kind?: AgentKind;
    capability?: string[];
    replaceCapabilities?: boolean;
    generateFingerprint?: boolean;
    setCurrent?: boolean;
    json?: boolean;
    cwd?: string;
}
export declare function runEnableAgent(agentName: string, options?: EnableAgentOptions): void;
//# sourceMappingURL=enable-agent.d.ts.map