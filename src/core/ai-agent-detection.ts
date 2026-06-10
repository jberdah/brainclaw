import type { AgentKind } from './schema.js';

export interface DetectedAiAgent {
  name: string;
  kind: AgentKind;
  detection_source: string;
}

/**
 * Detects the AI coding agent running in the current environment by inspecting
 * PROCESS-SCOPED environment variables ONLY. Returns the first confident
 * match, or undefined if no agent is detected.
 *
 * Identity hardening (pln#562 step 1): directory-presence fallbacks
 * (~/.config/opencode, ~/.gemini/antigravity, ~/.openclaw, ~/.vibe, ~/.hermes)
 * were removed — a config directory proves an agent is INSTALLED on the
 * machine, not that it is the agent driving THIS process. Installed-ness is
 * now answered exclusively by agent-inventory (buildAgentInventory). The
 * inventory never mints identity; this function never consults the disk.
 *
 * Detection order (highest confidence first — agents with dedicated env vars
 * are tested before agents detected via passive/ambient env vars):
 * 1. BRAINCLAW_AGENT env var (explicit override)
 * 2. Claude Code (CLAUDE_CODE_VERSION — set by Claude Code itself)
 * 3. Cursor (CURSOR_TRACE_ID — set by Cursor itself)
 * 4. Windsurf (WINDSURF_SESSION_ID — set by Windsurf itself)
 * 5. Cline (CLINE_AGENT — set by Cline itself)
 * 6. GitHub Copilot (GITHUB_COPILOT_PRODUCT — passive VS Code env, tested after active agents)
 * 7. Codex CLI (CODEX_THREAD_ID / CODEX_CI / …)
 * 8. OpenCode (OPENCODE_*)
 * 9. Antigravity / Gemini CLI (ANTIGRAVITY_*)
 * 10. Continue (CONTINUE_*)
 * 11. Roo Code (ROO_*)
 * 12. OpenClaw (OPENCLAW_*)
 * 13. Mistral Vibe (VIBE_HOME)
 * 14. Hermes (HERMES_*)
 */
