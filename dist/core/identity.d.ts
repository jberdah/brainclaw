import { type CurrentSessionState } from './schema.js';
export interface OperationalIdentity {
    agent: string;
    agent_id: string;
    project_id?: string;
    host_id: string;
    session_id?: string;
}
export interface SessionResolutionOptions {
    agentName?: string;
    agentId?: string;
    hostId?: string;
    preferredSessionId?: string;
    persistImplicit?: boolean;
}
export interface OperationalIdentityOptions {
    agentId?: string;
    sessionId?: string;
    persistImplicitSession?: boolean;
}
export declare function resolveCurrentSessionId(env?: NodeJS.ProcessEnv, cwd?: string, options?: SessionResolutionOptions): string | undefined;
export declare function buildOperationalIdentity(agentName?: string, cwd?: string, options?: OperationalIdentityOptions): OperationalIdentity;
export declare function resolveEventSessionId(event: {
    session_id?: string;
    metadata?: Record<string, unknown> | undefined;
}): string | undefined;
export declare function loadCurrentSession(cwd?: string): CurrentSessionState | undefined;
export declare function saveCurrentSession(session: CurrentSessionState, cwd?: string): void;
export declare function clearCurrentSession(cwd?: string, sessionId?: string): void;
//# sourceMappingURL=identity.d.ts.map