export declare const BRAINCLAW_SECTION_START = "<!-- brainclaw:start -->";
export declare const BRAINCLAW_SECTION_END = "<!-- brainclaw:end -->";
export declare function buildBrainclawSection(storageDir: string): string;
export declare function buildHygieneSection(): string;
export declare function hasBrainclawSection(content: string): boolean;
export declare function upsertBrainclawSection(existingContent: string, section: string): string;
export interface EnsureAgentFilesResult {
    agentsMdCreated: boolean;
    agentsMdUpdated: boolean;
    copilotInstructionsCreated: boolean;
    copilotInstructionsUpdated: boolean;
}
export interface EnsureAgentFilesOptions {
    onlyExisting?: boolean;
    requireExistingSection?: boolean;
}
export declare function ensureAgentFiles(cwd: string, storageDir: string, options?: EnsureAgentFilesOptions): EnsureAgentFilesResult;
export declare function ensureGitignoreEntries(cwd: string, entries: string[]): void;
export declare function collectWorkspaceGitignoreEntries(cwd: string, results: Array<Pick<AutoConfigWriteResult, 'filePath' | 'relativePath'>>): string[];
export declare function collectExportGitignoreEntries(cwd: string, targetRelativePath: string, results: Array<Pick<AutoConfigWriteResult, 'filePath' | 'relativePath'>>, options?: {
    includeTarget?: boolean;
}): string[];
export type ExportFormat = 'copilot-instructions' | 'cursor-rules' | 'agents-md' | 'claude-md' | 'windsurf' | 'cline' | 'roo' | 'continue' | 'gemini-md';
export interface AgentExportTarget {
    agentName: string;
    format: ExportFormat;
    /** Path to write, relative to project root */
    relativePath: string;
}
export declare const AGENT_EXPORT_REGISTRY: AgentExportTarget[];
export declare const FALLBACK_EXPORT_TARGET: AgentExportTarget;
export declare function resolveExportTarget(agentName: string): AgentExportTarget;
export declare function resolveExportTargetByFormat(format: ExportFormat): AgentExportTarget;
export declare function writeExportFile(content: string, relativePath: string, cwd: string): {
    created: boolean;
    updated: boolean;
    filePath: string;
};
export interface AutoConfigWriteResult {
    kind: 'mcp' | 'skill' | 'rule';
    label: string;
    created: boolean;
    updated: boolean;
    filePath: string;
    relativePath?: string;
}
export declare const LOCAL_ONLY_AGENT_WORKSPACE_FILES: readonly [".vscode/cline_mcp_settings.json", ".cursor/rules/brainclaw-mcp-shim.mdc", ".github/skills/brainclaw-context/SKILL.md", ".mcp.json", ".claude/commands/brainclaw.md", ".claude/settings.local.json", ".claude/.bclaw-session", ".roo/mcp.json", ".continue/config.json", "opencode.json"];
export interface AgentGitHygieneAudit {
    isGitRepo: boolean;
    auditedPaths: string[];
    presentPaths: string[];
    ignoredPaths: string[];
    missingGitignorePaths: string[];
    trackedPaths: string[];
    hasIssues: boolean;
}
export declare function auditLocalAgentWorkspaceFiles(cwd: string): AgentGitHygieneAudit;
export declare function describeAutoConfigWrite(result: AutoConfigWriteResult): string | undefined;
export declare function buildClaudeCodeCommandText(): string;
export declare function ensureClineMcpConfig(cwd: string): AutoConfigWriteResult;
export declare function ensureWindsurfMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined;
export declare function ensureCopilotSkill(cwd: string): AutoConfigWriteResult;
export declare function ensureCursorMdc(cwd: string): AutoConfigWriteResult;
export declare function ensureProjectDevDependency(cwd: string): AutoConfigWriteResult | undefined;
export declare function ensureClaudeCodeMcpConfig(cwd: string): AutoConfigWriteResult;
export declare function ensureClaudeCodeCommand(cwd: string): AutoConfigWriteResult;
export declare function ensureClaudeCodeUserSettings(homeDir: string | undefined, env?: NodeJS.ProcessEnv): AutoConfigWriteResult | undefined;
export declare function ensureClaudeCodeUserCommand(homeDir: string | undefined): AutoConfigWriteResult | undefined;
export declare function ensureClaudeCodeSettings(cwd: string): AutoConfigWriteResult;
export declare function ensureCursorMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined;
export declare function ensureRooMcpConfig(cwd: string): AutoConfigWriteResult;
export declare function ensureCodexMcpConfig(homeDir: string | undefined, env?: NodeJS.ProcessEnv): AutoConfigWriteResult | null;
export declare function ensureContinueMcpConfig(cwd: string): AutoConfigWriteResult;
export declare function ensureContinueUserMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined;
export declare function ensureOpenCodeMcpConfig(cwd: string): AutoConfigWriteResult;
export declare function ensureAntigravityMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined;
export declare function writeDetectedAgentAutoConfig(agentName: string, cwd: string, env?: NodeJS.ProcessEnv): AutoConfigWriteResult[];
export declare function writeExportCompanionFiles(format: ExportFormat, cwd: string, env?: NodeJS.ProcessEnv): AutoConfigWriteResult[];
//# sourceMappingURL=agent-files.d.ts.map