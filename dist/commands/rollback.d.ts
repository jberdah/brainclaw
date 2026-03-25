export interface RollbackOptions {
    auditId?: string;
    itemId?: string;
    actor?: string;
    dryRun?: boolean;
    json?: boolean;
}
export declare function runRollback(options?: RollbackOptions): void;
//# sourceMappingURL=rollback.d.ts.map