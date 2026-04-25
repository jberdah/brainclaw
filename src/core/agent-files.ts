import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { MCP_HEADLESS_AUTO_TOOL_NAMES, REMOVED_IN_V1_TOOLS } from '../commands/mcp.js';

/**
 * Resolve the brainclaw command for MCP configs.
 * Returns `{ command: "<node>", args: ["<cli.js>", "mcp"] }` so the config
 * works in non-login shells (VS Code Server, MCP subprocesses) on all OSes.
 *
 * Strategy:
 * 1. Find the brainclaw bin via which/where
 * 2. Trace from the bin/shim to the actual cli.js entry point
 * 3. Pair it with the absolute node path
 * Falls back to 'npx brainclaw mcp' if resolution fails.
 */
function resolveBrainclawMcpCommand(): { command: string; args: string[] } {
  const nodeBin = process.execPath;

  // 1. Try to resolve the cli.js from the installed brainclaw binary
  const cliJs = resolveBrainclawCliJs();
  if (cliJs) {
    return { command: nodeBin, args: [cliJs, 'mcp'] };
  }

  // 2. Fallback: npx (relies on PATH, may resolve wrong version)
  return { command: 'npx', args: ['brainclaw', 'mcp'] };
}

/**
 * Trace from the brainclaw bin/shim to the actual dist/cli.js file.
 * Works on Windows (.cmd shim), macOS/Linux (symlink to bin stub).
 */
function resolveBrainclawCliJs(): string | undefined {
  // Strategy A: find via which/where and trace to cli.js
  const whichCmd = os.platform() === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(whichCmd, ['brainclaw'], { encoding: 'utf-8', timeout: 3000 });
    if (result.status === 0) {
      const resolved = result.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (resolved) {
        const cliJs = traceToCliJs(resolved);
        if (cliJs) return cliJs;
      }
    }
  } catch {
    // Non-fatal — try next strategy
  }

  // Strategy B: resolve from this file's own package (we ARE brainclaw)
  try {
    const ownCliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    if (fs.existsSync(ownCliJs)) return ownCliJs;
  } catch {
    // Non-fatal
  }

  return undefined;
}

/**
 * Given a bin path (shim or symlink), trace to the dist/cli.js entry point.
 *
 * Windows: .cmd shim contains a line like `"%_prog%" "%dp0%\node_modules\brainclaw\dist\cli.js" %*`
 * Unix: bin is a symlink → resolve to real path → go up to package root → dist/cli.js
 */
function traceToCliJs(binPath: string): string | undefined {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    // Read the .cmd shim and extract the cli.js path
    const cmdPath = binPath.endsWith('.cmd') ? binPath : `${binPath}.cmd`;
    try {
      const content = fs.readFileSync(cmdPath, 'utf-8');
      // Match patterns like: "%dp0%\node_modules\brainclaw\dist\cli.js"
      const match = content.match(/%dp0%\\([^\s"]+cli\.js)/);
      if (match) {
        const shimDir = path.dirname(cmdPath);
        const cliJs = path.resolve(shimDir, match[1]!);
        if (fs.existsSync(cliJs)) return cliJs;
      }
    } catch {
      // Fall through
    }
  } else {
    // Unix: follow symlink chain to the real bin, then find cli.js
    try {
      const realBin = fs.realpathSync(binPath);
      // Typical layout: .../node_modules/.bin/brainclaw → ../brainclaw/dist/cli.js
      // Or: .../node_modules/brainclaw/dist/cli.js (direct)
      if (realBin.endsWith('cli.js') && fs.existsSync(realBin)) return realBin;

      // The bin stub typically lives at node_modules/brainclaw/dist/cli.js
      // or node_modules/.bin/brainclaw → ../brainclaw/dist/cli.js
      const packageRoot = findPackageRoot(realBin);
      if (packageRoot) {
        const cliJs = path.join(packageRoot, 'dist', 'cli.js');
        if (fs.existsSync(cliJs)) return cliJs;
      }
    } catch {
      // Fall through
    }
  }

  return undefined;
}

/** Walk up from a file to find the nearest directory containing package.json with name "brainclaw". */
function findPackageRoot(from: string): string | undefined {
  let dir = path.dirname(from);
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'brainclaw') return dir;
      }
    } catch { /* continue */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Cached MCP command — resolved once per process. */
let cachedMcpCommand: { command: string; args: string[] } | undefined;
function getBrainclawMcpCommand(): { command: string; args: string[] } {
  if (!cachedMcpCommand) {
    cachedMcpCommand = resolveBrainclawMcpCommand();
  }
  return cachedMcpCommand;
}

/** Reset the cached MCP command so it gets re-resolved on next access. */
export function resetMcpCommandCache(): void {
  cachedMcpCommand = undefined;
}

/** Module-level flag: when true, brainclawMcpEntry overwrites existing paths. */
let _forceResolve = false;

/**
 * Build a complete MCP server entry with relay model env injection.
 * Merges with the existing entry to preserve manual edits (e.g. custom command
 * path, additional env vars, extra args). Only sets defaults for missing fields.
 *
 * When `workspacePath` is provided, injects BRAINCLAW_CWD into the env so
 * the MCP server resolves the correct workspace root regardless of the IDE's
 * process.cwd() at launch time.
 */
function brainclawMcpEntry(agentName: string, existing?: unknown, workspacePath?: string): Record<string, unknown> {
  const defaults = getBrainclawMcpCommand();
  const ex = isJsonObject(existing) ? existing : {};
  const exEnv = isJsonObject(ex.env) ? ex.env : {};

  // When _forceResolve is true (post-upgrade), always use newly resolved paths.
  // Otherwise preserve existing command if it's an absolute path (manual edit).
  // CRITICAL: once we decide to preserve the command, we MUST also preserve
  // the args. Previously args was always overwritten, which silently clobbered
  // manual customizations (--cwd, --debug, etc.) and broke setups on DGX.
  // See trp#12 + pln#450.
  const useExisting = !_forceResolve && typeof ex.command === 'string' && ex.command !== 'npx';
  const existingArgs = Array.isArray(ex.args) ? (ex.args as unknown[]) : undefined;

  return {
    command: useExisting ? ex.command : defaults.command,
    args: useExisting && existingArgs ? existingArgs : defaults.args,
    // Merge env: preserve user-added vars, ensure BRAINCLAW_AGENT is set
    env: {
      ...exEnv,
      BRAINCLAW_AGENT: agentName,
      ...(workspacePath ? { BRAINCLAW_CWD: workspacePath } : {}),
    },
    // Preserve timeout if set
    ...(typeof ex.timeout === 'number' ? { timeout: ex.timeout } : {}),
  };
}

export const BRAINCLAW_SECTION_START = '<!-- brainclaw:start -->';
export const BRAINCLAW_SECTION_END = '<!-- brainclaw:end -->';

export function buildBrainclawSection(storageDir: string): string {
  return `${BRAINCLAW_SECTION_START}
## Brainclaw — shared project memory

This project uses brainclaw for shared coordination between humans and agents.

### Session start (required)

1. Run \`brainclaw context\` to load shared state (constraints, decisions, traps, plans, handoffs)
2. Check **Your open work** for active claims and in-progress plans assigned to you
3. Respect active claims from other agents — check \`brainclaw claim list\` before editing a claimed scope

### Before finishing (required)

1. Release claims you opened: \`brainclaw claim release <id>\` — or \`brainclaw session-end --auto-release\`
2. Update completed plan items: \`brainclaw plan update <id> --status done\`

### Recording work

\`\`\`bash
brainclaw memory create decision "<text>"          # record a decision
brainclaw memory create constraint "<text>"        # record an active constraint
brainclaw memory create trap "<text>"              # record a known trap
brainclaw claim create "<text>" --scope <path>     # claim a scope before editing
brainclaw plan create "<text>"                     # add a shared work item
\`\`\`

Memory is stored in \`${storageDir}/\`. Run \`brainclaw doctor\` to verify health.
${BRAINCLAW_SECTION_END}`;
}

export function buildHygieneSection(): string {
  return `## Brainclaw — required coordination

Before starting work:
1. Run \`brainclaw context\` (or \`brainclaw context --json\`) to load shared memory
2. Run \`brainclaw claim list\` — do not edit a file claimed by another agent
3. Create a plan for significant work: \`brainclaw plan create "<description>"\`
4. Claim files you will modify: \`brainclaw claim create "<description>" --scope <path>\`

Before finishing:
1. Run \`brainclaw session-end --auto-release\` — releases claims and updates plans
2. Or manually: \`brainclaw claim release <id>\` and \`brainclaw plan update <id> --status done\``;
}

export function hasBrainclawSection(content: string): boolean {
  return content.includes(BRAINCLAW_SECTION_START) && content.includes(BRAINCLAW_SECTION_END);
}

export function upsertBrainclawSection(existingContent: string, section: string): string {
  const start = existingContent.indexOf(BRAINCLAW_SECTION_START);
  const end = existingContent.indexOf(BRAINCLAW_SECTION_END);
  if (start !== -1 && end !== -1) {
    const before = existingContent.slice(0, start);
    const after = existingContent.slice(end + BRAINCLAW_SECTION_END.length);
    return before + section + after;
  }
  const trimmed = existingContent.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}

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

export function ensureAgentFiles(
  cwd: string,
  storageDir: string,
  options: EnsureAgentFilesOptions = {},
): EnsureAgentFilesResult {
  const section = buildBrainclawSection(storageDir);
  const result: EnsureAgentFilesResult = {
    agentsMdCreated: false,
    agentsMdUpdated: false,
    copilotInstructionsCreated: false,
    copilotInstructionsUpdated: false,
  };

  // AGENTS.md
  const agentsMdPath = path.join(cwd, 'AGENTS.md');
  const agentsMdExists = fs.existsSync(agentsMdPath);
  if (!options.onlyExisting || agentsMdExists) {
    const agentsMdContent = agentsMdExists
      ? fs.readFileSync(agentsMdPath, 'utf-8')
      : '# AGENTS\n\nProject guidelines for AI coding agents.\n';
    if (!options.requireExistingSection || !agentsMdExists || hasBrainclawSection(agentsMdContent)) {
      const newAgentsMd = upsertBrainclawSection(agentsMdContent, section);
      if (newAgentsMd !== agentsMdContent) {
        fs.writeFileSync(agentsMdPath, newAgentsMd, 'utf-8');
        if (agentsMdExists) {
          result.agentsMdUpdated = true;
        } else {
          result.agentsMdCreated = true;
        }
      }
    }
  }

  // .github/copilot-instructions.md
  const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
  const copilotExists = fs.existsSync(copilotPath);
  if (!options.onlyExisting || copilotExists) {
    const copilotContent = copilotExists
      ? fs.readFileSync(copilotPath, 'utf-8')
      : '# Copilot Instructions\n';
    if (!options.requireExistingSection || !copilotExists || hasBrainclawSection(copilotContent)) {
      if (!copilotExists) {
        fs.mkdirSync(path.dirname(copilotPath), { recursive: true });
      }
      const newCopilot = upsertBrainclawSection(copilotContent, section);
      if (newCopilot !== copilotContent) {
        fs.writeFileSync(copilotPath, newCopilot, 'utf-8');
        if (copilotExists) {
          result.copilotInstructionsUpdated = true;
        } else {
          result.copilotInstructionsCreated = true;
        }
      }
    }
  }

  return result;
}

export function ensureGitignoreEntries(cwd: string, entries: string[]): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const toAdd = entries.filter((e) => !lines.has(e));
  if (toAdd.length === 0) return;
  const separator = current.trimEnd().length > 0 ? '\n' : '';
  const next = `${current.trimEnd()}${separator}\n# Agent instruction files (generated by brainclaw)\n${toAdd.join('\n')}\n`;
  fs.writeFileSync(gitignorePath, next, 'utf-8');
}

