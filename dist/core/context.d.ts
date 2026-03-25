import { type ActiveProject } from './active-project.js';
import { type ContextDiffResult } from './context-diff.js';
import { type StoreRef } from './store-resolution.js';
import { type DerivedContextSignal } from './bootstrap.js';
import { type AgentToolingSnapshot } from './agent-context.js';
import { type CompactExecutionContextSnapshot } from './execution-context.js';
import { type AgentResumeSummary } from './reputation.js';
import { loadState } from './state.js';
import { listCandidates } from './candidates.js';
import { listRuntimeNotes } from './runtime.js';
import type { Claim, InstructionEntry, PlanItem, ProjectMode, ProjectStrategy } from './schema.js';
export declare const CONTEXT_SCHEMA_VERSION = "1.2";
export interface ContextOptions {
    target?: string;
    project?: string;
    agent?: string;
    host?: string;
    allHosts?: boolean;
    includePending?: boolean;
    profile?: 'dev' | 'openclaw' | 'ops' | 'research' | 'compact' | 'copilot' | 'quick';
    maxItems?: number;
    maxChars?: number;
    digest?: boolean;
    bootstrap?: boolean;
    refreshBootstrap?: boolean;
    sinceSession?: string;
    cwd?: string;
}
export interface ContextItem {
    id: string;
    section: 'plan' | 'constraint' | 'decision' | 'trap' | 'handoff' | 'candidate' | 'runtime' | 'cross_project';
    text: string;
    tags: string[];
    score: number;
    reasons: string[];
    related_paths?: string[];
    extra?: string;
    from_project?: string;
    provenance?: {
        actor?: string;
        actor_id?: string;
        project_id?: string;
        host_id?: string;
        session_id?: string;
    };
}
export interface OpenWorkSummary {
    active_claims: Pick<Claim, 'id' | 'scope' | 'description' | 'created_at' | 'plan_id' | 'expires_at'>[];
    in_progress_plans: Pick<PlanItem, 'id' | 'text' | 'assignee'>[];
}
export interface ContextResult {
    context_schema: string;
    profile: string;
    project_id?: string;
    agent_id?: string;
    project_mode: ProjectMode;
    project_strategy: ProjectStrategy;
    current_host: string;
    host_filter?: string;
    all_hosts: boolean;
    memory_version: string;
    target: string;
    project?: string;
    agent?: string;
    digest?: string;
    memory_density: 'low' | 'medium' | 'high';
    bootstrap_available: boolean;
    derived_signals?: DerivedContextSignal[];
    execution_context?: CompactExecutionContextSnapshot;
    agent_tooling?: Pick<AgentToolingSnapshot, 'agents_md_present' | 'agents_md_title' | 'agents_rules' | 'skills' | 'mcp_servers'>;
    scoped_activity?: ScopedActivitySummary;
    context_diff?: ContextDiffResult;
    resolved_instructions: InstructionEntry[];
    resume_summary?: AgentResumeSummary;
    open_work?: OpenWorkSummary;
    estimation_calibration?: string;
    stores?: Pick<StoreRef, 'cwd' | 'depth' | 'role'>[];
    cross_project_items?: ContextItem[];
    active_project?: ActiveProject;
    claim_conflicts?: ClaimConflict[];
    workflow_hints?: string[];
    selected: ContextItem[];
}
export interface ClaimConflict {
    my_claim_id: string;
    my_scope: string;
    other_claim_id: string;
    other_agent: string;
    other_scope: string;
    overlap_reason: string;
}
export interface ScopedActivityItemSummary {
    id: string;
    text: string;
    age_hours: number;
}
export interface ScopedActivitySummary {
    scope: string;
    last_decision?: ScopedActivityItemSummary;
    last_trap?: ScopedActivityItemSummary;
    recent_notes: number;
    pending_candidates: number;
    last_agent?: string;
    last_session?: string;
}
export declare function buildContext(options?: ContextOptions): ContextResult;
export declare function renderContextMarkdown(result: ContextResult, explain?: boolean): string;
export declare function renderContextPromptTemplate(result: ContextResult, compact?: boolean): string;
export declare function buildScopedActivity(input: {
    target?: string;
    project?: string;
    state: ReturnType<typeof loadState>;
    runtimeNotes: ReturnType<typeof listRuntimeNotes>;
    pendingCandidates: ReturnType<typeof listCandidates>;
}): ScopedActivitySummary | undefined;
export declare function buildContextDigest(result: ContextResult): string;
//# sourceMappingURL=context.d.ts.map