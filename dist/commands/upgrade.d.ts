export interface UpgradeOptions {
    cwd?: string;
    json?: boolean;
    dryRun?: boolean;
    /** If true, detect a newer brainclaw package version and install it before upgrading memory. */
    selfUpdate?: boolean;
}
export declare function runUpgrade(options?: UpgradeOptions): void;
//# sourceMappingURL=upgrade.d.ts.map