export function collectWorkspaceGitignoreEntries(
  cwd: string,
  results: Array<Pick<AutoConfigWriteResult, 'filePath' | 'relativePath'>>,
): string[] {
  const workspaceRoot = path.resolve(cwd);
  const collected = new Set<string>();

  for (const result of results) {
    if (!result.relativePath) continue;
    if (result.relativePath === 'package.json') continue;
    if (result.relativePath === VSCODE_EXTENSIONS_RELATIVE_PATH) continue;

    const expectedWorkspacePath = path.resolve(workspaceRoot, result.relativePath);
    const actualPath = path.resolve(result.filePath);
    if (actualPath !== expectedWorkspacePath) continue;

    collected.add(result.relativePath.replace(/\\/g, '/'));
  }

  return [...collected];
}

export function collectExportGitignoreEntries(
  cwd: string,
  targetRelativePath: string,
  results: Array<Pick<AutoConfigWriteResult, 'filePath' | 'relativePath'>>,
  options: { includeTarget?: boolean } = {},
): string[] {
  const collected = new Set<string>();

  if (options.includeTarget !== false) {
    collected.add(targetRelativePath.replace(/\\/g, '/'));
  }

  for (const entry of collectWorkspaceGitignoreEntries(cwd, results)) {
    collected.add(entry);
  }

  return [...collected];
}

// --- Agent export target registry ---

export type ExportFormat =
  | 'copilot-instructions'
  | 'cursor-rules'
  | 'agents-md'
  | 'claude-md'
  | 'windsurf'
  | 'cline'
  | 'roo'
  | 'kilocode'
  | 'continue'
  | 'gemini-md'
  | 'board-md'
  | 'openclaw'
  | 'nanoclaw'
  | 'nemoclaw'
  | 'picoclaw'
  | 'zeroclaw';

export interface AgentExportTarget {
  agentName: string;
  format: ExportFormat;
  /** Path to write, relative to project root */
  relativePath: string;
}

export const AGENT_EXPORT_REGISTRY: AgentExportTarget[] = [
  { agentName: 'github-copilot', format: 'copilot-instructions', relativePath: '.github/copilot-instructions.md' },
  { agentName: 'claude-code',    format: 'claude-md',            relativePath: 'CLAUDE.md' },
  { agentName: 'cursor',         format: 'cursor-rules',         relativePath: '.cursor/rules/brainclaw.md' },
  { agentName: 'windsurf',       format: 'windsurf',             relativePath: '.windsurfrules' },
  { agentName: 'cline',          format: 'cline',                relativePath: '.clinerules/brainclaw.md' },
  { agentName: 'codex',          format: 'agents-md',            relativePath: 'AGENTS.md' },
  { agentName: 'continue',       format: 'continue',             relativePath: '.continue/rules/brainclaw.md' },
  { agentName: 'roo',            format: 'roo',                  relativePath: '.roo/rules/brainclaw.md' },
  { agentName: 'kilocode',       format: 'kilocode',             relativePath: '.kilo/rules/brainclaw.md' },
  { agentName: 'opencode',       format: 'agents-md',            relativePath: 'AGENTS.md' },
  { agentName: 'antigravity',    format: 'gemini-md',            relativePath: 'GEMINI.md' },
  { agentName: 'brainclaw',      format: 'board-md',             relativePath: 'BOARD.md' },
  { agentName: 'openclaw',       format: 'openclaw',             relativePath: 'skills/openclaw/SKILL.md' },
  { agentName: 'nanoclaw',       format: 'nanoclaw',             relativePath: 'skills/nanoclaw/SKILL.md' },
  { agentName: 'nemoclaw',       format: 'nemoclaw',             relativePath: 'skills/nemoclaw/SKILL.md' },
  { agentName: 'picoclaw',       format: 'picoclaw',             relativePath: 'skills/picoclaw/SKILL.md' },
  { agentName: 'zeroclaw',       format: 'zeroclaw',             relativePath: 'skills/zeroclaw/SKILL.md' },
];

export const FALLBACK_EXPORT_TARGET: AgentExportTarget = {
  agentName: 'unknown',
  format: 'agents-md',
  relativePath: 'AGENTS.md',
};

export function resolveExportTarget(agentName: string): AgentExportTarget {
  return AGENT_EXPORT_REGISTRY.find((t) => t.agentName === agentName) ?? FALLBACK_EXPORT_TARGET;
}

export function resolveExportTargetByFormat(format: ExportFormat): AgentExportTarget {
  return AGENT_EXPORT_REGISTRY.find((t) => t.format === format) ?? FALLBACK_EXPORT_TARGET;
}

