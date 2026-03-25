/** Record a manual reset for a given agent key (resets the rolling window for that agent). */
export declare function resetCircuitBreaker(agentKey: string, cwd?: string): void;
export interface CircuitBreakerStatus {
    tripped: boolean;
    agent_key: string;
    rejection_count: number;
    threshold: number;
    window_days: number;
    window_start: string;
}
export interface CircuitBreakerSnapshot {
    checked_at: string;
    window_days: number;
    threshold: number;
    tripped_agents: CircuitBreakerStatus[];
    clear_agents: CircuitBreakerStatus[];
}
/**
 * Check circuit-breaker state for a single agent.
 * Counts accepted rejections in the rolling window and compares to threshold.
 */
export declare function checkCircuitBreaker(agentNameOrId: string, cwd?: string): CircuitBreakerStatus;
/**
 * Build a snapshot of circuit-breaker state for all agents that have
 * any recent rejection activity. Agents with no activity are omitted.
 */
export declare function buildCircuitBreakerSnapshot(cwd?: string): CircuitBreakerSnapshot;
//# sourceMappingURL=circuit-breaker.d.ts.map