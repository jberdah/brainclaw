export type EventAction = 'create' | 'update' | 'delete' | 'accept' | 'reject' | 'claim' | 'release_claim' | 'session_start' | 'session_end' | 'rollback' | 'upgrade';
export type EventItemType = 'constraint' | 'decision' | 'trap' | 'handoff' | 'plan' | 'claim' | 'candidate' | 'runtime_note' | 'instruction' | 'session' | 'state';
export interface MemoryEvent {
    ts: string;
    agent: string;
    agent_id?: string;
    /** OS user who triggered this event. */
    user?: string;
    action: EventAction;
    item_type: EventItemType;
    item_id?: string;
    summary?: string;
}
export declare function appendEvent(event: Partial<MemoryEvent> & {
    action: EventAction;
    item_type: EventItemType;
}, cwd?: string): void;
export declare function readAllEvents(cwd?: string): MemoryEvent[];
export interface AgentCursor {
    offset: number;
    last_read: string;
}
/**
 * Read events unseen by this agent since their last read.
 * Updates the cursor after reading.
 */
export declare function readUnseenEvents(agent: string, cwd?: string): MemoryEvent[];
/**
 * Build a compact notification summary from unseen events.
 */
export declare function buildNotificationSummary(events: MemoryEvent[]): Record<string, number> | undefined;
/**
 * Check if the event log needs rotation. Returns true if rotated.
 */
export declare function rotateEventLogIfNeeded(cwd?: string): boolean;
//# sourceMappingURL=event-log.d.ts.map