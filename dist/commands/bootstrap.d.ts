export interface BootstrapCommandOptions {
    for?: string;
    json?: boolean;
    refresh?: boolean;
    cwd?: string;
    apply?: boolean;
    uninstall?: boolean;
    yes?: boolean;
    interview?: boolean;
    audience?: 'cli' | 'ide_chat' | 'any' | string;
    answersFile?: string;
}
export declare function runBootstrap(options?: BootstrapCommandOptions): Promise<void>;
//# sourceMappingURL=bootstrap.d.ts.map