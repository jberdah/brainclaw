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
/**
 * Load the current session for this agent+user combo.
 * Checks sessions/ directory first, falls back to legacy .current-session.
 */
export declare function loadCurrentSession(cwd?: string): CurrentSessionState | undefined;
/**
 * Load a specific session by ID.
 */
export declare function loadSessionById(sessionId: string, cwd?: string): CurrentSessionState | undefined;
/**
 * Load ALL sessions (active + stale) from the sessions/ directory.
 */
export declare function loadAllSessions(cwd?: string): CurrentSessionState[];
/**
 * Save a session to the sessions/ directory.
 */
export declare function saveCurrentSession(session: CurrentSessionState, cwd?: string): void;
/**
 * Clear a session. If sessionId is provided, only clear that specific session.
 */
export declare function clearCurrentSession(cwd?: string, sessionId?: string): void;
/**
 * Remove stale sessions that have exceeded the TTL.
 * Returns the number of sessions removed.
 */
export declare function gcStaleSessions(cwd?: string, ttlOverride?: string): number;
//# sourceMappingURL=identity.d.ts.map