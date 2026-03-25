export interface ContextCommandOptions {
    for?: string;
    project?: string;
    agent?: string;
    host?: string;
    allHosts?: boolean;
    json?: boolean;
    template?: boolean;
    compactTemplate?: boolean;
    explain?: boolean;
    includePending?: boolean;
    profile?: 'dev' | 'openclaw' | 'ops' | 'research';
    maxItems?: number;
    maxChars?: number;
    digest?: boolean;
    bootstrap?: boolean;
    refreshBootstrap?: boolean;
    sinceSession?: string;
    cwd?: string;
}
export declare function runContext(options?: ContextCommandOptions): void;
//# sourceMappingURL=context.d.ts.map