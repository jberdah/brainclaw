import fs from 'node:fs';
import path from 'node:path';
import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { BRAINCLAW_SECTION_START, BRAINCLAW_SECTION_END, upsertBrainclawSection } from '../core/agent-files.js';

export type HookTarget = 'cursor' | 'windsurf' | 'all';

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

**At the start of every session, before doing anything else:**

\`\`\`bash
brainclaw context
\`\`\`

This loads the shared project memory: active constraints, recent decisions, known traps,
open plan items, active claims, and the last handoff.

**Before finishing any session:**

\`\`\`bash
brainclaw release-claim <id>          # release claims you opened
brainclaw update-plan <id> --status done   # close plan items you completed
# or in one shot:
brainclaw session-end --auto-release
\`\`\`
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

Before responding to any request, execute:

\`\`\`bash
brainclaw context
\`\`\`

This gives you: active constraints, recent decisions, known traps, open plans, active claims,
and the last handoff note. Do not skip this step.

## SESSION END (before finishing)

\`\`\`bash
brainclaw release-claim <id>               # for each claim you hold
brainclaw update-plan <id> --status done   # for each plan item you completed
# or:
brainclaw session-end --auto-release
\`\`\`
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

  return results;
}