export function writeExportFile(
  content: string,
  relativePath: string,
  cwd: string,
): { created: boolean; updated: boolean; filePath: string } {
  const fullPath = path.join(cwd, relativePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(fullPath);
  const section = `${BRAINCLAW_SECTION_START}\n${content}\n${BRAINCLAW_SECTION_END}`;
  const existing = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
  const next = upsertBrainclawSection(existing, section);
  if (next === existing) {
    return { created: false, updated: false, filePath: fullPath };
  }
  fs.writeFileSync(fullPath, next, 'utf-8');
  return { created: !existed, updated: existed, filePath: fullPath };
}

export interface AutoConfigWriteResult {
  kind: 'mcp' | 'skill' | 'rule' | 'recommendation' | 'permissions';
  label: string;
  created: boolean;
  updated: boolean;
  filePath: string;
  relativePath?: string;
}

type JsonObject = Record<string, unknown>;

/**
 * Returns the narrowed list of brainclaw MCP tool names that are safe for
 * headless auto-approval. Sourced from MCP_HEADLESS_AUTO_TOOL_NAMES (the
 * subset of ALL_TOOLS with headlessApproval === 'auto'), so the list
 * auto-updates when tools are added/removed in src/commands/mcp.ts — no
 * manual sync required.
 *
 * Excluded: dispatch, architectural gates (accept/reject), plan/sequence
 * creation, setup, switch, bootstrap, release_notes, memory deletes, and
 * other operations that warrant human review.
 *
 * IMPORTANT: Accessed lazily (not at module init) to avoid a circular-import
 * TDZ error — this module ← commands/session-start ← commands/mcp cycles back
 * into commands/mcp. Calling at runtime (inside writer functions) is always
 * safe because by then all modules are fully initialized.
 *
 * Consumed by:
 *  - Cline `autoApprove` (.vscode/cline_mcp_settings.json)
 *  - Roo `alwaysAllow` (.roo/mcp.json)
 *  - Codex `[mcp_servers.brainclaw.tools.<name>] approval_mode = "approve"`
 *    (~/.codex/config.toml) — required for headless codex exec (non-interactive
 *    approval mode cancels MCP writes by default; explicit per-tool
 *    `approval_mode = "approve"` bypasses this).
 */
function getHeadlessAutoApprovedToolNames(): string[] {
  // Filter out tools removed at v1.0 — their handlers still exist as a
  // migration escape hatch, but we don't want to advertise them in agent
  // configs anymore. Otherwise Codex / Cline / Roo still discover names
  // like `bclaw_get_context`, `bclaw_list_plans`, etc. and dispatch to
  // deprecation warnings instead of the canonical grammar (pln#397 Codex
  // post-alignment audit).
  return MCP_HEADLESS_AUTO_TOOL_NAMES.filter((name) => !REMOVED_IN_V1_TOOLS.has(name));
}

const CLINE_MCP_RELATIVE_PATH = '.vscode/cline_mcp_settings.json';
const CURSOR_MDC_RELATIVE_PATH = '.cursor/rules/brainclaw-mcp-shim.mdc';
const COPILOT_SKILL_RELATIVE_PATH = '.github/skills/brainclaw-context/SKILL.md';
const COPILOT_MCP_RELATIVE_PATH = '.vscode/settings.json';
const VSCODE_MCP_RELATIVE_PATH = '.vscode/mcp.json';
const WINDSURF_MCP_RELATIVE_PATH = '.codeium/windsurf/mcp_config.json';
const WINDSURF_MODERN_RULES_RELATIVE_PATH = '.windsurf/rules/brainclaw.md';
const CLAUDE_CODE_MCP_RELATIVE_PATH = '.mcp.json';
const CLAUDE_CODE_COMMAND_RELATIVE_PATH = '.claude/commands/brainclaw.md';
const CLAUDE_CODE_SETTINGS_RELATIVE_PATH = '.claude/settings.local.json';
const CLAUDE_CODE_SESSION_MARKER_RELATIVE_PATH = '.claude/.bclaw-session';
const CURSOR_MCP_RELATIVE_PATH = '.cursor/mcp.json';
const ROO_MCP_RELATIVE_PATH = '.roo/mcp.json';
const KILOCODE_MCP_RELATIVE_PATH = '.kilo/mcp.json';
const KILOCODE_CONFIG_RELATIVE_PATH = 'kilo.jsonc';
const CONTINUE_CONFIG_RELATIVE_PATH = '.continue/config.json';
const CONTINUE_PERMISSIONS_RELATIVE_PATH = '.continue/permissions.yaml';
const OPENCODE_CONFIG_RELATIVE_PATH = 'opencode.json';
const ANTIGRAVITY_MCP_RELATIVE_PATH = '.gemini/antigravity/mcp_config.json';
const ANTIGRAVITY_HOOKS_RELATIVE_PATH = '.gemini/antigravity/hooks.json';
const CURSOR_HOOKS_RELATIVE_PATH = '.cursor/hooks.json';
const COPILOT_HOOKS_RELATIVE_PATH = '.github/copilot/hooks.json';
const OPENCLAW_MCP_RELATIVE_PATH = '.openclaw/mcp.json';
const VSCODE_EXTENSIONS_RELATIVE_PATH = '.vscode/extensions.json';
const UNIVERSAL_SKILL_RELATIVE_PATH = '.agents/skills/brainclaw/SKILL.md';

/**
 * Directories exclusively managed by brainclaw — safe to gitignore as a whole.
 * Individual files in these directories don't need separate gitignore entries.
 */
export const BRAINCLAW_EXCLUSIVE_DIRECTORIES = [
  '.roo/',
  '.kilo/',
  '.continue/',
  '.codeium/windsurf/',
  '.gemini/antigravity/',
  '.github/skills/brainclaw-context/',
] as const;

export const LOCAL_ONLY_AGENT_WORKSPACE_FILES = [
  CLINE_MCP_RELATIVE_PATH,
  CURSOR_MDC_RELATIVE_PATH,
  CURSOR_MCP_RELATIVE_PATH,
  COPILOT_SKILL_RELATIVE_PATH,
  COPILOT_MCP_RELATIVE_PATH,
  VSCODE_MCP_RELATIVE_PATH,
  CLAUDE_CODE_MCP_RELATIVE_PATH,
  CLAUDE_CODE_COMMAND_RELATIVE_PATH,
  CLAUDE_CODE_SETTINGS_RELATIVE_PATH,
  CLAUDE_CODE_SESSION_MARKER_RELATIVE_PATH,
  ROO_MCP_RELATIVE_PATH,
  KILOCODE_MCP_RELATIVE_PATH,
  KILOCODE_CONFIG_RELATIVE_PATH,
  CONTINUE_CONFIG_RELATIVE_PATH,
  OPENCODE_CONFIG_RELATIVE_PATH,
  WINDSURF_MCP_RELATIVE_PATH,
  WINDSURF_MODERN_RULES_RELATIVE_PATH,
  ANTIGRAVITY_MCP_RELATIVE_PATH,
] as const;

export interface AgentGitHygieneAudit {
  isGitRepo: boolean;
  auditedPaths: string[];
  presentPaths: string[];
  ignoredPaths: string[];
  missingGitignorePaths: string[];
  trackedPaths: string[];
  hasIssues: boolean;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): JsonObject {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readJsoncObject(filePath: string): JsonObject {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
    const parsed = JSON.parse(withoutLineComments);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeTextFileIfChanged(filePath: string, content: string): { created: boolean; updated: boolean } {
  const existed = fs.existsSync(filePath);
  const current = existed ? fs.readFileSync(filePath, 'utf-8') : undefined;
  if (current === content) {
    return { created: false, updated: false };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return { created: !existed, updated: existed };
}

function writeJsonFileIfChanged(filePath: string, next: JsonObject): { created: boolean; updated: boolean } {
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  return writeTextFileIfChanged(filePath, serialized);
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

function runGit(cwd: string, args: string[], input?: string): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    input,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? '',
    };
  }

  return {
    ok: true,
    stdout: result.stdout ?? '',
  };
}

export function auditLocalAgentWorkspaceFiles(cwd: string): AgentGitHygieneAudit {
  const auditedPaths = [...LOCAL_ONLY_AGENT_WORKSPACE_FILES];
  const presentPaths = auditedPaths
    .filter((relativePath) => fs.existsSync(path.join(cwd, relativePath)))
    .map((relativePath) => relativePath.replace(/\\/g, '/'));

  const gitRepoCheck = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!gitRepoCheck.ok || gitRepoCheck.stdout.trim() !== 'true') {
    return {
      isGitRepo: false,
      auditedPaths,
      presentPaths,
      ignoredPaths: [],
      missingGitignorePaths: [],
      trackedPaths: [],
      hasIssues: false,
    };
  }

  if (presentPaths.length === 0) {
    return {
      isGitRepo: true,
      auditedPaths,
      presentPaths,
      ignoredPaths: [],
      missingGitignorePaths: [],
      trackedPaths: [],
      hasIssues: false,
    };
  }

  const ignoredResult = runGit(cwd, ['check-ignore', '--no-index', '--stdin'], `${presentPaths.join('\n')}\n`);
  const ignoredPaths = ignoredResult.ok
    ? ignoredResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const ignoredSet = new Set(ignoredPaths);

  const trackedResult = runGit(cwd, ['ls-files', '--', ...presentPaths]);
  const trackedPaths = trackedResult.ok
    ? trackedResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/\\/g, '/'))
    : [];

  const missingGitignorePaths = presentPaths.filter((relativePath) => !ignoredSet.has(relativePath));

  return {
    isGitRepo: true,
    auditedPaths,
    presentPaths,
    ignoredPaths,
    missingGitignorePaths,
    trackedPaths,
    hasIssues: missingGitignorePaths.length > 0 || trackedPaths.length > 0,
  };
}

export function describeAutoConfigWrite(result: AutoConfigWriteResult): string | undefined {
  if (!result.created && !result.updated) {
    return undefined;
  }

  const verb = result.created ? 'Created' : 'Updated';
  const displayPath = result.relativePath ?? result.filePath;
  return `✔ ${verb} ${result.label} at ${displayPath}`;
}

export function buildClaudeCodeCommandText(): string {
  return `Load brainclaw project memory and prepare for coordinated work.

Steps:
1. Run \`brainclaw context --json\` — load constraints, decisions, traps, plans, handoffs
2. Run \`brainclaw claim list\` — check what files other agents have claimed
3. Before editing any file, run \`brainclaw claim create "<description>" --scope <path>\`
4. Before finishing, run \`brainclaw session-end --auto-release\`
`;
}

export function ensureClineMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.vscode', 'cline_mcp_settings.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = {
    ...brainclawMcpEntry('cline', mcpServers.brainclaw, cwd),
    disabled: false,
    autoApprove: getHeadlessAutoApprovedToolNames(),
  };

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Cline MCP settings',
    created,
    updated,
    filePath,
    relativePath: CLINE_MCP_RELATIVE_PATH,
  };
}

export function ensureWindsurfMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) {
    return undefined;
  }

  const filePath = path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = {
    ...brainclawMcpEntry('windsurf', mcpServers.brainclaw),
    alwaysAllow: getHeadlessAutoApprovedToolNames(),
  };

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Windsurf MCP settings',
    created,
    updated,
    filePath,
    relativePath: WINDSURF_MCP_RELATIVE_PATH,
  };
}

