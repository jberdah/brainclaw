export interface SessionEndOptions {
    session?: string;
    summary?: string;
    agent?: string;
    agentId?: string;
    autoReflect?: boolean;
    autoRelease?: boolean;
    reflectHandoff?: boolean;
    /** Include structured reflection questions in the result for the agent to answer. */
    reflect?: boolean;
    json?: boolean;
    cwd?: string;
}
export declare const REFLECTION_QUESTIONS: readonly ["What was the biggest time waste in this session, and how could it have been avoided?", "What should have been done differently (design, process, or approach)?", "What should brainclaw itself improve based on this session?"];
export interface SessionEndResult {
    session_id: string;
    agent: string;
    notes_in_session: number;
    candidates_created: number;
    context_diff?: string;
    summary: string;
    open_work_warning?: OpenWorkWarning;
    /** When reflect=true, these questions should be answered by the agent via bclaw_write_note with tag [reflection]. */
    reflection_prompt?: {
        questions: string[];
        instruction: string;
    };
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