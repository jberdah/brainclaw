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
 * Detection order (highest confidence first):
 * 1. BRAINCLAW_AGENT env var (explicit override)
 * 2. GitHub Copilot (VSCODE_GIT_IPC_HANDLE or VSCODE_INJECTION, then GITHUB_COPILOT_*)
 * 3. Claude Code (CLAUDE_CODE_VERSION or ANTHROPIC_AI_PRODUCT)
 * 4. Cursor (CURSOR_TRACE_ID or CURSOR_*)
 * 5. Windsurf (WINDSURF_*)
 * 6. Cline (CLINE_*)
 * 7. Codex CLI (~/.codex/ directory exists)
 * 8. Continue (CONTINUE_*)
 * 9. Roo Code (ROO_*)
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

  // GitHub Copilot — VS Code extension or Copilot Chat
  if (
    env.GITHUB_COPILOT_TOKEN ||
    env.GITHUB_COPILOT_PRODUCT ||
    (env.VSCODE_GIT_IPC_HANDLE && (env.AGENT_NAME?.toLowerCase().includes('copilot') || env.GH_COPILOT_AGENT))
  ) {
    return {
      name: 'github-copilot',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: 'GITHUB_COPILOT_* env var',
    };
  }

  // Claude Code (Anthropic's CLI coding agent)
  if (env.CLAUDE_CODE_VERSION || env.ANTHROPIC_AI_PRODUCT === 'claude-code') {
    return {
      name: 'claude-code',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: 'CLAUDE_CODE_VERSION env var',
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

  // OpenAI Codex CLI (~/.codex/ presence)
  if (fs.existsSync(path.join(homeDir, '.codex'))) {
    return {
      name: 'codex',
      kind: 'agent',
      trust_level: 'trusted',
      detection_source: '~/.codex directory',
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