/**
 * Writes `.windsurf/rules/brainclaw.md` — the modern Windsurf rules format
 * (Wave 8+). Instructs Windsurf's Cascade to load brainclaw context and follow
 * the coordination protocol before any significant code change.
 *
 * Unlike `.windsurfrules` (legacy), this file is workspace-scoped and supports
 * the per-file rule activation model. Kept alongside `.windsurfrules` for
 * backward compatibility.
 */
export function ensureWindsurfModernRules(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, WINDSURF_MODERN_RULES_RELATIVE_PATH);
  const content = `# Brainclaw coordination rules

Brainclaw is the shared coordination layer. Use its MCP facades first — the CLI is only a fallback when MCP is unavailable.

## Session start

Call \`bclaw_work(intent)\`. It loads memory (constraints, decisions, traps, plans, handoffs), resolves the claim, and starts a session in a single call.

- \`bclaw_work(intent: "resume")\` — continue existing work (auto-surfaces the context diff).
- \`bclaw_work(intent: "execute", scope: "<path>", task: "<text>")\` — start new work and claim the scope.
- \`bclaw_work(intent: "consult")\` — read-only context without claiming.

## During work

- Mark plan steps done: \`bclaw_complete_step(planId, stepId)\`.
- Read the inbox: \`bclaw_read_inbox\`.
- Record notes, decisions, traps: \`bclaw_write_note\`, \`bclaw_create(entity, data)\`.

## To coordinate with other agents

\`bclaw_coordinate(intent)\` — \`assign\`, \`consult\`, \`review\`, or \`reroute\`.

## Before finishing

- Release your claims: \`bclaw_release_claim(id)\`.
- Close the session: \`bclaw_session_end\` (auto-releases remaining claims).

CLI fallback only when MCP is unavailable: \`brainclaw context\` / \`brainclaw session-end --auto-release\`.
`;
  const { created, updated } = writeTextFileIfChanged(filePath, content);

  return {
    kind: 'rule',
    label: 'Windsurf modern rules (.windsurf/rules/brainclaw.md)',
    created,
    updated,
    filePath,
    relativePath: WINDSURF_MODERN_RULES_RELATIVE_PATH,
  };
}

export function ensureCopilotSkill(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.github', 'skills', 'brainclaw-context', 'SKILL.md');
  const content = `---
name: brainclaw-context
description: "Use this skill when you need the latest Brainclaw context, active plans, constraints, traps, or handoffs before coding. Trigger phrases: refresh project memory, load brainclaw context, inspect active plans, inspect constraints."
---

# Brainclaw Context

Fetch live project memory before significant edits. Prefer the Brainclaw MCP facade; use the CLI only as a fallback when MCP is unavailable.

## Steps

1. Call \`bclaw_work(intent: "resume")\` to continue existing work, or \`bclaw_work(intent: "consult")\` for read-only context. The response contains active plans, constraints, decisions, traps, and handoffs.
2. Prefer Brainclaw state over stale assumptions from older instructions or prior sessions.
3. Coordinate with other agents via \`bclaw_coordinate(intent)\` (\`assign\`, \`consult\`, \`review\`).

CLI fallback: \`brainclaw context --json\` if the MCP server is not reachable.
`;
  const { created, updated } = writeTextFileIfChanged(filePath, content);

  return {
    kind: 'skill',
    label: 'Copilot Brainclaw skill',
    created,
    updated,
    filePath,
    relativePath: COPILOT_SKILL_RELATIVE_PATH,
  };
}

/**
 * Write .agents/skills/brainclaw/SKILL.md — universal cross-agent skill.
 * Auto-discovered by Cursor, Copilot, Roo, OpenCode, Codex, Kilo, and Mistral
 * via their shared .agents/skills/ path convention. Single writer, 7 agents,
 * zero per-agent branching.
 *
 * Ref: surfaces_audit_2026_04_15.md (feedback_cross_agent_patterns rule #3).
 */
export function ensureUniversalBrainclawSkill(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, UNIVERSAL_SKILL_RELATIVE_PATH);
  const content = `---
name: brainclaw
description: 'Load and act on Brainclaw project memory, active claims, plans, traps, and handoffs before code changes. Trigger: refresh brainclaw context, check active claims, load coordination state.'
allowed-tools: 'Read Bash(npx brainclaw:*)'
---

# Brainclaw

Load the shared coordination state before any significant code change. Prefer the Brainclaw MCP facade; the CLI is a fallback when MCP is not reachable.

## Steps

1. Call \`bclaw_work(intent)\` — \`resume\` to continue existing work, \`execute\` to claim a new scope, or \`consult\` for read-only context. The response gives you memory, active claims, plans, traps, and handoffs.
2. Respect active claims from other agents reported in the response; do not edit a claimed scope unless you own the claim.
3. Use \`bclaw_coordinate(intent)\` to assign, consult, or review other agents when needed.
4. When done, call \`bclaw_session_end\` (auto-releases your remaining claims).

CLI fallback only: \`brainclaw context --json\` / \`brainclaw claim create\` / \`brainclaw session-end --auto-release\` if the MCP server is unavailable.
`;
  const { created, updated } = writeTextFileIfChanged(filePath, content);

  return {
    kind: 'skill',
    label: 'Universal Brainclaw skill (.agents/skills/brainclaw/SKILL.md)',
    created,
    updated,
    filePath,
    relativePath: UNIVERSAL_SKILL_RELATIVE_PATH,
  };
}

export function ensureCopilotMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.vscode', 'settings.json');
  const existing = readJsonObject(filePath);
  const copilotMcpKey = 'github.copilot.chat.mcpServers';
  const mcpServers = isJsonObject(existing[copilotMcpKey]) ? { ...(existing[copilotMcpKey] as Record<string, unknown>) } : {};
  mcpServers.brainclaw = brainclawMcpEntry('github-copilot', mcpServers.brainclaw, cwd);

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    [copilotMcpKey]: mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Copilot MCP settings (.vscode/settings.json)',
    created,
    updated,
    filePath,
    relativePath: COPILOT_MCP_RELATIVE_PATH,
  };
}

/**
 * Write .vscode/mcp.json — the VS Code-native universal MCP config.
 * Works for Copilot, Claude Code (VS Code extension), and any MCP-consuming
 * VS Code extension. Uses the { servers: { ... } } format.
 */
export function ensureVscodeMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.vscode', 'mcp.json');
  const existing = readJsonObject(filePath);
  const servers = isJsonObject(existing.servers) ? { ...existing.servers } : {};
  servers.brainclaw = brainclawMcpEntry('github-copilot', servers.brainclaw, cwd);

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    servers,
  });

  return {
    kind: 'mcp',
    label: 'VS Code MCP config (.vscode/mcp.json)',
    created,
    updated,
    filePath,
    relativePath: VSCODE_MCP_RELATIVE_PATH,
  };
}

const BRAINCLAW_EXTENSION_ID = 'brainclaw.brainclaw-vscode';

export function ensureVscodeExtensionRecommendation(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.vscode', 'extensions.json');
  const existing = readJsonObject(filePath);
  const recommendations: string[] = Array.isArray(existing.recommendations)
    ? [...existing.recommendations as string[]]
    : [];

  if (!recommendations.includes(BRAINCLAW_EXTENSION_ID)) {
    recommendations.push(BRAINCLAW_EXTENSION_ID);
  }

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    recommendations,
  });

  return {
    kind: 'recommendation',
    label: 'VS Code extension recommendation (.vscode/extensions.json)',
    created,
    updated,
    filePath,
    relativePath: VSCODE_EXTENSIONS_RELATIVE_PATH,
  };
}

export function ensureCursorMdc(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.cursor', 'rules', 'brainclaw-mcp-shim.mdc');
  const content = `---
description: Use this rule when work depends on live Brainclaw memory or active project rules.
globs: "**/*"
alwaysApply: true
---

Brainclaw is the shared coordination layer. Call the MCP facade first; the CLI is only a fallback when MCP is not reachable.

Before significant edits or when asked about project rules, call \`bclaw_work(intent: "consult")\` (or \`"resume"\` if continuing a task) via the Brainclaw MCP server. The response carries active claims, in-progress plans, constraints, decisions, traps, and handoffs.

If the response lists active claims or in-progress plans, follow them before editing. Use \`bclaw_coordinate(intent)\` to dispatch, consult, or review other agents.

CLI fallback only when MCP is unavailable: \`brainclaw context --json\`.
`;
  const { created, updated } = writeTextFileIfChanged(filePath, content);

  return {
    kind: 'rule',
    label: 'Cursor imperative Brainclaw rule',
    created,
    updated,
    filePath,
    relativePath: CURSOR_MDC_RELATIVE_PATH,
  };
}

function buildCommandHookEntry(command: string): JsonObject {
  return {
    matcher: '',
    hooks: [{ type: 'command', command }],
  };
}

function buildMatchedCommandHookEntry(matcher: string, command: string): JsonObject {
  return {
    matcher,
    hooks: [{ type: 'command', command }],
  };
}

function containsCommandHook(entries: unknown[], command: string): boolean {
  return entries.some(
    (entry) =>
      isJsonObject(entry) &&
      Array.isArray(entry.hooks) &&
      (entry.hooks as unknown[]).some(
        (h) => isJsonObject(h) && h.command === command,
      ),
  );
}

/**
 * Replace a legacy command hook with a new one, or add the new one if neither exists.
 * This enables clean upgrades: old hooks are swapped out, new hooks are added if fresh.
 */
