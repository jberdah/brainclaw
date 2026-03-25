export interface ReconcileOptions {
    cwd?: string;
    json?: boolean;
    dryRun?: boolean;
    applyBootstrap?: boolean;
    yes?: boolean;
    skipMachineProfile?: boolean;
    skipAgentInventory?: boolean;
}
export declare function runReconcile(options?: ReconcileOptions): Promise<void>;
//# sourceMappingURL=reconcile.d.ts.map