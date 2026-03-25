export interface CoordinationOptions {
    agent?: string;
    project?: string;
    target?: string;
    host?: string;
    allHosts?: boolean;
    includeReputation?: boolean;
    /** If false (default), session_start and session_end runtime notes are excluded from the board. */
    includeSessionMeta?: boolean;
    /** If true, all open handoffs shown to the agent are auto-marked as 'accepted'. */
    autoAcknowledge?: boolean;
    cwd?: string;
}
export declare function buildCoordinationSnapshot(options?: CoordinationOptions): {
    project_id: string | undefined;
    current_host: string;
    host_filter: string | undefined;
    all_hosts: boolean;
    project: string | undefined;
    agent: string | undefined;
    agent_id: string | undefined;
    active_plans: {
        claims: {
            status: "active" | "released" | "stale";
            id: string;
            created_at: string;
            agent: string;
            scope: string;
            description: string;
            schema_version?: number | undefined;
            model?: string | undefined;
            project_id?: string | undefined;
            host_id?: string | undefined;
            session_id?: string | undefined;
            expires_at?: string | undefined;
            plan_id?: string | undefined;
            project?: string | undefined;
            agent_id?: string | undefined;
            released_at?: string | undefined;
        }[];
        status: "todo" | "in_progress" | "blocked" | "done" | "dropped";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        updated_at: string;
        priority: "low" | "medium" | "high";
        depends_on: string[];
        type?: "feat" | "fix" | "chore" | "spike" | "doc" | undefined;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        model?: string | undefined;
        related_paths?: string[] | undefined;
        project?: string | undefined;
        assignee?: string | undefined;
        steps?: {
            status: "todo" | "done";
            id: string;
            text: string;
            created_at: string;
            updated_at: string;
            assignee?: string | undefined;
        }[] | undefined;
        estimated_effort?: number | undefined;
        actual_effort?: string | undefined;
        started_at?: string | undefined;
        completed_at?: string | undefined;
    }[];
    active_claims: {
        status: "active" | "released" | "stale";
        id: string;
        created_at: string;
        agent: string;
        scope: string;
        description: string;
        schema_version?: number | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        expires_at?: string | undefined;
        plan_id?: string | undefined;
        project?: string | undefined;
        agent_id?: string | undefined;
        released_at?: string | undefined;
    }[];
    runtime_notes: {
        id: string;
        text: string;
        created_at: string;
        tags: string[];
        visibility: "shared" | "machine" | "private";
        agent: string;
        note_type: "observation" | "session_start" | "session_end";
        schema_version?: number | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        expires_at?: string | undefined;
        plan_id?: string | undefined;
        project?: string | undefined;
        agent_id?: string | undefined;
    }[];
    session_meta_hidden: number;
    open_handoffs: {
        status: "open" | "accepted" | "closed";
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        from: string;
        to: string;
        schema_version?: number | undefined;
        short_label?: string | undefined;
        author_id?: string | undefined;
        model?: string | undefined;
        project_id?: string | undefined;
        host_id?: string | undefined;
        session_id?: string | undefined;
        related_paths?: string[] | undefined;
        plan_id?: string | undefined;
        project?: string | undefined;
        snapshot?: {
            diff?: string | undefined;
        } | undefined;
    }[];
    resolved_instructions: {
        active: boolean;
        id: string;
        text: string;
        created_at: string;
        author: string;
        tags: string[];
        updated_at: string;
        layer: "project" | "global" | "agent";
        schema_version?: number | undefined;
        model?: string | undefined;
        scope?: string | undefined;
        supersedes?: string | undefined;
    }[];
    reputation_summary: import("./reputation.js").ReputationSummary | undefined;
    agent_reputation: import("./reputation.js").ReputationAgentPublicSummary | undefined;
};
//# sourceMappingURL=coordination.d.ts.map