export type AuditAction = 'create' | 'update' | 'delete' | 'accept' | 'reject' | 'claim' | 'release_claim' | 'trust_change' | 'session_start' | 'session_end' | 'promote_direct' | 'rollback';
export interface AuditEntry {
    timestamp: string;
    actor_id?: string;
    actor: string;
    action: AuditAction;
    item_id?: string;
    item_type?: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
}
export declare function appendAuditEntry(entry: Partial<AuditEntry> & {
    action: AuditAction;
    actor: string;
}, cwd?: string): void;
export declare function readAuditLog(options?: {
    since?: string;
    actor?: string;
    action?: AuditAction;
    itemId?: string;
}, cwd?: string): AuditEntry[];
//# sourceMappingURL=audit.d.ts.map