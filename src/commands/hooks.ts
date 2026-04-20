import fs from 'node:fs';
import path from 'node:path';
import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { BRAINCLAW_SECTION_START, BRAINCLAW_SECTION_END, upsertBrainclawSection, ensureClaudeCodeSettings } from '../core/agent-files.js';

export type HookTarget = 'cursor' | 'windsurf' | 'claude-code' | 'codex' | 'cline' | 'github-copilot' | 'all';

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
export function generateCursorHook(projectName: string): string {
  return `---
description: brainclaw session bootstrap for ${projectName}
alwaysApply: true
---

# Brainclaw session bootstrap

Brainclaw is the shared coordination layer for this project. Use its MCP facades first — the CLI is only a fallback when MCP is unavailable.

## At the start of every session

Call \`bclaw_work(intent)\` — it handles session setup, context load, and scope claim in a single call.

- \`bclaw_work(intent: "resume")\` when continuing an existing task.
- \`bclaw_work(intent: "execute", scope: "<path>", task: "<text>")\` when starting new work on a specific scope.
- \`bclaw_work(intent: "consult")\` to read context without claiming.

## To coordinate with other agents

\`bclaw_coordinate(intent)\` — \`assign\`, \`consult\`, \`review\`, or \`reroute\`.

## Before finishing

- Release your claims: \`bclaw_release_claim(id)\`.
- Close out the session: \`bclaw_session_end\` (or let it auto-release via the session hook).

CLI fallback only: \`brainclaw context\` / \`brainclaw session-end --auto-release\` if MCP is not reachable.
`;
}

/**
 * Generate the Windsurf session-trigger section.
 * Windsurf reads .windsurfrules on every Cascade activation — a clearly
 * delimited "SESSION START" block acts as a deterministic trigger.
 */
export function generateWindsurfHook(projectName: string): string {
  return `# Brainclaw session trigger — ${projectName}
# This block is always active. Windsurf Cascade reads .windsurfrules on every activation.

## SESSION START (always run first)

Call the Brainclaw MCP facade before responding to any request:

- \`bclaw_work(intent: "resume")\` when continuing an existing task.
- \`bclaw_work(intent: "execute", scope: "<path>", task: "<text>")\` when starting new work on a specific scope.
- \`bclaw_work(intent: "consult")\` to read context without claiming.

This returns active constraints, recent decisions, known traps, open plans, active claims, and the last handoff. Do not skip.

## COORDINATION

\`bclaw_coordinate(intent)\` to assign, consult, review, or reroute other agents.

## SESSION END (before finishing)

- \`bclaw_release_claim(id)\` for each claim you hold.
- \`bclaw_session_end\` to close the session (auto-releases remaining claims).

CLI fallback only when MCP is unavailable: \`brainclaw context\` / \`brainclaw session-end --auto-release\`.
`;
}

/**
 * Generate a generic markdown session-trigger section.
 */
export function generateMarkdownHook(agentName: string, projectName: string): string {
  return `# Brainclaw session trigger — ${projectName}
# This block is always active. ${agentName} reads this file on every activation.

## SESSION START (always run first)

Call the Brainclaw MCP facade before responding to any request:

- \`bclaw_work(intent: "resume")\` when continuing an existing task.
- \`bclaw_work(intent: "execute", scope: "<path>", task: "<text>")\` when starting new work on a specific scope.
- \`bclaw_work(intent: "consult")\` to read context without claiming.

This returns active constraints, recent decisions, known traps, open plans, active claims, and the last handoff. Do not skip.

## COORDINATION

\`bclaw_coordinate(intent)\` to assign, consult, review, or reroute other agents.

## SESSION END (before finishing)

- \`bclaw_release_claim(id)\` for each claim you hold.
- \`bclaw_session_end\` to close the session (auto-releases remaining claims).

CLI fallback only when MCP is unavailable: \`brainclaw context\` / \`brainclaw session-end --auto-release\`.
`;
}

export function writeHook(
  content: string,
  relativePath: string,
  cwd: string,
): HookWriteResult {
  const fullPath = path.join(cwd, relativePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);

  if (relativePath.endsWith('.mdc')) {
    // MDC files: write as-is (frontmatter must be preserved verbatim)
    fs.writeFileSync(fullPath, content, 'utf-8');
  } else {
    // Plain markdown rules files: use brainclaw sentinel markers
    const section = `${BRAINCLAW_SECTION_START}\n${content}\n${BRAINCLAW_SECTION_END}`;
    const existing = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
    fs.writeFileSync(fullPath, upsertBrainclawSection(existing, section), 'utf-8');
  }

  return { target: path.basename(relativePath, path.extname(relativePath)), relativePath, created: !existed };
}

export function runHooks(options: HooksOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const target = options.target ?? 'all';
  const results: HookWriteResult[] = [];

  if (target === 'cursor' || target === 'all') {
    const content = generateCursorHook(config.project_name);
    results.push(writeHook(content, '.cursor/rules/brainclaw-session.mdc', cwd));
  }

  if (target === 'windsurf' || target === 'all') {
    const content = generateWindsurfHook(config.project_name);
    results.push(writeHook(content, '.windsurfrules', cwd));
  }

  if (target === 'claude-code' || target === 'all') {
    const autoResult = ensureClaudeCodeSettings(cwd);
    results.push({
      target: 'claude-code',
      relativePath: autoResult.relativePath ?? '.claude/settings.local.json',
      created: autoResult.created,
    });
  }

  if (target === 'cline' || target === 'all') {
    const content = generateMarkdownHook('Cline', config.project_name);
    results.push(writeHook(content, '.clinerules/brainclaw.md', cwd));
  }

  if (target === 'codex' || target === 'all') {
    const content = generateMarkdownHook('Codex', config.project_name);
    results.push(writeHook(content, 'AGENTS.md', cwd));
  }

  if (target === 'github-copilot' || target === 'all') {
    const content = generateMarkdownHook('GitHub Copilot', config.project_name);
    results.push(writeHook(content, '.github/copilot-instructions.md', cwd));
  }

  for (const r of results) {
    console.log(`✔ Hook written to ${r.relativePath} (${r.created ? 'created' : 'updated'})`);
  }
}

/**
 * Called from `brainclaw init` when an agent is detected.
 * Writes hooks relevant to the detected agent, silently on success.
 */
export function writeDetectedAgentHooks(
  agentName: string,
  projectName: string,
  cwd: string,
): HookWriteResult[] {
  const results: HookWriteResult[] = [];

  if (agentName === 'cursor') {
    const content = generateCursorHook(projectName);
    results.push(writeHook(content, '.cursor/rules/brainclaw-session.mdc', cwd));
  }

  if (agentName === 'windsurf') {
    const content = generateWindsurfHook(projectName);
    results.push(writeHook(content, '.windsurfrules', cwd));
  }

  if (agentName === 'claude-code') {
    const autoResult = ensureClaudeCodeSettings(cwd);
    results.push({
      target: 'claude-code',
      relativePath: autoResult.relativePath ?? '.claude/settings.local.json',
      created: autoResult.created,
    });
  }

  if (agentName === 'cline') {
    const content = generateMarkdownHook('Cline', projectName);
    results.push(writeHook(content, '.clinerules/brainclaw.md', cwd));
  }

  if (agentName === 'codex') {
    const content = generateMarkdownHook('Codex', projectName);
    results.push(writeHook(content, 'AGENTS.md', cwd));
  }

  if (agentName === 'github-copilot') {
    const content = generateMarkdownHook('GitHub Copilot', projectName);
    results.push(writeHook(content, '.github/copilot-instructions.md', cwd));
  }

  return results;
}
