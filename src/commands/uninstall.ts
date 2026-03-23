import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { MEMORY_DIR, memoryExists } from '../core/io.js';
import {
  BRAINCLAW_SECTION_START,
  BRAINCLAW_SECTION_END,
  AGENT_EXPORT_REGISTRY,
} from '../core/agent-files.js';
import { resolveHomeDir } from '../core/setup-state.js';

export interface UninstallOptions {
  project?: boolean;
  machine?: boolean;
  yes?: boolean;
  cwd?: string;
}

/**
 * Remove brainclaw from a project and/or machine.
 *
 * --project: removes .brainclaw/, agent instruction files, MCP configs,
 *            and brainclaw sections from shared instruction files.
 * --machine: removes ~/.brainclaw/ and global agent configs.
 */
export async function runUninstall(options: UninstallOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  if (!options.project && !options.machine) {
    console.error('Error: specify --project, --machine, or both.');
    process.exit(1);
  }

  if (options.project) {
    await uninstallProject(cwd, options.yes);
  }

  if (options.machine) {
    await uninstallMachine(options.yes);
  }
}

async function uninstallProject(cwd: string, skipConfirm?: boolean): Promise<void> {
  if (!memoryExists(cwd)) {
    console.log('No .brainclaw/ found in this project. Nothing to uninstall.');
    return;
  }

  if (!skipConfirm && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('Remove brainclaw from this project? This deletes .brainclaw/ and all generated agent files. [y/N]: ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  // Remove .brainclaw/ directory
  const brainclawDir = path.join(cwd, MEMORY_DIR);
  if (fs.existsSync(brainclawDir)) {
    fs.rmSync(brainclawDir, { recursive: true, force: true });
    console.log(`✔ Removed ${MEMORY_DIR}/`);
  }

  // Remove dedicated agent files (non-shared, brainclaw-owned)
  const dedicatedFiles = AGENT_EXPORT_REGISTRY
    .map((entry) => entry.relativePath)
    .filter((p) => p.includes('/'));

  for (const relativePath of dedicatedFiles) {
    const fullPath = path.join(cwd, relativePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`✔ Removed ${relativePath}`);
    }
  }

  // Remove brainclaw sections from shared files
  const sharedFiles = [
    'CLAUDE.md',
    '.windsurfrules',
    'AGENTS.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
  ];

  for (const relativePath of sharedFiles) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, 'utf-8');
    const startIdx = content.indexOf(BRAINCLAW_SECTION_START);
    const endIdx = content.indexOf(BRAINCLAW_SECTION_END);

    if (startIdx !== -1 && endIdx !== -1) {
      const before = content.slice(0, startIdx).trimEnd();
      const after = content.slice(endIdx + BRAINCLAW_SECTION_END.length).trimStart();
      const cleaned = [before, after].filter(Boolean).join('\n\n');

      if (cleaned.trim().length === 0) {
        fs.unlinkSync(fullPath);
        console.log(`✔ Removed ${relativePath} (was brainclaw-only)`);
      } else {
        fs.writeFileSync(fullPath, cleaned + '\n', 'utf-8');
        console.log(`✔ Removed brainclaw section from ${relativePath}`);
      }
    }
  }

  // Remove companion config files
  const companionFiles = [
    '.mcp.json',
    '.claude/commands/brainclaw.md',
    '.claude/settings.local.json',
    '.claude/.bclaw-session',
    '.cursor/rules/brainclaw-mcp-shim.mdc',
    '.vscode/cline_mcp_settings.json',
    '.roo/mcp.json',
    '.continue/config.json',
    'opencode.json',
    '.github/skills/brainclaw-context/SKILL.md',
  ];

  for (const relativePath of companionFiles) {
    const fullPath = path.join(cwd, relativePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`✔ Removed ${relativePath}`);
    }
  }

  console.log('✔ Project uninstall complete.');
}

async function uninstallMachine(skipConfirm?: boolean): Promise<void> {
  const home = resolveHomeDir();
  if (!home) {
    console.log('Cannot determine home directory. Nothing to uninstall.');
    return;
  }

  const userStore = path.join(home, '.brainclaw');
  if (!fs.existsSync(userStore)) {
    console.log('No ~/.brainclaw/ found. Nothing to uninstall.');
    return;
  }

  if (!skipConfirm && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('Remove brainclaw global config (~/.brainclaw/)? [y/N]: ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  fs.rmSync(userStore, { recursive: true, force: true });
  console.log('✔ Removed ~/.brainclaw/');

  // Note: global MCP configs in ~/.claude/settings.json, ~/.cursor/mcp.json etc.
  // are NOT removed automatically — they may contain non-brainclaw entries.
  console.log('Note: global agent MCP configs (e.g. ~/.claude/settings.json) were not modified.');
  console.log('Remove brainclaw entries manually if needed.');
  console.log('✔ Machine uninstall complete.');
}
