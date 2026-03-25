export interface SessionEndOptions {
    session?: string;
    summary?: string;
    agent?: string;
    agentId?: string;
    autoReflect?: boolean;
    autoRelease?: boolean;
    reflectHandoff?: boolean;
    json?: boolean;
    cwd?: string;
}
export interface SessionEndResult {
    session_id: string;
    agent: string;
    notes_in_session: number;
    candidates_created: number;
    context_diff?: string;
    summary: string;
    open_work_warning?: OpenWorkWarning;
}
export interface OpenWorkWarning {
    active_claims: {
        id: string;
        scope: string;
        description: string;
    }[];
    in_progress_plans: {
        id: string;
        text: string;
    }[];
    auto_released: boolean;
}
export declare function runSessionEnd(options?: SessionEndOptions): void;
export declare function endSession(options?: SessionEndOptions): SessionEndResult;
//# sourceMappingURL=session-end.d.ts.map