function replaceOrAddCommandHook(entries: unknown[], newCommand: string, legacyCommand: string): void {
  if (containsCommandHook(entries, newCommand)) return;

  // Find and replace legacy command
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (isJsonObject(entry) && Array.isArray(entry.hooks)) {
      for (const h of entry.hooks as unknown[]) {
        if (isJsonObject(h) && h.command === legacyCommand) {
          h.command = newCommand;
          return;
        }
      }
    }
  }

  // Neither new nor legacy found — add fresh
  entries.push(buildCommandHookEntry(newCommand));
}

/**
 * Replace a hook matching any of the legacy patterns, or add fresh.
 * Used for hooks where the command string changes across versions.
 */
function replaceOrAddCommandHookByPattern(entries: unknown[], newCommand: string, legacyPatterns: string[]): void {
  // Already present with the exact new command
  if (entries.some(entry =>
    isJsonObject(entry) && Array.isArray(entry.hooks) &&
    (entry.hooks as unknown[]).some(h => isJsonObject(h) && typeof h.command === 'string' && h.command === newCommand)
  )) return;

  // Find and replace any entry containing a legacy pattern substring
  for (const entry of entries) {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks as unknown[]) {
      if (!isJsonObject(h) || typeof h.command !== 'string') continue;
      if (legacyPatterns.some(p => (h.command as string).includes(p))) {
        h.command = newCommand;
        return;
      }
    }
  }

  // No match — add fresh
  entries.push(buildCommandHookEntry(newCommand));
}

export function ensureProjectDevDependency(cwd: string): AutoConfigWriteResult | undefined {
  const filePath = path.join(cwd, 'package.json');
  if (!fs.existsSync(filePath)) return undefined;

  let pkg: JsonObject;
  try {
    pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as JsonObject;
  } catch {
    return undefined;
  }

  // Skip if this IS the brainclaw package itself
  if (pkg.name === 'brainclaw') return undefined;

  const devDeps = isJsonObject(pkg.devDependencies) ? { ...pkg.devDependencies } : {};
  if (devDeps['brainclaw']) return undefined;

  devDeps['brainclaw'] = 'latest';
  const next = { ...pkg, devDependencies: devDeps };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n', 'utf-8');

  return {
    kind: 'rule',
    label: 'brainclaw devDependency (enables npx brainclaw without global PATH)',
    created: true,
    updated: false,
    filePath,
    relativePath: 'package.json',
  };
}

export function ensureClaudeCodeMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.mcp.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = brainclawMcpEntry('claude-code', mcpServers.brainclaw, cwd);

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Claude Code MCP server',
    created,
    updated,
    filePath,
    relativePath: CLAUDE_CODE_MCP_RELATIVE_PATH,
  };
}

export function ensureClaudeCodeCommand(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.claude', 'commands', 'brainclaw.md');
  const content = buildClaudeCodeCommandText();
  const { created, updated } = writeTextFileIfChanged(filePath, content);

  return {
    kind: 'skill',
    label: 'Claude Code brainclaw command',
    created,
    updated,
    filePath,
    relativePath: CLAUDE_CODE_COMMAND_RELATIVE_PATH,
  };
}

export function ensureClaudeCodeUserSettings(homeDir: string | undefined, env: NodeJS.ProcessEnv = process.env): AutoConfigWriteResult | undefined {
  if (!homeDir) return undefined;

  const filePath = path.join(homeDir, '.claude', 'settings.json');
  const existing = readJsonObject(filePath);

  // MCP server
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = brainclawMcpEntry('claude-code', mcpServers.brainclaw);

  // Permissions
  const permissions = isJsonObject(existing.permissions) ? { ...existing.permissions } : {};
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow as string[]] : [];
  if (!allow.includes('Bash(npx brainclaw:*)')) allow.push('Bash(npx brainclaw:*)');
  if (!allow.includes('mcp__brainclaw__*')) allow.push('mcp__brainclaw__*');
  permissions.allow = allow;

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
    permissions,
  });

  return {
    kind: 'mcp',
    label: 'Claude Code user settings — MCP + permissions (global, all projects)',
    created,
    updated,
    filePath,
  };
}

export function ensureClaudeCodeUserCommand(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) return undefined;

  const filePath = path.join(homeDir, '.claude', 'commands', 'brainclaw.md');
  const content = buildClaudeCodeCommandText();
  const { created, updated } = writeTextFileIfChanged(filePath, content);

  return {
    kind: 'skill',
    label: 'Claude Code brainclaw command (global, all projects)',
    created,
    updated,
    filePath,
  };
}

export function ensureClaudeCodeSettings(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.claude', 'settings.local.json');
  const existing = readJsonObject(filePath);

  // Merge permissions.allow
  const permissions = isJsonObject(existing.permissions) ? { ...existing.permissions } : {};
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow as string[]] : [];
  if (!allow.includes('Bash(npx brainclaw:*)')) {
    allow.push('Bash(npx brainclaw:*)');
  }
  if (!allow.includes('mcp__brainclaw__*')) {
    allow.push('mcp__brainclaw__*');
  }
  permissions.allow = allow;

  // Ensure worktree base directories are in additionalDirectories
  // so dispatched sub-agents can Edit/Write files in their worktrees
  const additionalDirs = Array.isArray(permissions.additionalDirectories)
    ? [...permissions.additionalDirectories as string[]]
    : [];
  const worktreeDirs = [
    path.join(cwd, '.claude', 'worktrees'),           // Claude Code Agent tool worktrees
    path.join(os.homedir(), '.brainclaw', 'worktrees'), // brainclaw claim worktrees
  ];
  for (const dir of worktreeDirs) {
    const normalized = dir.replace(/\\/g, '/');
    if (!additionalDirs.some(d => (d as string).replace(/\\/g, '/') === normalized)) {
      additionalDirs.push(dir);
    }
  }
  permissions.additionalDirectories = additionalDirs;

  // Merge hooks — UserPromptSubmit opens a session on first prompt, diff on subsequent
  const hooks = isJsonObject(existing.hooks) ? { ...existing.hooks } : {};
  const mcpCmd = getBrainclawMcpCommand();
  // For shell hooks, normalize Windows backslashes to forward slashes and quote if needed
  const bclawBin = mcpCmd.command === 'npx'
    ? 'npx brainclaw'
    : `"${mcpCmd.command.replace(/\\/g, '/')}"`;
  const sessionCommand = `f=.claude/.bclaw-session; if [ ! -f "$f" ]; then touch "$f"; ${bclawBin} session-start --include-context 2>/dev/null; else ${bclawBin} context-diff 2>/dev/null; fi`;
  const stopCommand = `rm -f .claude/.bclaw-session; ${bclawBin} session-end --auto-release --reflect --reflect-handoff --dispatch-review 2>/dev/null`;

  // Legacy commands to replace on upgrade (substring patterns to match old hooks)
  const legacyPatterns = [
    'brainclaw context 2>/dev/null',
    'brainclaw session-start --include-context 2>/dev/null',
    'brainclaw session-end --auto-release',
    'brainclaw context-diff 2>/dev/null',
  ];

  const userPromptHooks = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit as unknown[]] : [];
  replaceOrAddCommandHookByPattern(userPromptHooks, sessionCommand, legacyPatterns);
  hooks.UserPromptSubmit = userPromptHooks;

  const stopHooks = Array.isArray(hooks.Stop) ? [...hooks.Stop as unknown[]] : [];
  replaceOrAddCommandHookByPattern(stopHooks, stopCommand, legacyPatterns);
  hooks.Stop = stopHooks;

  // PostToolUse — check for unseen events after any brainclaw MCP tool call
  const checkEventsCommand = `${bclawBin} check-events 2>/dev/null`;
  const postToolHooks = Array.isArray(hooks.PostToolUse) ? [...hooks.PostToolUse as unknown[]] : [];
  replaceOrAddCommandHookByPattern(postToolHooks, checkEventsCommand, ['npx brainclaw check-events']);
  // Preserve matcher for PostToolUse — only fire on brainclaw MCP tool calls
  for (const entry of postToolHooks) {
    if (isJsonObject(entry) && Array.isArray(entry.hooks) &&
      (entry.hooks as unknown[]).some(h => isJsonObject(h) && typeof h.command === 'string' && (h.command as string).includes('check-events'))) {
      entry.matcher = 'mcp__brainclaw__';
    }
  }
  hooks.PostToolUse = postToolHooks;

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    permissions,
    hooks,
  });

  return {
    kind: 'rule',
    label: 'Claude Code settings (permissions + session hooks)',
    created,
    updated,
    filePath,
    relativePath: CLAUDE_CODE_SETTINGS_RELATIVE_PATH,
  };
}

export function ensureCursorMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) {
    return undefined;
  }

  const filePath = path.join(homeDir, '.cursor', 'mcp.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = brainclawMcpEntry('cursor', mcpServers.brainclaw);

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Cursor MCP settings',
    created,
    updated,
    filePath,
    relativePath: CURSOR_MCP_RELATIVE_PATH,
  };
}

export function ensureRooMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.roo', 'mcp.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = {
    ...brainclawMcpEntry('roo', mcpServers.brainclaw, cwd),
    alwaysAllow: getHeadlessAutoApprovedToolNames(),
  };

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Roo Code MCP settings',
    created,
    updated,
    filePath,
    relativePath: ROO_MCP_RELATIVE_PATH,
  };
}

