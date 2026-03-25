export type HookTarget = 'cursor' | 'windsurf' | 'claude-code' | 'all';
export interface HooksOptions {
    target?: HookTarget;
    cwd?: string;
}
export interface HookWriteResult {
    target: string;
    relativePath: string;
    created: boolean;
}
/**
 * Generate the Cursor MDC hook file content.
 * Uses MDC frontmatter with `alwaysApply: true` so Cursor injects it
 * deterministically into every agent conversation.
 */
export declare function generateCursorHook(projectName: string): string;
/**
 * Generate the Windsurf session-trigger section.
 * Windsurf reads .windsurfrules on every Cascade activation — a clearly
 * delimited "SESSION START" block acts as a deterministic trigger.
 */
export declare function generateWindsurfHook(projectName: string): string;
export declare function writeHook(content: string, relativePath: string, cwd: string): HookWriteResult;
export declare function runHooks(options?: HooksOptions): void;
/**
 * Called from `brainclaw init` when an agent is detected.
 * Writes hooks relevant to the detected agent, silently on success.
 */
export declare function writeDetectedAgentHooks(agentName: string, projectName: string, cwd: string): HookWriteResult[];
//# sourceMappingURL=hooks.d.ts.map