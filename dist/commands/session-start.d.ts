import { type SessionSnapshot } from '../core/schema.js';
export interface SessionStartOptions {
    agent?: string;
    agentId?: string;
    context?: string;
    model?: string;
    json?: boolean;
    cwd?: string;
}
export interface SessionStartResult extends SessionSnapshot {
    context_target?: string;
    agent_git_hygiene?: {
        missing_gitignore_paths: string[];
        tracked_paths: string[];
    };
    inventory_advisory?: string[];
}
export declare function runSessionStart(options?: SessionStartOptions): void;
export declare function startSession(options?: SessionStartOptions): SessionStartResult;
export declare function loadSessionSnapshot(sessionId: string, cwd?: string): SessionSnapshot | undefined;
//# sourceMappingURL=session-start.d.ts.map