export function ensureKilocodeConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, KILOCODE_CONFIG_RELATIVE_PATH);
  const existing = readJsoncObject(filePath);
  const permission = isJsonObject(existing.permission) ? { ...existing.permission } : {};
  permission.external_directory = 'deny';

  const { created, updated } = writeTextFileIfChanged(
    filePath,
    `${JSON.stringify({ ...existing, permission }, null, 2)}\n`,
  );

  return {
    kind: 'permissions',
    label: 'Kilo Code permissions (kilo.jsonc)',
    created,
    updated,
    filePath,
    relativePath: KILOCODE_CONFIG_RELATIVE_PATH,
  };
}

export function ensureKilocodeMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.kilo', 'mcp.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = {
    ...brainclawMcpEntry('kilocode', mcpServers.brainclaw, cwd),
    alwaysAllow: getHeadlessAutoApprovedToolNames(),
  };

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Kilo Code MCP settings',
    created,
    updated,
    filePath,
    relativePath: KILOCODE_MCP_RELATIVE_PATH,
  };
}

export function ensureCodexMcpConfig(homeDir: string | undefined, env: NodeJS.ProcessEnv = process.env): AutoConfigWriteResult | null {
  const codexHome = env.CODEX_HOME?.trim() || (homeDir ? path.join(homeDir, '.codex') : null);
  if (!codexHome) return null;

  const filePath = path.join(codexHome, 'config.toml');
  const mcpCmd = getBrainclawMcpCommand();

  // Normalize all paths to forward slashes so TOML backslash escapes don't
  // corrupt the file on Windows (e.g. \U would be an invalid unicode escape).
  const normalizedCommand = mcpCmd.command.replace(/\\/g, '/');
  const normalizedArgs = mcpCmd.args.map(a => a.replace(/\\/g, '/'));

  const brainclawBlock = [
    '\n[mcp_servers.brainclaw]',
    `command = "${normalizedCommand}"`,
    `args = [${normalizedArgs.map(a => `"${a}"`).join(', ')}]`,
    'startup_timeout_ms = 20000',
    '',
    '[mcp_servers.brainclaw.env]',
    'BRAINCLAW_AGENT = "codex"',
    '# BRAINCLAW_CWD is set per-workspace via brainclaw init; override here if needed',
  ].join('\n');

  // Per-tool approval_mode blocks — required so codex exec in headless mode
  // auto-approves brainclaw MCP writes (e.g. bclaw_assignment_update). Without
  // these, codex falls back to the default "prompt" approval and cancels the
  // call because no human can answer in non-interactive mode.
  //
  // Only the headless-safe subset is written here (tools with headlessApproval='auto').
  // Sensitive tools (dispatch, accept, reject, create_plan, setup, switch, bootstrap,
  // memory deletes, etc.) are intentionally absent so codex must prompt before using them.
  const MACHINE_MANAGED_HEADER =
    '# ===========================================================\n' +
    '# MACHINE-MANAGED — DO NOT EDIT\n' +
    '# Generated by `brainclaw setup`. Changes will be overwritten\n' +
    '# on the next setup run. Only headless-safe tools are listed.\n' +
    '# Sensitive tools (dispatch, accept, reject, create_plan, etc.)\n' +
    '# are intentionally absent — codex will prompt before using them.\n' +
    '# ===========================================================';
  const toolsBlock = '\n' + MACHINE_MANAGED_HEADER + '\n' + getHeadlessAutoApprovedToolNames().map((tool) =>
    `[mcp_servers.brainclaw.tools.${tool}]\napproval_mode = "approve"`,
  ).join('\n\n') + '\n';

  let existing = '';
  let fileExisted = false;
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf-8');
    fileExisted = true;
  }

  // Before writing: detect existing tool sections that are outside the catalog
  // or have a non-"approve" approval_mode, and warn the user.
  if (fileExisted && existing.length > 0) {
    const autoApprovedSet = new Set(getHeadlessAutoApprovedToolNames());
    const toolSectionRe = /^\[mcp_servers\.brainclaw\.tools\.([^\]]+)\]/gm;
    const approvalModeRe = /^\s*approval_mode\s*=\s*"([^"]+)"/m;
    let m: RegExpExecArray | null;
    const warnings: string[] = [];

    // Split into sections to check each tool block
    const lines = existing.split('\n');
    let currentTool: string | null = null;
    let currentBlockLines: string[] = [];

    const checkBlock = (toolName: string, blockLines: string[]) => {
      const blockText = blockLines.join('\n');
      const approvalMatch = approvalModeRe.exec(blockText);
      const isInCatalog = autoApprovedSet.has(toolName);
      const approvalValue = approvalMatch ? approvalMatch[1] : null;

      if (!isInCatalog) {
        warnings.push(`  • [mcp_servers.brainclaw.tools.${toolName}] — not in headless-auto catalog (will be removed)`);
      } else if (approvalValue && approvalValue !== 'approve') {
        warnings.push(`  • [mcp_servers.brainclaw.tools.${toolName}] — approval_mode="${approvalValue}" (expected "approve", will be overwritten)`);
      }
    };

    for (const line of lines) {
      const headerMatch = /^\[mcp_servers\.brainclaw\.tools\.([^\]]+)\]/.exec(line);
      if (headerMatch) {
        if (currentTool !== null) {
          checkBlock(currentTool, currentBlockLines);
        }
        currentTool = headerMatch[1]!;
        currentBlockLines = [line];
      } else if (currentTool !== null) {
        // Stop collecting if we hit a new top-level section (not a sub-section of current tool)
        if (/^\[[^\]]+\]/.test(line) && !line.startsWith(`[mcp_servers.brainclaw.tools.${currentTool}`)) {
          checkBlock(currentTool, currentBlockLines);
          currentTool = null;
          currentBlockLines = [];
        } else {
          currentBlockLines.push(line);
        }
      }
    }
    if (currentTool !== null) {
      checkBlock(currentTool, currentBlockLines);
    }

    // Also detect tool sections not matched by the regex (toolSectionRe was already used inline above)
    void toolSectionRe; // suppress unused warning

    if (warnings.length > 0) {
      process.stdout.write(
        `[brainclaw] Warning: the following tool sections in ${filePath} will be overwritten:\n` +
        warnings.join('\n') + '\n',
      );
    }
  }

  let content = existing;
  let changed = false;

  // Strip any pre-existing MACHINE_MANAGED_HEADER blocks before we emit a
  // fresh one. replaceTomlSection only touches `[section]` headers, so the
  // decorative comment block above the tool sections was preserved on each
  // run and accumulated (we observed three back-to-back copies in the wild).
  // Detection: a run of lines matching the header shape — a `# ==` divider,
  // a `# MACHINE-MANAGED — DO NOT EDIT` marker, then the rest up to the
  // closing `# ==` divider.
  const machineManagedBlockRe = /(?:\r?\n)?# =+\r?\n# MACHINE-MANAGED — DO NOT EDIT\r?\n(?:#[^\r\n]*\r?\n)+# =+\r?\n?/g;
  const strippedContent = content.replace(machineManagedBlockRe, '\n');
  if (strippedContent !== content) {
    content = strippedContent;
    changed = true;
  }

  // Main brainclaw block: create if missing, update only when force-resolving
  // (to preserve user customizations like `cwd` on the main section).
  if (!content.includes('[mcp_servers.brainclaw]')) {
    content = content + brainclawBlock + '\n';
    changed = true;
  } else if (_forceResolve) {
    const replaced = replaceTomlSection(content, 'mcp_servers.brainclaw', brainclawBlock.slice(1) + '\n');
    if (replaced !== content) {
      content = replaced;
      changed = true;
    }
  }

  // Per-tool approval blocks: ALWAYS sync to the current catalog, regardless
  // of _forceResolve. These sections are purely machine-managed (no user edits
  // expected) and must match the narrowed headless-auto catalog.
  const hasToolSections = /^\[mcp_servers\.brainclaw\.tools\./m.test(content);
  if (hasToolSections) {
    const replaced = replaceTomlSection(content, 'mcp_servers.brainclaw.tools', toolsBlock.slice(1));
    if (replaced !== content) {
      content = replaced;
      changed = true;
    }
  } else {
    content = content + toolsBlock;
    changed = true;
  }

  if (changed) {
    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  return {
    kind: 'mcp',
    label: 'Codex MCP config',
    created: !fileExisted,
    updated: fileExisted && changed,
    filePath,
  };
}

/**
 * Replace a TOML section (and all its sub-sections) with new content.
 *
 * Sections are identified by lines that start with `[` at column 0.  We split
 * the file into chunks on those boundaries and replace any chunk whose header
 * matches `sectionName` or starts with `sectionName.` (sub-sections).
 * This avoids the pitfall of regex `[^\[]*` stopping at `[` characters that
 * appear inside TOML values such as arrays.
 */
function replaceTomlSection(fileContent: string, sectionName: string, newBlock: string): string {
  const lines = fileContent.split('\n');
  const sectionHeaderRe = /^\[([^\]]+)\]/;

  // Collect line-ranges for each top-level section start.
  // We only replace the section matching `sectionName` exactly and
  // sub-sections starting with `sectionName.` (e.g. mcp_servers.brainclaw.env).
  const result: string[] = [];
  let insideTarget = false;
  let replacementEmitted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = sectionHeaderRe.exec(line);

    if (m) {
      const header = m[1];
      const isTarget = header === sectionName || header.startsWith(sectionName + '.');
      if (isTarget) {
        // Skip lines belonging to the target section
        insideTarget = true;
        if (!replacementEmitted) {
          // Emit the replacement block once (before the first matching section)
          result.push(newBlock);
          replacementEmitted = true;
        }
        continue;
      } else {
        insideTarget = false;
      }
    }

    if (!insideTarget) {
      result.push(line);
    }
  }

  return result.join('\n');
}

