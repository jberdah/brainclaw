type IdentityKind = 'registered-agent' | 'actor';
interface IdentityRef {
    key: string;
    agent_id?: string;
    agent_name: string;
    kind: IdentityKind;
}
interface ReputationAccumulator {
    identity: IdentityRef;
    signals: {
        candidates_authored: number;
        pending_candidates: number;
        accepted_candidates: number;
        rejected_candidates_authored: number;
        promoted_runtime_candidates: number;
        promoted_runtime_accepted: number;
        stars_received: number;
        uses_received: number;
        accepted_reviews: number;
        rejected_reviews: number;
        reasoned_rejections: number;
        runtime_notes_created: number;
        plan_linked_activity: number;
        claims_created: number;
        released_claims: number;
        orphan_runtime_noise: number;
    };
}
export interface ReputationAgentSnapshot {
    key: string;
    agent_id?: string;
    agent_name: string;
    kind: IdentityKind;
    signals: ReputationAccumulator['signals'];
    scores: {
        contribution_quality: number;
        review_reliability: number;
        continuity_hygiene: number;
        internal_trust: number;
    };
}
export interface ReputationSnapshot {
    enabled: boolean;
    visibility: 'internal-only' | 'summary' | 'full';
    window_days: number;
    generated_at: string;
    project_id?: string;
    current_agent_id?: string;
    current_agent?: ReputationAgentSnapshot;
    agents: ReputationAgentSnapshot[];
}
export interface AgentResumeSummary {
    agent_name: string;
    agent_id?: string;
    internal_trust: number;
    contribution_quality: number;
    review_reliability: number;
    continuity_hygiene: number;
    strengths: string[];
    cautions: string[];
    suggested_focus: string[];
}
export interface ReputationRankingLookup {
    enabled: boolean;
    ranking_weight: number;
    getInternalTrust: (actorId?: string, actorName?: string) => number;
    getRankingBonus: (actorId?: string, actorName?: string) => number;
}
export interface ReputationSummary {
    enabled: boolean;
    visibility: 'internal-only' | 'summary' | 'full';
    tracked_agents: number;
    avg_internal_trust: number;
    current_agent_id?: string;
    current_agent_trust?: number;
    total_pending_candidates: number;
    total_review_resolutions: number;
    total_runtime_notes: number;
}
export interface ReputationAgentPublicSummary {
    agent_name: string;
    agent_id?: string;
    internal_trust: number;
    contribution_quality: number;
    review_reliability: number;
    continuity_hygiene: number;
    pending_candidates: number;
    accepted_candidates: number;
    accepted_reviews: number;
    rejected_reviews: number;
}
export declare function buildReputationSnapshot(cwd?: string): ReputationSnapshot;
export declare function buildCurrentAgentResumeSummary(cwd?: string): AgentResumeSummary | undefined;
export declare function buildReputationRankingLookup(cwd?: string): ReputationRankingLookup;
export declare function toPublicReputationSummary(agent: ReputationAgentSnapshot): ReputationAgentPublicSummary;
export declare function buildReputationSummary(cwd?: string): ReputationSummary;
export declare function findAgentReputationSummary(agentNameOrId: string | undefined, cwd?: string): ReputationAgentPublicSummary | undefined;
export {};
//# sourceMappingURL=reputation.d.ts.map