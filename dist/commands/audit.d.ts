export interface AuditCommandOptions {
    since?: string;
    actor?: string;
    action?: string;
    json?: boolean;
    limit?: number;
}
export declare function runAuditCommand(options?: AuditCommandOptions): void;
//# sourceMappingURL=audit.d.ts.map