export function ensureContinueMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.continue', 'config.json');
  const existing = readJsonObject(filePath);

  // Continue uses an array for mcpServers, not a keyed object
  const mcpServers = Array.isArray(existing.mcpServers) ? [...existing.mcpServers as unknown[]] : [];
  const existingIdx = mcpServers.findIndex(
    (entry) => isJsonObject(entry) && entry.name === 'brainclaw',
  );
  if (existingIdx >= 0) {
    // Update existing entry, preserving manual edits
    mcpServers[existingIdx] = { name: 'brainclaw', ...brainclawMcpEntry('continue', mcpServers[existingIdx], cwd) };
  } else {
    mcpServers.push({ name: 'brainclaw', ...brainclawMcpEntry('continue', undefined, cwd) });
  }

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Continue MCP settings',
    created,
    updated,
    filePath,
    relativePath: CONTINUE_CONFIG_RELATIVE_PATH,
  };
}

export function ensureContinueUserMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) return undefined;

  const filePath = path.join(homeDir, '.continue', 'config.json');
  const existing = readJsonObject(filePath);
  const mcpServers = Array.isArray(existing.mcpServers) ? [...existing.mcpServers as unknown[]] : [];
  const existingIdx = mcpServers.findIndex(
    (entry) => isJsonObject(entry) && entry.name === 'brainclaw',
  );
  if (existingIdx >= 0) {
    // Update existing entry, preserving manual edits
    mcpServers[existingIdx] = { name: 'brainclaw', ...brainclawMcpEntry('continue', mcpServers[existingIdx]) };
  } else {
    mcpServers.push({ name: 'brainclaw', ...brainclawMcpEntry('continue') });
  }

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Continue MCP settings (global, all projects)',
    created,
    updated,
    filePath,
  };
}

/**
 * Writes `~/.continue/permissions.yaml` with per-tool allow rules for
 * headless-auto-approved brainclaw MCP tools. Continue reads this file
 * to auto-approve tool calls without user confirmation.
 *
 * Format (best-effort per Continue docs):
 * ```yaml
 * # Managed by brainclaw — do not edit manually
 * tools:
 *   bclaw_work:
 *     allow: true
 *   ...
 * ```
 */
export function ensureContinueUserPermissions(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) return undefined;

  const filePath = path.join(homeDir, CONTINUE_PERMISSIONS_RELATIVE_PATH);
  let existing: JsonObject = {};
  if (fs.existsSync(filePath)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
      existing = isJsonObject(parsed) ? { ...parsed } : {};
    } catch {
      existing = {};
    }
  }

  const toolsObj = isJsonObject(existing.tools) ? { ...existing.tools } : {};
  for (const name of getHeadlessAutoApprovedToolNames()) {
    const current = isJsonObject(toolsObj[name]) ? { ...toolsObj[name] } : {};
    toolsObj[name] = {
      ...current,
      allow: true,
    };
  }

  const content = `# Managed by brainclaw — do not edit manually\n${yaml.stringify({
    ...existing,
    tools: toolsObj,
  })}`;
  const { created, updated } = writeTextFileIfChanged(filePath, content);

  return {
    kind: 'permissions',
    label: 'Continue tool permissions',
    created,
    updated,
    filePath,
  };
}

export function ensureOpenCodeMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, 'opencode.json');
  const existing = readJsonObject(filePath);
  const mcp = isJsonObject(existing.mcp) ? { ...existing.mcp } : {};
  const mcpCmd = getBrainclawMcpCommand();
  mcp.brainclaw = {
    type: 'local',
    command: [mcpCmd.command, ...mcpCmd.args],
    env: { BRAINCLAW_AGENT: 'opencode', BRAINCLAW_CWD: cwd },
    permission: Object.fromEntries(getHeadlessAutoApprovedToolNames().map(t => [t, 'allow'])),
  };

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcp,
  });

  return {
    kind: 'mcp',
    label: 'OpenCode MCP config',
    created,
    updated,
    filePath,
    relativePath: OPENCODE_CONFIG_RELATIVE_PATH,
  };
}

export function ensureAntigravityMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) {
    return undefined;
  }

  const filePath = path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = brainclawMcpEntry('antigravity', mcpServers.brainclaw);

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'Antigravity MCP config',
    created,
    updated,
    filePath,
    relativePath: ANTIGRAVITY_MCP_RELATIVE_PATH,
  };
}

function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Resolve the brainclaw CLI invocation for hook configs.
 * Returns shell-safe parts like `["<node>", "<cli.js>"]` or `["npx", "brainclaw"]`.
 */
function getBclawCliParts(): string[] {
  const mcpCmd = getBrainclawMcpCommand();
  if (mcpCmd.command === 'npx') return ['npx', 'brainclaw'];

  const argsWithoutMcp = [...mcpCmd.args];
  if (argsWithoutMcp[argsWithoutMcp.length - 1] === 'mcp') {
    argsWithoutMcp.pop();
  }

  return [
    mcpCmd.command.replace(/\\/g, '/'),
    ...argsWithoutMcp.map((arg) => arg.replace(/\\/g, '/')),
  ];
}

type HookShell = 'bash' | 'powershell';

function buildHookCommand(
  args: string[],
  shell: HookShell = os.platform() === 'win32' ? 'powershell' : 'bash',
): string {
  const rendered = [...getBclawCliParts(), ...args].map(quoteShellArg).join(' ');
  if (shell === 'powershell') {
    return `& ${rendered} 2>$null`;
  }
  return `${rendered} 2>/dev/null`;
}

/**
 * Writes `.cursor/hooks.json` — Cursor's native hooks config.
 * Events: sessionStart, beforeSubmitPrompt, stop (Cursor uses camelCase).
 * Format per https://cursor.com/docs/hooks: version 1, type "command".
 */
export function ensureCursorHooks(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, CURSOR_HOOKS_RELATIVE_PATH);
  const existing = readJsonObject(filePath);
  const hooks = isJsonObject(existing.hooks) ? { ...existing.hooks } : {};

  const sessionStartCmd = buildHookCommand(['session-start', '--include-context']);
  const contextDiffCmd = buildHookCommand(['context-diff']);
  const sessionEndCmd = buildHookCommand(['session-end', '--auto-release', '--reflect', '--reflect-handoff', '--dispatch-review']);

  hooks.sessionStart = [{ type: 'command', command: sessionStartCmd }];
  hooks.beforeSubmitPrompt = [{ type: 'command', command: contextDiffCmd }];
  hooks.stop = [{ type: 'command', command: sessionEndCmd }];

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    version: 1,
    hooks,
  });

  return {
    kind: 'rule',
    label: 'Cursor session hooks',
    created,
    updated,
    filePath,
    relativePath: CURSOR_HOOKS_RELATIVE_PATH,
  };
}

/**
 * Writes `~/.gemini/antigravity/hooks.json` — Antigravity's native hooks config.
 * Events: SessionStart, UserPromptSubmit, Stop (PascalCase, top-level keys).
 */
export function ensureAntigravityHooks(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) return undefined;

  const filePath = path.join(homeDir, ANTIGRAVITY_HOOKS_RELATIVE_PATH);
  const existing = readJsonObject(filePath);

  const sessionStartCmd = buildHookCommand(['session-start', '--include-context']);
  const contextDiffCmd = buildHookCommand(['context-diff']);
  const sessionEndCmd = buildHookCommand(['session-end', '--auto-release', '--reflect', '--reflect-handoff', '--dispatch-review']);

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    SessionStart: [{ command: sessionStartCmd }],
    UserPromptSubmit: [{ command: contextDiffCmd }],
    Stop: [{ command: sessionEndCmd }],
  });

  return {
    kind: 'rule',
    label: 'Antigravity session hooks',
    created,
    updated,
    filePath,
    relativePath: ANTIGRAVITY_HOOKS_RELATIVE_PATH,
  };
}

/**
 * Writes `.github/copilot/hooks.json` — GitHub Copilot's native hooks config.
 * Events: sessionStart, userPromptSubmitted, sessionEnd (camelCase).
 * Format per code.visualstudio.com/docs/copilot/customization/hooks:
 * version 1, type "command", uses bash/powershell fields, timeoutSec.
 */
