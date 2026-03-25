import type { AgentKind } from './schema.js';
export interface DetectedAiAgent {
    name: string;
    kind: AgentKind;
    trust_level: 'trusted';
    detection_source: string;
}
/**
 * Detects the AI coding agent running in the current environment by inspecting
 * environment variables and well-known config paths. Returns the first confident
 * match, or undefined if no agent is detected.
 *
 * Detection order (highest confidence first — agents with dedicated env vars
 * are tested before agents detected via passive/ambient env vars):
 * 1. BRAINCLAW_AGENT env var (explicit override)
 * 2. Claude Code (CLAUDE_CODE_VERSION — set by Claude Code itself)
 * 3. Cursor (CURSOR_TRACE_ID — set by Cursor itself)
 * 4. Windsurf (WINDSURF_SESSION_ID — set by Windsurf itself)
 * 5. Cline (CLINE_AGENT — set by Cline itself)
 * 6. GitHub Copilot (GITHUB_COPILOT_PRODUCT — passive VS Code env, tested after active agents)
 * 7. Codex CLI (~/.codex/ directory exists)
 * 8. OpenCode (OPENCODE_* env or ~/.config/opencode/)
 * 9. Antigravity / Gemini CLI (ANTIGRAVITY_* env or ~/.gemini/antigravity/)
 * 10. Continue (CONTINUE_*)
 * 11. Roo Code (ROO_*)
 * 12. OpenClaw (~/.openclaw/ or OPENCLAW_*)
 */
export declare function detectAiAgent(env?: NodeJS.ProcessEnv, homeDir?: string): DetectedAiAgent | undefined;
export interface WslEnvironment {
    isWsl: true;
    distro: string;
    detection_source: string;
}
/**
 * Detects whether brainclaw is running inside a WSL (Windows Subsystem for Linux)
 * environment. Useful to warn users that the install is WSL-local and not
 * accessible from a Windows terminal.
 */
export declare function detectWslEnvironment(env?: NodeJS.ProcessEnv): WslEnvironment | undefined;
//# sourceMappingURL=ai-agent-detection.d.ts.map