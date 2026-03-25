export interface ClaudeDesktopExtensionOptions {
    cwd?: string;
    workspaceDir?: string;
    outputFile?: string;
    projectRoot?: string;
    pack?: boolean;
    runtimeRootOverride?: string;
    packageRootOverride?: string;
    dependenciesOverride?: string[];
}
export interface ClaudeDesktopExtensionResult {
    workspaceDir: string;
    outputFile: string;
    packed: boolean;
    manifestPath: string;
    entryPointPath: string;
    packageRoot: string;
    runtimeRoot: string;
    projectRoot: string;
    copiedDependencies: string[];
}
export declare function buildClaudeDesktopExtension(options?: ClaudeDesktopExtensionOptions): ClaudeDesktopExtensionResult;
export declare function renderClaudeDesktopExtensionSummary(result: ClaudeDesktopExtensionResult): string;
//# sourceMappingURL=claude-desktop-extension.d.ts.map