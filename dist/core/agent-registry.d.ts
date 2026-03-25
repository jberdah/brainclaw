import { type AgentIdentityDocument, type AgentKind, type AgentTrustLevel } from './schema.js';
export declare class AgentIdentityResolutionError extends Error {
    readonly kind = "identity_error";
    readonly details?: Record<string, unknown>;
    constructor(message: string, details?: Record<string, unknown>);
}
export declare class AgentTrustError extends Error {
    readonly kind = "trust_error";
    readonly details?: Record<string, unknown>;
    constructor(message: string, details?: Record<string, unknown>);
}
export interface RegisterAgentIdentityInput {
    agentName: string;
    kind?: AgentKind;
    trustLevel?: AgentTrustLevel;
    capabilities?: string[];
    replaceCapabilities?: boolean;
    generateFingerprint?: boolean;
    cwd?: string;
    preferredDirName?: string;
    env?: NodeJS.ProcessEnv;
}
export interface RegisteredAgentIdentityOptions {
    agentName?: string;
    agentId?: string;
    cwd?: string;
    preferredDirName?: string;
    env?: NodeJS.ProcessEnv;
    allowCurrent?: boolean;
    allowEnv?: boolean;
}
export declare function generateAgentId(): string;
export declare function resolveDefaultAgentName(env?: NodeJS.ProcessEnv): string;
export declare function loadAgentIdentity(agentId: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument;
export declare function saveAgentIdentity(agent: AgentIdentityDocument, cwd?: string, preferredDirName?: string): void;
export declare function listAgentIdentities(cwd?: string, preferredDirName?: string): AgentIdentityDocument[];
export declare function findAgentIdentityByName(agentName: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument | undefined;
export declare function findAgentIdentityById(agentId: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument | undefined;
export declare function registerAgentIdentity(input: RegisterAgentIdentityInput): AgentIdentityDocument;
export declare function resolveCurrentAgentIdentity(cwd?: string, preferredDirName?: string): AgentIdentityDocument | undefined;
export declare function resolveRegisteredAgentIdentity(options?: RegisteredAgentIdentityOptions): AgentIdentityDocument | undefined;
export declare function requireRegisteredAgentIdentity(options?: RegisteredAgentIdentityOptions): AgentIdentityDocument;
export declare function resolveAgentScope(agentName?: string, cwd?: string, preferredDirName?: string): string | undefined;
/**
 * Returns the current model identifier if declared, from:
 *  1. $BRAINCLAW_MODEL env var  (explicit per-session declaration)
 *  2. registered agent document model field
 *  3. undefined (not tracked)
 */
export declare function resolveCurrentModel(cwd?: string): string | undefined;
/**
 * Returns the name of the current agent, with priority:
 *  1. $BRAINCLAW_AGENT_NAME env var  (AI agent self-declaration)
 *  2. $BRAINCLAW_AGENT      env var  (legacy alias)
 *  3. config.current_agent           (project owner / human default)
 *  4. OS user                        (last-resort fallback)
 */
export declare function resolveCurrentAgentName(cwd?: string): string;
export declare function requireOperationalAgentIdentity(agentName?: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument;
export declare function resolveExistingCurrentAgent(cwd?: string): AgentIdentityDocument | undefined;
export declare function setCurrentAgentIdentity(agent: AgentIdentityDocument, cwd?: string, preferredDirName?: string): void;
export declare function hasElevatedAgent(cwd?: string): boolean;
export declare function hasMinimumTrustLevel(level: AgentTrustLevel, required: AgentTrustLevel): boolean;
export declare function requireMinimumTrustLevel(identity: AgentIdentityDocument, required: AgentTrustLevel): void;
export declare function setAgentTrustLevel(agentNameOrId: string, level: AgentTrustLevel, cwd?: string): AgentIdentityDocument;
export declare function getAgentTrustLevel(agentNameOrId: string, cwd?: string): AgentTrustLevel;
export declare function agentCanWriteDirect(agentNameOrId?: string, cwd?: string): boolean;
export declare function agentCanCurate(agentNameOrId?: string, cwd?: string): boolean;
//# sourceMappingURL=agent-registry.d.ts.map