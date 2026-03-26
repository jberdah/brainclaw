import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
export function detectAiAgent(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): DetectedAiAgent | undefined {
  // Explicit override
  if (env.BRAINCLAW_AGENT?.trim()) {
    return {
      name: env.BRAINCLAW_AGENT.trim(),
      kind: 'agent',
      trust_level: 'trusted',
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
      trust_level: 'trusted',
      detection_source: source,
    };
  }

  // Cursor IDE
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID || env.CURSOR_CHANNEL) {
    return {
      name: 'cursor',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: 'CURSOR_* env var',
    };
  }

  // Windsurf
  if (env.WINDSURF_SESSION_ID || env.WINDSURF_AGENT) {
    return {
      name: 'windsurf',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: 'WINDSURF_* env var',
    };
  }

  // Cline (VS Code extension)
  if (env.CLINE_AGENT || env.CLINE_SESSION_ID) {
    return {
      name: 'cline',
      kind: 'agent',
      trust_level: 'trusted',
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
      trust_level: 'trusted',
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
      trust_level: 'trusted',
      detection_source: source,
    };
  }

  // OpenCode
  if (env.OPENCODE_SESSION_ID || env.OPENCODE_AGENT || fs.existsSync(path.join(homeDir, '.config', 'opencode'))) {
    return {
      name: 'opencode',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: env.OPENCODE_SESSION_ID || env.OPENCODE_AGENT ? 'OPENCODE_* env var' : '~/.config/opencode directory',
    };
  }

  // Antigravity (Google Gemini CLI)
  if (env.ANTIGRAVITY_SESSION_ID || env.ANTIGRAVITY_AGENT || fs.existsSync(path.join(homeDir, '.gemini', 'antigravity'))) {
    return {
      name: 'antigravity',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: env.ANTIGRAVITY_SESSION_ID || env.ANTIGRAVITY_AGENT ? 'ANTIGRAVITY_* env var' : '~/.gemini/antigravity directory',
    };
  }

  // Continue.dev
  if (env.CONTINUE_AGENT || env.CONTINUE_SESSION_ID) {
    return {
      name: 'continue',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: 'CONTINUE_* env var',
    };
  }

  // Roo Code
  if (env.ROO_AGENT || env.ROO_SESSION_ID) {
    return {
      name: 'roo',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: 'ROO_* env var',
    };
  }

  // OpenClaw (~/.openclaw/ presence or OPENCLAW_* env)
  if (env.OPENCLAW_SESSION_ID || env.OPENCLAW_AGENT || fs.existsSync(path.join(homeDir, '.openclaw'))) {
    return {
      name: 'openclaw',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: env.OPENCLAW_SESSION_ID || env.OPENCLAW_AGENT ? 'OPENCLAW_* env var' : '~/.openclaw directory',
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
