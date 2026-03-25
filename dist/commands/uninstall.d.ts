export interface UninstallOptions {
    project?: boolean;
    machine?: boolean;
    yes?: boolean;
    cwd?: string;
}
/**
 * Remove brainclaw from a project and/or machine.
 *
 * --project: removes .brainclaw/, agent instruction files, MCP configs,
 *            and brainclaw sections from shared instruction files.
 * --machine: removes ~/.brainclaw/ and global agent configs.
 */
export declare function runUninstall(options: UninstallOptions): Promise<void>;
//# sourceMappingURL=uninstall.d.ts.map