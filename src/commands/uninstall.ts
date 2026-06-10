import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, memoryExists } from '../core/io.js';
import {
  BRAINCLAW_SECTION_START,
  BRAINCLAW_SECTION_END,
  AGENT_EXPORT_REGISTRY,
} from '../core/agent-files.js';
import { resolveHomeDir } from '../core/setup-state.js';
import { confirmAction } from './confirm.js';

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

  await confirmAction('Remove brainclaw from this project? This deletes .brainclaw/ and all generated agent files.', skipConfirm);

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

  // Remove companion files dedicated to brainclaw. Shared JSON configs are
  // stripped below so uninstall does not delete user-owned settings.
  const companionFiles = [
    '.claude/commands/brainclaw.md',
    '.claude/.bclaw-session',
    '.cursor/rules/brainclaw-mcp-shim.mdc',
    '.github/skills/brainclaw-context/SKILL.md',
  ];

  for (const relativePath of companionFiles) {
    const fullPath = path.join(cwd, relativePath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`✔ Removed ${relativePath}`);
    }
  }

  stripProjectCompanionConfigs(cwd);

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

  await confirmAction('Remove brainclaw global config (~/.brainclaw/)?', skipConfirm);

  fs.rmSync(userStore, { recursive: true, force: true });
  console.log('✔ Removed ~/.brainclaw/');

  // Note: global MCP configs in ~/.claude/settings.json, ~/.cursor/mcp.json etc.
  // are NOT removed automatically — they may contain non-brainclaw entries.
  console.log('Note: global agent MCP configs (e.g. ~/.claude/settings.json) were not modified.');
  console.log('Remove brainclaw entries manually if needed.');
  console.log('✔ Machine uninstall complete.');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripBrainclawKeyedMcp(config: Record<string, unknown>): boolean {
  const servers = isJsonObject(config.mcpServers) ? { ...config.mcpServers } : undefined;
  if (!servers || !Object.prototype.hasOwnProperty.call(servers, 'brainclaw')) return false;
  delete servers.brainclaw;
  if (Object.keys(servers).length === 0) {
    delete config.mcpServers;
  } else {
    config.mcpServers = servers;
  }
  return true;
}

function stripBrainclawContinueMcp(config: Record<string, unknown>): boolean {
  if (!Array.isArray(config.mcpServers)) return false;
  const next = config.mcpServers.filter((entry) => !(isJsonObject(entry) && entry.name === 'brainclaw'));
  if (next.length === config.mcpServers.length) return false;
  if (next.length === 0) {
    delete config.mcpServers;
  } else {
    config.mcpServers = next;
  }
  return true;
}

function stripBrainclawOpenCodeMcp(config: Record<string, unknown>): boolean {
  const mcp = isJsonObject(config.mcp) ? { ...config.mcp } : undefined;
  if (!mcp || !Object.prototype.hasOwnProperty.call(mcp, 'brainclaw')) return false;
  delete mcp.brainclaw;
  if (Object.keys(mcp).length === 0) {
    delete config.mcp;
  } else {
    config.mcp = mcp;
  }
  return true;
}

function stripBrainclawClaudePermissions(config: Record<string, unknown>, cwd: string): boolean {
  const permissions = isJsonObject(config.permissions) ? { ...config.permissions } : undefined;
  if (!permissions) return false;

  let changed = false;
  if (Array.isArray(permissions.allow)) {
    const next = permissions.allow.filter((entry) => entry !== 'Bash(npx brainclaw:*)' && entry !== 'mcp__brainclaw__*');
    changed = changed || next.length !== permissions.allow.length;
    if (next.length === 0) {
      delete permissions.allow;
    } else {
      permissions.allow = next;
    }
  }

  if (Array.isArray(permissions.additionalDirectories)) {
    const brainclawDirs = new Set([
      path.join(cwd, '.claude', 'worktrees'),
      path.join(resolveHomeDir() ?? '', '.brainclaw', 'worktrees'),
    ].filter(Boolean).map((entry) => path.resolve(entry).replace(/\\/g, '/').toLowerCase()));
    const next = permissions.additionalDirectories.filter((entry) => {
      if (typeof entry !== 'string') return true;
      return !brainclawDirs.has(path.resolve(entry).replace(/\\/g, '/').toLowerCase());
    });
    changed = changed || next.length !== permissions.additionalDirectories.length;
    if (next.length === 0) {
      delete permissions.additionalDirectories;
    } else {
      permissions.additionalDirectories = next;
    }
  }

  if (!changed) return false;
  if (Object.keys(permissions).length === 0) {
    delete config.permissions;
  } else {
    config.permissions = permissions;
  }
  return true;
}

function rewriteJsonConfig(relativePath: string, cwd: string, strip: (config: Record<string, unknown>) => boolean): void {
  const fullPath = path.join(cwd, relativePath);
  if (!fs.existsSync(fullPath)) return;

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as unknown;
    if (!isJsonObject(parsed)) return;
    config = { ...parsed };
  } catch {
    console.log(`! Skipped ${relativePath} (not valid JSON)`);
    return;
  }

  if (!strip(config)) return;
  if (Object.keys(config).length === 0) {
    fs.unlinkSync(fullPath);
    console.log(`✔ Removed ${relativePath} (was brainclaw-only)`);
  } else {
    fs.writeFileSync(fullPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    console.log(`✔ Removed brainclaw entries from ${relativePath}`);
  }
}

function stripProjectCompanionConfigs(cwd: string): void {
  rewriteJsonConfig('.mcp.json', cwd, stripBrainclawKeyedMcp);
  rewriteJsonConfig('.vscode/cline_mcp_settings.json', cwd, stripBrainclawKeyedMcp);
  rewriteJsonConfig('.roo/mcp.json', cwd, stripBrainclawKeyedMcp);
  rewriteJsonConfig('.continue/config.json', cwd, stripBrainclawContinueMcp);
  rewriteJsonConfig('opencode.json', cwd, stripBrainclawOpenCodeMcp);
  rewriteJsonConfig('.claude/settings.local.json', cwd, (config) => stripBrainclawClaudePermissions(config, cwd));
}