export function ensureCopilotHooks(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, COPILOT_HOOKS_RELATIVE_PATH);
  const existing = readJsonObject(filePath);
  const hooks = isJsonObject(existing.hooks) ? { ...existing.hooks } : {};

  hooks.sessionStart = [{
    type: 'command',
    bash: buildHookCommand(['session-start', '--include-context'], 'bash'),
    powershell: buildHookCommand(['session-start', '--include-context'], 'powershell'),
    timeoutSec: 30,
  }];
  hooks.userPromptSubmitted = [{
    type: 'command',
    bash: buildHookCommand(['context-diff'], 'bash'),
    powershell: buildHookCommand(['context-diff'], 'powershell'),
    timeoutSec: 10,
  }];
  hooks.sessionEnd = [{
    type: 'command',
    bash: buildHookCommand(['session-end', '--auto-release', '--reflect', '--reflect-handoff', '--dispatch-review'], 'bash'),
    powershell: buildHookCommand(['session-end', '--auto-release', '--reflect', '--reflect-handoff', '--dispatch-review'], 'powershell'),
    timeoutSec: 30,
  }];

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    version: 1,
    hooks,
  });

  return {
    kind: 'rule',
    label: 'Copilot session hooks',
    created,
    updated,
    filePath,
    relativePath: COPILOT_HOOKS_RELATIVE_PATH,
  };
}

export function ensureOpenClawMcpConfig(homeDir: string | undefined): AutoConfigWriteResult | undefined {
  if (!homeDir) {
    return undefined;
  }

  const filePath = path.join(homeDir, '.openclaw', 'mcp.json');
  const existing = readJsonObject(filePath);
  const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers.brainclaw = brainclawMcpEntry('openclaw', mcpServers.brainclaw);

  const { created, updated } = writeJsonFileIfChanged(filePath, {
    ...existing,
    mcpServers,
  });

  return {
    kind: 'mcp',
    label: 'OpenClaw MCP config',
    created,
    updated,
    filePath,
    relativePath: OPENCLAW_MCP_RELATIVE_PATH,
  };
}

export function writeDetectedAgentAutoConfig(
  agentName: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoConfigWriteResult[] {
  switch (agentName) {
    case 'claude-code': {
      const results: AutoConfigWriteResult[] = [
        ensureClaudeCodeMcpConfig(cwd),
        ensureClaudeCodeCommand(cwd),
        ensureClaudeCodeSettings(cwd),
        ensureVscodeExtensionRecommendation(cwd),
      ];
      const userSettings = ensureClaudeCodeUserSettings(resolveHomeDir(env));
      if (userSettings) results.push(userSettings);
      const userCmd = ensureClaudeCodeUserCommand(resolveHomeDir(env));
      if (userCmd) results.push(userCmd);
      const dep = ensureProjectDevDependency(cwd);
      if (dep) results.push(dep);
      return results;
    }
    case 'cline':
      return [ensureClineMcpConfig(cwd)];
    case 'windsurf': {
      const results: AutoConfigWriteResult[] = [ensureWindsurfModernRules(cwd)];
      const mcp = ensureWindsurfMcpConfig(resolveHomeDir(env));
      if (mcp) results.push(mcp);
      return results;
    }
    case 'github-copilot':
      return [ensureCopilotMcpConfig(cwd), ensureCopilotSkill(cwd), ensureCopilotHooks(cwd), ensureUniversalBrainclawSkill(cwd), ensureVscodeExtensionRecommendation(cwd)];
    case 'cursor': {
      const results: AutoConfigWriteResult[] = [ensureCursorMdc(cwd), ensureCursorHooks(cwd), ensureUniversalBrainclawSkill(cwd)];
      const mcp = ensureCursorMcpConfig(resolveHomeDir(env));
      if (mcp) results.push(mcp);
      return results;
    }
    case 'roo':
      return [ensureRooMcpConfig(cwd), ensureUniversalBrainclawSkill(cwd)];
    case 'kilocode':
      return [ensureKilocodeMcpConfig(cwd), ensureKilocodeConfig(cwd), ensureUniversalBrainclawSkill(cwd)];
    case 'codex': {
      const results: AutoConfigWriteResult[] = [ensureUniversalBrainclawSkill(cwd)];
      const result = ensureCodexMcpConfig(resolveHomeDir(env), env);
      if (result) results.push(result);
      return results;
    }
    case 'continue': {
      const results: AutoConfigWriteResult[] = [ensureContinueMcpConfig(cwd)];
      const homeDir = resolveHomeDir(env);
      const userMcp = ensureContinueUserMcpConfig(homeDir);
      if (userMcp) results.push(userMcp);
      const perms = ensureContinueUserPermissions(homeDir);
      if (perms) results.push(perms);
      return results;
    }
    case 'opencode':
      return [ensureOpenCodeMcpConfig(cwd), ensureUniversalBrainclawSkill(cwd)];
    case 'antigravity': {
      const homeDir = resolveHomeDir(env);
      const results: AutoConfigWriteResult[] = [];
      const mcp = ensureAntigravityMcpConfig(homeDir);
      if (mcp) results.push(mcp);
      const hooks = ensureAntigravityHooks(homeDir);
      if (hooks) results.push(hooks);
      return results;
    }
    case 'openclaw': {
      const result = ensureOpenClawMcpConfig(resolveHomeDir(env));
      return result ? [result] : [];
    }
    default:
      return [];
  }
}

export function writeExportCompanionFiles(
  format: ExportFormat,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoConfigWriteResult[] {
  switch (format) {
    case 'claude-md': {
      const results: AutoConfigWriteResult[] = [
        ensureClaudeCodeMcpConfig(cwd),
        ensureClaudeCodeCommand(cwd),
        ensureClaudeCodeSettings(cwd),
      ];
      const userSettings = ensureClaudeCodeUserSettings(resolveHomeDir(env));
      if (userSettings) results.push(userSettings);
      const userCmd = ensureClaudeCodeUserCommand(resolveHomeDir(env));
      if (userCmd) results.push(userCmd);
      const dep = ensureProjectDevDependency(cwd);
      if (dep) results.push(dep);
      return results;
    }
    case 'cline':
      return [ensureClineMcpConfig(cwd)];
    case 'windsurf': {
      const results: AutoConfigWriteResult[] = [ensureWindsurfModernRules(cwd)];
      const mcp = ensureWindsurfMcpConfig(resolveHomeDir(env));
      if (mcp) results.push(mcp);
      return results;
    }
    case 'copilot-instructions':
      return [ensureVscodeMcpConfig(cwd), ensureCopilotMcpConfig(cwd), ensureCopilotSkill(cwd), ensureCopilotHooks(cwd)];
    case 'cursor-rules': {
      const results: AutoConfigWriteResult[] = [ensureCursorMdc(cwd), ensureCursorHooks(cwd)];
      const mcp = ensureCursorMcpConfig(resolveHomeDir(env));
      if (mcp) results.push(mcp);
      return results;
    }
    case 'roo':
      return [ensureRooMcpConfig(cwd)];
    case 'kilocode':
      return [ensureKilocodeMcpConfig(cwd), ensureKilocodeConfig(cwd), ensureUniversalBrainclawSkill(cwd)];
    case 'continue': {
      const results: AutoConfigWriteResult[] = [ensureContinueMcpConfig(cwd)];
      const homeDir = resolveHomeDir(env);
      const userMcp = ensureContinueUserMcpConfig(homeDir);
      if (userMcp) results.push(userMcp);
      const perms = ensureContinueUserPermissions(homeDir);
      if (perms) results.push(perms);
      return results;
    }
    case 'gemini-md': {
      const homeDir = resolveHomeDir(env);
      const results: AutoConfigWriteResult[] = [];
      const mcp = ensureAntigravityMcpConfig(homeDir);
      if (mcp) results.push(mcp);
      const hooks = ensureAntigravityHooks(homeDir);
      if (hooks) results.push(hooks);
      return results;
    }
    default:
      return [];
  }
}

/**
 * Patch all MCP config files to use the currently resolved brainclaw binary.
 *
 * Called after upgrade / version --publish-local to fix stale paths.
 * Re-resolves the brainclaw command, then re-runs all ensure*McpConfig()
 * functions with forceResolve=true so existing absolute paths are overwritten.
 *
 * Returns the list of configs that were actually updated (not just created).
 */
export function patchAllMcpConfigs(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoConfigWriteResult[] {
  // 1. Clear cached path so resolution picks up the new install location
  resetMcpCommandCache();

  // 2. Set force-resolve mode so brainclawMcpEntry overwrites existing paths
  _forceResolve = true;

  const results: AutoConfigWriteResult[] = [];
  const homeDir = resolveHomeDir(env);

  try {
    // Workspace-level configs
    results.push(ensureClaudeCodeMcpConfig(cwd));
    results.push(ensureVscodeMcpConfig(cwd));
    results.push(ensureVscodeExtensionRecommendation(cwd));
    results.push(ensureCopilotMcpConfig(cwd));
    results.push(ensureClineMcpConfig(cwd));
    results.push(ensureRooMcpConfig(cwd));
    results.push(ensureContinueMcpConfig(cwd));
    results.push(ensureOpenCodeMcpConfig(cwd));

    // Machine-level configs (in ~ or platform-specific)
    const userConfigs = [
      ensureClaudeCodeUserSettings(homeDir, env),
      ensureCursorMcpConfig(homeDir),
      ensureWindsurfMcpConfig(homeDir),
      ensureContinueUserMcpConfig(homeDir),
      ensureContinueUserPermissions(homeDir),
      ensureAntigravityMcpConfig(homeDir),
      ensureOpenClawMcpConfig(homeDir),
      ensureCodexMcpConfig(homeDir, env),
    ];
    for (const r of userConfigs) {
      if (r) results.push(r);
    }
  } finally {
    // Always reset force-resolve mode
    _forceResolve = false;
  }

  return results.filter(r => r.created || r.updated);
}