export function detectAiAgent(env: NodeJS.ProcessEnv = process.env): DetectedAiAgent | undefined {
  // Explicit override
  if (env.BRAINCLAW_AGENT?.trim()) {
    return {
      name: env.BRAINCLAW_AGENT.trim(),
      kind: 'agent',
      detection_source: 'BRAINCLAW_AGENT env var',
    };
  }

  // Claude Code — tested BEFORE Copilot because both can be present in VS Code.
  // CLAUDE_CODE_VERSION is set by Claude Code CLI; CLAUDECODE is set by the VS Code extension;
  // CLAUDE_AGENT_SDK_VERSION is set on remote/SSH; CLAUDE_CODE_ENTRYPOINT indicates launch source.
  if (env.CLAUDE_CODE_VERSION || env.CLAUDECODE || env.CLAUDE_AGENT_SDK_VERSION || env.CLAUDE_CODE_ENTRYPOINT || env.ANTHROPIC_AI_PRODUCT === 'claude-code') {
    const source = env.CLAUDE_CODE_VERSION ? 'CLAUDE_CODE_VERSION env var'
      : env.CLAUDECODE ? 'CLAUDECODE env var'
      : env.CLAUDE_AGENT_SDK_VERSION ? 'CLAUDE_AGENT_SDK_VERSION env var'
      : env.CLAUDE_CODE_ENTRYPOINT ? 'CLAUDE_CODE_ENTRYPOINT env var'
      : 'ANTHROPIC_AI_PRODUCT env var';
    return {
      name: 'claude-code',
      kind: 'agent',
      detection_source: source,
    };
  }

  // Cursor IDE
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID || env.CURSOR_CHANNEL) {
    return {
      name: 'cursor',
      kind: 'agent',
      detection_source: 'CURSOR_* env var',
    };
  }

  // Windsurf
  if (env.WINDSURF_SESSION_ID || env.WINDSURF_AGENT) {
    return {
      name: 'windsurf',
      kind: 'agent',
      detection_source: 'WINDSURF_* env var',
    };
  }

  // Cline (VS Code extension)
  if (env.CLINE_AGENT || env.CLINE_SESSION_ID) {
    return {
      name: 'cline',
      kind: 'agent',
      detection_source: 'CLINE_* env var',
    };
  }

  // GitHub Copilot — tested AFTER agents with dedicated env vars.
  // GITHUB_COPILOT_TOKEN and GITHUB_COPILOT_PRODUCT are set passively by VS Code
  // whenever the Copilot extension is installed, even when another agent is active.
  // We only match if no higher-priority agent was detected above.
  if (
    env.GITHUB_COPILOT_PRODUCT ||
    (env.GITHUB_COPILOT_TOKEN && !env.CLAUDE_CODE_VERSION && !env.CLAUDECODE && !env.CURSOR_TRACE_ID && !env.WINDSURF_SESSION_ID) ||
    (env.VSCODE_GIT_IPC_HANDLE && (env.AGENT_NAME?.toLowerCase().includes('copilot') || env.GH_COPILOT_AGENT))
  ) {
    return {
      name: 'github-copilot',
      kind: 'agent',
      detection_source: env.GITHUB_COPILOT_PRODUCT ? 'GITHUB_COPILOT_PRODUCT env var' : 'GITHUB_COPILOT_TOKEN env var',
    };
  }

  // OpenAI Codex CLI — detect via active runtime env vars, not ~/.codex directory
  // (the directory persists after install and causes permanent false positives).
  // Real Codex env vars observed: CODEX_THREAD_ID, CODEX_CI, CODEX_INTERNAL_ORIGINATOR_OVERRIDE.
  if (env.CODEX_THREAD_ID || env.CODEX_CI || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || env.CODEX_AGENT || env.CODEX_SESSION_ID) {
    const source = env.CODEX_THREAD_ID ? 'CODEX_THREAD_ID env var'
      : env.CODEX_CI ? 'CODEX_CI env var'
      : env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ? 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE env var'
      : env.CODEX_AGENT ? 'CODEX_AGENT env var'
      : 'CODEX_SESSION_ID env var';
    return {
      name: 'codex',
      kind: 'agent',
      detection_source: source,
    };
  }

  // OpenCode
  if (env.OPENCODE_SESSION_ID || env.OPENCODE_AGENT) {
    return {
      name: 'opencode',
      kind: 'agent',
      detection_source: 'OPENCODE_* env var',
    };
  }

  // Antigravity (Google Gemini CLI)
  if (env.ANTIGRAVITY_SESSION_ID || env.ANTIGRAVITY_AGENT) {
    return {
      name: 'antigravity',
      kind: 'agent',
      detection_source: 'ANTIGRAVITY_* env var',
    };
  }

  // Continue.dev
  if (env.CONTINUE_AGENT || env.CONTINUE_SESSION_ID) {
    return {
      name: 'continue',
      kind: 'agent',
      detection_source: 'CONTINUE_* env var',
    };
  }

  // Roo Code
  if (env.ROO_AGENT || env.ROO_SESSION_ID) {
    return {
      name: 'roo',
      kind: 'agent',
      detection_source: 'ROO_* env var',
    };
  }

  // OpenClaw
  if (env.OPENCLAW_SESSION_ID || env.OPENCLAW_AGENT) {
    return {
      name: 'openclaw',
      kind: 'agent',
      detection_source: 'OPENCLAW_* env var',
    };
  }

  // Mistral Vibe — no dedicated session env var documented (per pln#489
  // research). VIBE_HOME is the only process-scoped marker; the ~/.vibe
  // directory check moved to agent-inventory.
  if (env.VIBE_HOME) {
    return {
      name: 'mistral-vibe',
      kind: 'agent',
      detection_source: 'VIBE_HOME env var',
    };
  }

  // Hermes Agent — detect after editor/CLI agents with stronger session env
  // vars to avoid stealing mixed shells where Hermes is merely installed.
  if (env.HERMES_SESSION_ID || env.HERMES_AGENT || env.HERMES_HOME) {
    return {
      name: 'hermes',
      kind: 'autonomous',
      detection_source: env.HERMES_SESSION_ID || env.HERMES_AGENT
        ? 'HERMES_* env var'
        : 'HERMES_HOME env var',
    };
  }

  return undefined;
}

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
export function detectWslEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): WslEnvironment | undefined {
  if (env.WSL_DISTRO_NAME) {
    return { isWsl: true, distro: env.WSL_DISTRO_NAME, detection_source: 'WSL_DISTRO_NAME env var' };
  }
  if (env.WSL_INTEROP) {
    return { isWsl: true, distro: 'unknown', detection_source: 'WSL_INTEROP env var' };
  }
  return undefined;
}
