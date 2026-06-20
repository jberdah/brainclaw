import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { MCP_HEADLESS_AUTO_TOOL_NAMES, MCP_CANONICAL_GRAMMAR_TOOL_NAMES, REMOVED_IN_V1_TOOLS } from '../commands/mcp.js';
import { renderToml, tomlArrayTableHasEntry } from './toml-writer.js';
import { PROTOCOL_SKILLS, renderProtocolSkill } from './protocol-skills.js';
import { getInstalledBrainclawVersion } from './brainclaw-version.js';
import { isAgentInstalledPerInventory } from './agent-inventory.js';
import {
  brainclawMcpEntry,
  buildHookCommand,
  getBclawCliParts,
  getBrainclawMcpCommand,
  isForceResolveEnabled,
  quoteShellArg,
  resetMcpCommandCache,
  withForcedResolve,
} from './mcp-command-resolution.js';

export { resetMcpCommandCache };

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

### Before editing unfamiliar code (Code Map)

Don't grep the repo blind. Orient with the Code Map first:

\`\`\`bash
brainclaw code-map brief <symbol-or-path>   # ranked reading list + related decisions/traps (MCP: bclaw_code_brief)
brainclaw code-map find <name>              # locate a symbol/class/component (MCP: bclaw_code_find)
brainclaw code-map status                   # freshness — if missing_index/stale, run: code-map refresh --all
\`\`\`

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
  const banner = '# Agent instruction files (generated by brainclaw)';
  const bannerBlock = lines.has(banner) ? '' : `${banner}\n`;
  const separator = current.trimEnd().length > 0 ? '\n' : '';
  const next = `${current.trimEnd()}${separator}\n${bannerBlock}${toAdd.join('\n')}\n`;
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

export interface AgentLiveCompanionTarget {
  agentName: string;
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
  { agentName: 'mistral-vibe',   format: 'agents-md',            relativePath: 'AGENTS.md' },
  { agentName: 'hermes',         format: 'agents-md',            relativePath: 'AGENTS.md' },
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

export const LIVE_COMPANION_EXPORT_REGISTRY: AgentLiveCompanionTarget[] = [
  { agentName: 'cursor', relativePath: '.cursor/live.md' },
  { agentName: 'cline', relativePath: '.clinerules/live.md' },
  { agentName: 'windsurf', relativePath: '.windsurf/rules/live.md' },
  { agentName: 'github-copilot', relativePath: '.github/copilot-instructions.live.md' },
  { agentName: 'continue', relativePath: '.continue/live.md' },
  { agentName: 'antigravity', relativePath: 'GEMINI.live.md' },
  { agentName: 'mistral-vibe', relativePath: '.vibe/live.md' },
];

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

function defaultLiveCompanionPath(stableRelativePath: string): string {
  const ext = path.extname(stableRelativePath);
  if (!ext) return `${stableRelativePath}.live`;
  const base = stableRelativePath.slice(0, -ext.length);
  return `${base}.live${ext}`;
}

export function resolveLiveCompanionPath(agentName: string, stableRelativePath: string): string {
  return LIVE_COMPANION_EXPORT_REGISTRY.find((target) => target.agentName === agentName)?.relativePath
    ?? defaultLiveCompanionPath(stableRelativePath);
}

export function writeLiveCompanionFile(
  content: string,
  agentName: string,
  stableRelativePath: string,
  cwd: string,
): { created: boolean; updated: boolean; filePath: string; relativePath: string } {
  const relativePath = resolveLiveCompanionPath(agentName, stableRelativePath);
  const fullPath = path.join(cwd, relativePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);
  const existing = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
  if (existing === content) {
    return { created: false, updated: false, filePath: fullPath, relativePath };
  }

  fs.writeFileSync(fullPath, content, 'utf-8');
  return { created: !existed, updated: existed, filePath: fullPath, relativePath };
}

export interface AutoConfigWriteResult {
  kind: 'mcp' | 'skill' | 'rule' | 'recommendation' | 'permissions';
  label: string;
  created: boolean;
  updated: boolean;
  filePath: string;
  relativePath?: string;
  /** True when the existing file could not be parsed and was left untouched. */
  skipped?: boolean;
  warning?: string;
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
const MISTRAL_VIBE_CONFIG_RELATIVE_PATH = '.vibe/config.toml';
const HERMES_CONFIG_RELATIVE_PATH = '.hermes/config.yaml';
const HERMES_EXTERNAL_SKILLS_RELATIVE_PATH = '.agents/skills';
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
  MISTRAL_VIBE_CONFIG_RELATIVE_PATH,
  HERMES_CONFIG_RELATIVE_PATH,
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

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Read a JSON config file. Returns `{}` when the file doesn't exist, and
 * `undefined` when the file exists but cannot be parsed as a JSON object.
 * Callers MUST treat `undefined` as "abort the write" — overwriting a file we
 * could not parse destroys user-owned configuration (a UTF-8 BOM or JSONC
 * comments used to wipe entire settings files this way).
 */
function readJsonObject(filePath: string): JsonObject | undefined {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(filePath, 'utf-8')));
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Same contract as readJsonObject, but tolerates JSONC comments and trailing
 * commas (VS Code files). Token-based, so comments inside string values
 * ("https://…") never corrupt the parse.
 */
function readJsoncObject(filePath: string): JsonObject | undefined {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = parseJsonc(stripBom(fs.readFileSync(filePath, 'utf-8')));
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Result for a writer that found an unparseable existing file: warn once and
 * leave the file exactly as it is.
 */
function skippedAutoConfigResult(
  kind: AutoConfigWriteResult['kind'],
  label: string,
  filePath: string,
  relativePath?: string,
): AutoConfigWriteResult {
  const warning = `cannot parse ${filePath} — file left untouched. Fix its syntax (or remove it) and re-run.`;
  process.stderr.write(`[brainclaw] Warning: ${warning}\n`);
  return {
    kind,
    label,
    created: false,
    updated: false,
    filePath,
    ...(relativePath ? { relativePath } : {}),
    skipped: true,
    warning,
  };
}

interface JsoncToken {
  type: 'string' | 'literal' | 'punct';
  start: number;
  end: number;
  value?: string;
}

/** Tokenize JSONC, preserving offsets. Returns undefined on malformed input. */
function tokenizeJsonc(text: string): JsoncToken[] | undefined {
  const tokens: JsoncToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return undefined;
      i = close + 2;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') {
        i += text[i] === '\\' ? 2 : 1;
      }
      if (i >= n) return undefined;
      i++;
      let value: string;
      try {
        value = JSON.parse(text.slice(start, i)) as string;
      } catch {
        return undefined;
      }
      tokens.push({ type: 'string', start, end: i, value });
      continue;
    }
    if ('{}[]:,'.includes(ch)) {
      tokens.push({ type: 'punct', start: i, end: i + 1, value: ch });
      i++;
      continue;
    }
    const start = i;
    while (i < n && !' \t\r\n{}[]:,/"'.includes(text[i]!)) i++;
    if (i === start) return undefined;
    tokens.push({ type: 'literal', start, end: i });
  }
  return tokens;
}

/** Parse JSONC text (comments + trailing commas) into a JS value. Throws on malformed input. */
function parseJsonc(text: string): unknown {
  const tokens = tokenizeJsonc(text);
  if (!tokens) throw new Error('malformed JSONC');
  let pos = 0;
  const next = (): JsoncToken => {
    const t = tokens[pos];
    if (!t) throw new Error('unexpected end of JSONC');
    return t;
  };
  const parseValue = (): unknown => {
    const t = next();
    if (t.type === 'string') {
      pos++;
      return t.value;
    }
    if (t.type === 'literal') {
      pos++;
      return JSON.parse(text.slice(t.start, t.end)) as unknown;
    }
    if (t.value === '{') {
      pos++;
      const obj: JsonObject = {};
      if (next().value === '}') { pos++; return obj; }
      for (;;) {
        const key = next();
        if (key.type !== 'string') throw new Error('expected object key');
        pos++;
        if (next().value !== ':') throw new Error('expected colon');
        pos++;
        obj[key.value as string] = parseValue();
        const sep = next();
        if (sep.value === ',') {
          pos++;
          if (next().value === '}') { pos++; return obj; }
          continue;
        }
        if (sep.value === '}') { pos++; return obj; }
        throw new Error('expected comma or closing brace');
      }
    }
    if (t.value === '[') {
      pos++;
      const arr: unknown[] = [];
      if (next().value === ']') { pos++; return arr; }
      for (;;) {
        arr.push(parseValue());
        const sep = next();
        if (sep.value === ',') {
          pos++;
          if (next().value === ']') { pos++; return arr; }
          continue;
        }
        if (sep.value === ']') { pos++; return arr; }
        throw new Error('expected comma or closing bracket');
      }
    }
    throw new Error('unexpected token');
  };
  const value = parseValue();
  if (pos !== tokens.length) throw new Error('trailing content after JSONC value');
  return value;
}

/** Returns the token index just past the value starting at tokens[idx], or undefined. */
function skipJsoncValue(tokens: JsoncToken[], idx: number): number | undefined {
  const tok = tokens[idx];
  if (!tok) return undefined;
  if (tok.type === 'string' || tok.type === 'literal') return idx + 1;
  if (tok.value === '{' || tok.value === '[') {
    const close = tok.value === '{' ? '}' : ']';
    let depth = 0;
    for (let i = idx; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type !== 'punct') continue;
      if (t.value === tok.value) depth++;
      else if (t.value === close && --depth === 0) return i + 1;
    }
  }
  return undefined;
}

/**
 * Set `keyPath` to `valueJson` (a rendered JSON snippet) inside a JSONC text,
 * preserving all comments, whitespace, and unrelated content byte-for-byte.
 * Missing intermediate objects are created. Returns undefined when the input
 * cannot be edited safely (malformed, non-object root, non-object intermediate).
 */
function setJsoncValue(text: string, keyPath: string[], valueJson: string): string | undefined {
  if (keyPath.length === 0) return undefined;
  const tokens = tokenizeJsonc(text);
  if (!tokens || tokens.length === 0 || tokens[0]!.value !== '{') return undefined;

  let objStart = 0;
  for (let depth = 0; depth < keyPath.length; depth++) {
    const key = keyPath[depth]!;
    const openTok = tokens[objStart]!;
    if (openTok.value !== '{') return undefined;
    const objEnd = skipJsoncValue(tokens, objStart);
    if (objEnd === undefined) return undefined;

    // Scan direct members of this object for `key`
    let i = objStart + 1;
    let found = -1;
    while (i < objEnd - 1) {
      const keyTok = tokens[i];
      if (!keyTok || keyTok.type !== 'string') return undefined;
      const colon = tokens[i + 1];
      if (!colon || colon.value !== ':') return undefined;
      const valueIdx = i + 2;
      const valueEnd = skipJsoncValue(tokens, valueIdx);
      if (valueEnd === undefined) return undefined;
      if (keyTok.value === key) {
        found = valueIdx;
        break;
      }
      i = valueEnd;
      if (tokens[i]?.value === ',') i++;
    }

    if (found === -1) {
      // Key absent — insert it (with the remaining path nested) after the brace.
      let snippet = valueJson;
      for (let d = keyPath.length - 1; d > depth; d--) {
        snippet = `{ ${JSON.stringify(keyPath[d])}: ${snippet} }`;
      }
      const hasMembers = tokens[objStart + 1]?.value !== '}';
      const insertAt = openTok.end;
      const member = `${JSON.stringify(key)}: ${snippet}`;
      const insertion = hasMembers ? ` ${member},` : ` ${member} `;
      return text.slice(0, insertAt) + insertion + text.slice(insertAt);
    }

    if (depth === keyPath.length - 1) {
      const valueEnd = skipJsoncValue(tokens, found)!;
      return text.slice(0, tokens[found]!.start) + valueJson + text.slice(tokens[valueEnd - 1]!.end);
    }

    objStart = found;
  }
  return undefined;
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
  const fromEnv = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  // Injected envs (tests, embedders) opt out of the machine fallback. For the
  // real process env, fall back to os.homedir(): Git Bash exports HOME as a
  // POSIX path (/c/Users/x) that breaks every user-level writer on Windows,
  // and some CI shells unset HOME/USERPROFILE entirely.
  if (env !== process.env) return undefined;
  const fallback = os.homedir();
  return fallback && fs.existsSync(fallback) ? fallback : undefined;
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
  const existing = readJsoncObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Cline MCP settings', filePath, CLINE_MCP_RELATIVE_PATH);
  }
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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Windsurf MCP settings', filePath, WINDSURF_MCP_RELATIVE_PATH);
  }
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

/**
 * Write the protocol-skills pack (pln#519) to the universal `.agents/skills/`
 * path — one SKILL.md per workflow (session / memory-capture / multi-agent).
 * Orthogonal to the agent-PROFILE skill above; same agents discover both via
 * the shared `.agents/skills/` convention, so no per-agent branching is needed.
 * Idempotent (writeTextFileIfChanged). Called only for skill-capable agents.
 */
export function ensureProtocolSkills(cwd: string): AutoConfigWriteResult[] {
  const version = getInstalledBrainclawVersion();
  return PROTOCOL_SKILLS.map((skill) => {
    const relativePath = `.agents/skills/${skill.id}/SKILL.md`;
    const filePath = path.join(cwd, '.agents', 'skills', skill.id, 'SKILL.md');
    const { created, updated } = writeTextFileIfChanged(filePath, renderProtocolSkill(skill, version));
    return {
      kind: 'skill' as const,
      label: `Protocol-skill ${skill.id} (${relativePath})`,
      created,
      updated,
      filePath,
      relativePath,
    };
  });
}

export function ensureCopilotMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.vscode', 'settings.json');
  const existing = readJsoncObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Copilot MCP settings (.vscode/settings.json)', filePath, COPILOT_MCP_RELATIVE_PATH);
  }
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
  const existing = readJsoncObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'VS Code MCP config (.vscode/mcp.json)', filePath, VSCODE_MCP_RELATIVE_PATH);
  }
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
  const existing = readJsoncObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('recommendation', 'VS Code extension recommendation (.vscode/extensions.json)', filePath, VSCODE_EXTENSIONS_RELATIVE_PATH);
  }
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

/**
 * Recognize a hook command emitted by any brainclaw version: `npx brainclaw …`,
 * absolute bin paths ending in /brainclaw, the `.bclaw-session` marker wrapper,
 * and the brainclaw-specific `check-events` subcommand (whose broken legacy
 * form — bare node.exe, cli.js arg dropped — contained no other marker).
 */
function isBrainclawHookCommand(command: string): boolean {
  // Review follow-up L2 (lop_e2d566765b8b4ce3): match brainclaw/bclaw only in
  // COMMAND position (start / path separator / shell delimiter, optional binary
  // extension) and check-events only as a standalone shell word — the old
  // substring regex ate any user hook that merely MENTIONED these words.
  if (command.includes('.bclaw-session')) return true;
  if (/(^|\s)check-events(\s|$)/.test(command)) return true;
  return /(^|[\s/\\"'`;&|(])(brainclaw|bclaw)(\.(cmd|exe|js|mjs|ps1))?([\s"')`;&|]|$)/.test(command);
}

/** Test-only export — hook recognition is the L2 contract worth pinning. */
export const __agentFilesTesting = { isBrainclawHookCommand } as const;

/**
 * Remove every brainclaw-emitted hook from `entries`, then append exactly one
 * canonical entry. Keyed on recognition, not exact command text, so upgrades
 * replace stale/broken variants instead of accumulating duplicates (we observed
 * 2× UserPromptSubmit + 3× Stop hooks piled up across upgrades in the wild).
 * User-authored hooks are preserved untouched.
 */
function replaceBrainclawHooks(entries: unknown[], canonical: JsonObject): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks as unknown[];
    const remaining = hooks.filter(
      (h) => !(isJsonObject(h) && typeof h.command === 'string' && isBrainclawHookCommand(h.command)),
    );
    if (remaining.length === 0) continue;
    kept.push(remaining.length === hooks.length ? entry : { ...entry, hooks: remaining });
  }
  kept.push(canonical);
  return kept;
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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Claude Code MCP server', filePath, CLAUDE_CODE_MCP_RELATIVE_PATH);
  }
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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Claude Code user settings — MCP + permissions (global, all projects)', filePath);
  }

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
  if (existing === undefined) {
    return skippedAutoConfigResult('rule', 'Claude Code settings (permissions + session hooks)', filePath, CLAUDE_CODE_SETTINGS_RELATIVE_PATH);
  }

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

  // Merge hooks — UserPromptSubmit opens a session on first prompt, diff on subsequent.
  // getBclawCliParts() keeps the cli.js argument; the previous builder used only
  // the bare command, emitting broken `node.exe session-start` hooks whenever
  // binary resolution succeeded (hidden by 2>/dev/null).
  const hooks = isJsonObject(existing.hooks) ? { ...existing.hooks } : {};
  const bclawBin = getBclawCliParts().map(quoteShellArg).join(' ');
  const sessionCommand = `f=.claude/.bclaw-session; if [ ! -f "$f" ]; then touch "$f"; ${bclawBin} session-start --include-context 2>/dev/null; else ${bclawBin} context-diff 2>/dev/null; fi`;
  const stopCommand = `rm -f .claude/.bclaw-session; ${bclawBin} session-end --auto-release --reflect --reflect-handoff --dispatch-review 2>/dev/null`;
  // PostToolUse — check for unseen events after any brainclaw MCP tool call
  const checkEventsCommand = `${bclawBin} check-events 2>/dev/null`;

  hooks.UserPromptSubmit = replaceBrainclawHooks(
    Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit as unknown[] : [],
    buildCommandHookEntry(sessionCommand),
  );
  hooks.Stop = replaceBrainclawHooks(
    Array.isArray(hooks.Stop) ? hooks.Stop as unknown[] : [],
    buildCommandHookEntry(stopCommand),
  );
  hooks.PostToolUse = replaceBrainclawHooks(
    Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse as unknown[] : [],
    buildMatchedCommandHookEntry('mcp__brainclaw__', checkEventsCommand),
  );

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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Cursor MCP settings', filePath, CURSOR_MCP_RELATIVE_PATH);
  }
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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Roo Code MCP settings', filePath, ROO_MCP_RELATIVE_PATH);
  }
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
  const label = 'Kilo Code permissions (kilo.jsonc)';
  const existing = readJsoncObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('permissions', label, filePath, KILOCODE_CONFIG_RELATIVE_PATH);
  }

  const noop = {
    kind: 'permissions' as const,
    label,
    created: false,
    updated: false,
    filePath,
    relativePath: KILOCODE_CONFIG_RELATIVE_PATH,
  };

  const permission = isJsonObject(existing.permission) ? existing.permission : {};
  if (permission.external_directory === 'deny') {
    return noop;
  }

  const existed = fs.existsSync(filePath);
  if (!existed) {
    const { created, updated } = writeTextFileIfChanged(
      filePath,
      `${JSON.stringify({ permission: { external_directory: 'deny' } }, null, 2)}\n`,
    );
    return { ...noop, created, updated };
  }

  // Surgical JSONC edit — kilo.jsonc is a user-owned file where comments are
  // part of the official format; a parse→stringify round-trip would strip them.
  const raw = stripBom(fs.readFileSync(filePath, 'utf-8'));
  const next = raw.trim().length === 0
    ? `${JSON.stringify({ permission: { external_directory: 'deny' } }, null, 2)}\n`
    : setJsoncValue(raw, ['permission', 'external_directory'], '"deny"');
  if (next === undefined) {
    return skippedAutoConfigResult('permissions', label, filePath, KILOCODE_CONFIG_RELATIVE_PATH);
  }
  fs.writeFileSync(filePath, next, 'utf-8');
  return { ...noop, updated: true };
}

export function ensureKilocodeMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, '.kilo', 'mcp.json');
  const existing = readJsonObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Kilo Code MCP settings', filePath, KILOCODE_MCP_RELATIVE_PATH);
  }
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

/**
 * Mistral Vibe MCP config writer (pln#489). Mistral Vibe reads
 * `.vibe/config.toml` (project-level, prioritaire) or `~/.vibe/config.toml`
 * (user-level fallback). The MCP server registry uses TOML array-of-tables
 * `[[mcp_servers]]` with `name`, `transport`, `command`, `args`.
 *
 * Idempotent: if the file already declares a `[[mcp_servers]]` block whose
 * `name = "brainclaw"`, this function leaves it alone (no overwrite, preserves
 * any user-customized command/args/env). Otherwise it appends our block to
 * the end of the file. Other `[[mcp_servers]]` entries are preserved.
 *
 * Why a minimal TOML writer rather than a full parser/round-trip merge?
 * The MCP entry is append-only and our heuristic detection in
 * `tomlArrayTableHasEntry` covers the realistic file shapes Vibe writes (one
 * `name = "..."` field as the first key after each `[[mcp_servers]]` header).
 * If the user has hand-edited the file in unusual ways, they keep what they
 * wrote — this writer never deletes user content.
 */
export function ensureMistralVibeMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, MISTRAL_VIBE_CONFIG_RELATIVE_PATH);
  const mcpCmd = getBrainclawMcpCommand();

  let existing = '';
  let existed = false;
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf-8');
    existed = true;
  }

  if (existed && tomlArrayTableHasEntry(existing, 'mcp_servers', 'brainclaw')) {
    // Already wired. No-op.
    return {
      kind: 'mcp',
      label: 'Mistral Vibe MCP settings',
      created: false,
      updated: false,
      filePath,
      relativePath: MISTRAL_VIBE_CONFIG_RELATIVE_PATH,
    };
  }

  const brainclawBlock = renderToml({
    arrayTables: [{
      name: 'mcp_servers',
      entries: [{
        name: 'brainclaw',
        transport: 'stdio',
        command: mcpCmd.command,
        args: mcpCmd.args,
      }],
    }],
  });

  // Append (preserves any user-written content above) — separated by a blank
  // line if the file is non-empty and doesn't already end with one.
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let next: string;
  if (!existed || existing.length === 0) {
    next = brainclawBlock;
  } else {
    const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
    next = existing + sep + brainclawBlock;
  }

  fs.writeFileSync(filePath, next, 'utf-8');

  return {
    kind: 'mcp',
    label: 'Mistral Vibe MCP settings',
    created: !existed,
    updated: existed,
    filePath,
    relativePath: MISTRAL_VIBE_CONFIG_RELATIVE_PATH,
  };
}

// Hermes' MCP `tools.include` array — narrow canonical-grammar surface. Derived
// from MCP_CANONICAL_GRAMMAR_TOOL_NAMES (which is itself ALL_TOOLS-derived) so
// new facade tools or canonical grammar verbs propagate without a manual edit
// here (pln#546 step 2). REMOVED_IN_V1_TOOLS are stripped so deprecated names
// don't reappear in user-facing configs.
//
// LAZY (pln#564 coordinator fix): computed on first call, NOT at module init.
// agent-files.ts ↔ commands/mcp.ts form an import cycle; reading the imported
// MCP_CANONICAL_GRAMMAR_TOOL_NAMES at module-eval time threw a TDZ
// ("Cannot access 'MCP_CANONICAL_GRAMMAR_TOOL_NAMES' before initialization")
// when agent-files loaded mid-mcp-init — which broke the MCP server. tsc does
// not catch this (runtime-only). Deferring the read to call time fixes it.
let hermesBrainclawMcpToolsCache: string[] | undefined;
function getHermesBrainclawMcpTools(): string[] {
  if (!hermesBrainclawMcpToolsCache) {
    hermesBrainclawMcpToolsCache = MCP_CANONICAL_GRAMMAR_TOOL_NAMES
      .filter((name) => !REMOVED_IN_V1_TOOLS.has(name));
  }
  return hermesBrainclawMcpToolsCache;
}

export function ensureHermesMcpConfig(homeDir: string | undefined, workspacePath?: string): AutoConfigWriteResult | undefined {
  if (!homeDir) return undefined;

  const filePath = path.join(homeDir, HERMES_CONFIG_RELATIVE_PATH);
  const label = 'Hermes MCP settings';

  // Parse the existing file as a YAML *document* so we can update only the
  // brainclaw-managed subtree. A parse→stringify round-trip of the whole file
  // destroys user comments, anchors, and key order; a parse failure must
  // abort instead of replacing the user's Hermes config with a stub.
  let doc: ReturnType<typeof yaml.parseDocument> | undefined;
  let existing: JsonObject = {};
  if (fs.existsSync(filePath)) {
    doc = yaml.parseDocument(stripBom(fs.readFileSync(filePath, 'utf-8')));
    if (doc.errors.length > 0) {
      return skippedAutoConfigResult('mcp', label, filePath, HERMES_CONFIG_RELATIVE_PATH);
    }
    const parsed: unknown = doc.toJS();
    if (parsed == null) {
      doc = undefined; // empty file — treat as fresh create
    } else if (isJsonObject(parsed)) {
      existing = parsed;
    } else {
      return skippedAutoConfigResult('mcp', label, filePath, HERMES_CONFIG_RELATIVE_PATH);
    }
  }

  const mcpServersJs = isJsonObject(existing.mcp_servers) ? existing.mcp_servers : {};
  const current = isJsonObject(mcpServersJs.brainclaw) ? { ...mcpServersJs.brainclaw } : {};
  const currentEnv = isJsonObject(current.env) ? { ...current.env } : {};
  const currentTools = isJsonObject(current.tools) ? { ...current.tools } : {};
  const skills = isJsonObject(existing.skills) ? existing.skills : {};
  const externalDirs = Array.isArray(skills.external_dirs)
    ? (skills.external_dirs as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  const newExternalDirs: string[] = [];
  if (workspacePath) {
    const projectSkillsDir = path.resolve(workspacePath, HERMES_EXTERNAL_SKILLS_RELATIVE_PATH);
    const normalized = projectSkillsDir.replace(/\\/g, '/').toLowerCase();
    if (!externalDirs.some((dir) => dir.replace(/\\/g, '/').toLowerCase() === normalized)) {
      newExternalDirs.push(projectSkillsDir);
    }
  }
  const mcpCmd = getBrainclawMcpCommand();

  const desiredEntry = {
    ...current,
    command: typeof current.command === 'string' ? current.command : mcpCmd.command,
    args: Array.isArray(current.args) ? current.args : mcpCmd.args,
    env: {
      ...currentEnv,
      BRAINCLAW_AGENT: 'hermes',
    },
    tools: {
      ...currentTools,
      include: Array.isArray(currentTools.include) ? currentTools.include : getHermesBrainclawMcpTools(),
      prompts: typeof currentTools.prompts === 'boolean' ? currentTools.prompts : false,
      resources: typeof currentTools.resources === 'boolean' ? currentTools.resources : false,
    },
  };

  if (!doc) {
    const nextConfig = {
      mcp_servers: { brainclaw: desiredEntry },
      ...(externalDirs.length + newExternalDirs.length > 0
        ? { skills: { ...skills, external_dirs: [...externalDirs, ...newExternalDirs] } }
        : {}),
    };
    const content = `# brainclaw manages the mcp_servers.brainclaw entry below\n${yaml.stringify(nextConfig)}`;
    const { created, updated } = writeTextFileIfChanged(filePath, content);
    return {
      kind: 'mcp',
      label,
      created,
      updated,
      filePath,
      relativePath: HERMES_CONFIG_RELATIVE_PATH,
    };
  }

  let changed = false;
  try {
    const currentRaw = isJsonObject(mcpServersJs.brainclaw) ? mcpServersJs.brainclaw : undefined;
    if (JSON.stringify(currentRaw ?? null) !== JSON.stringify(desiredEntry)) {
      doc.setIn(['mcp_servers', 'brainclaw'], desiredEntry);
      changed = true;
    }
    if (newExternalDirs.length > 0) {
      if (doc.getIn(['skills', 'external_dirs']) === undefined) {
        doc.setIn(['skills', 'external_dirs'], [...externalDirs, ...newExternalDirs]);
      } else {
        for (const dir of newExternalDirs) {
          doc.addIn(['skills', 'external_dirs'], dir);
        }
      }
      changed = true;
    }
  } catch {
    return skippedAutoConfigResult('mcp', label, filePath, HERMES_CONFIG_RELATIVE_PATH);
  }

  if (!changed) {
    return {
      kind: 'mcp',
      label,
      created: false,
      updated: false,
      filePath,
      relativePath: HERMES_CONFIG_RELATIVE_PATH,
    };
  }

  fs.writeFileSync(filePath, doc.toString(), 'utf-8');
  return {
    kind: 'mcp',
    label,
    created: false,
    updated: true,
    filePath,
    relativePath: HERMES_CONFIG_RELATIVE_PATH,
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
  } else if (isForceResolveEnabled()) {
    const replaced = replaceTomlSection(content, 'mcp_servers.brainclaw', brainclawBlock.slice(1) + '\n');
    if (replaced !== content) {
      content = replaced;
      changed = true;
    }
  }

  // Per-tool approval blocks: ALWAYS sync to the current catalog, regardless
  // of force-resolve state. These sections are purely machine-managed (no user
  // edits expected) and must match the narrowed headless-auto catalog.
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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Continue MCP settings', filePath, CONTINUE_CONFIG_RELATIVE_PATH);
  }

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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Continue MCP settings (global, all projects)', filePath);
  }
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
  const label = 'Continue tool permissions';
  const noop = { kind: 'permissions' as const, label, created: false, updated: false, filePath };

  // Update only the per-tool `allow` flags in the YAML document; never
  // round-trip the whole user file (comments/anchors/key order survive) and
  // never replace an unparseable file with a stub.
  let doc: ReturnType<typeof yaml.parseDocument> | undefined;
  let existingTools: JsonObject = {};
  if (fs.existsSync(filePath)) {
    doc = yaml.parseDocument(stripBom(fs.readFileSync(filePath, 'utf-8')));
    if (doc.errors.length > 0) {
      return skippedAutoConfigResult('permissions', label, filePath);
    }
    const parsed: unknown = doc.toJS();
    if (parsed == null) {
      doc = undefined;
    } else if (isJsonObject(parsed)) {
      existingTools = isJsonObject(parsed.tools) ? parsed.tools : {};
    } else {
      return skippedAutoConfigResult('permissions', label, filePath);
    }
  }

  if (!doc) {
    const toolsObj: JsonObject = {};
    for (const name of getHeadlessAutoApprovedToolNames()) {
      toolsObj[name] = { allow: true };
    }
    const content = `# brainclaw manages the per-tool allow flags below\n${yaml.stringify({ tools: toolsObj })}`;
    const { created, updated } = writeTextFileIfChanged(filePath, content);
    return { ...noop, created, updated };
  }

  let changed = false;
  try {
    for (const name of getHeadlessAutoApprovedToolNames()) {
      const current = existingTools[name];
      const allow = isJsonObject(current) ? current.allow : undefined;
      if (allow !== true) {
        if (current !== undefined && !isJsonObject(current)) {
          doc.setIn(['tools', name], { allow: true });
        } else {
          doc.setIn(['tools', name, 'allow'], true);
        }
        changed = true;
      }
    }
  } catch {
    return skippedAutoConfigResult('permissions', label, filePath);
  }

  if (!changed) {
    return noop;
  }

  fs.writeFileSync(filePath, doc.toString(), 'utf-8');
  return { ...noop, updated: true };
}

export function ensureOpenCodeMcpConfig(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, 'opencode.json');
  const existing = readJsonObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'OpenCode MCP config', filePath, OPENCODE_CONFIG_RELATIVE_PATH);
  }
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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'Antigravity MCP config', filePath, ANTIGRAVITY_MCP_RELATIVE_PATH);
  }
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

/**
 * Writes `.cursor/hooks.json` — Cursor's native hooks config.
 * Events: sessionStart, beforeSubmitPrompt, stop (Cursor uses camelCase).
 * Format per https://cursor.com/docs/hooks: version 1, type "command".
 */
export function ensureCursorHooks(cwd: string): AutoConfigWriteResult {
  const filePath = path.join(cwd, CURSOR_HOOKS_RELATIVE_PATH);
  const existing = readJsonObject(filePath);
  if (existing === undefined) {
    return skippedAutoConfigResult('rule', 'Cursor session hooks', filePath, CURSOR_HOOKS_RELATIVE_PATH);
  }
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
  if (existing === undefined) {
    return skippedAutoConfigResult('rule', 'Antigravity session hooks', filePath, ANTIGRAVITY_HOOKS_RELATIVE_PATH);
  }

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
  if (existing === undefined) {
    return skippedAutoConfigResult('rule', 'Copilot session hooks', filePath, COPILOT_HOOKS_RELATIVE_PATH);
  }
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
  if (existing === undefined) {
    return skippedAutoConfigResult('mcp', 'OpenClaw MCP config', filePath, OPENCLAW_MCP_RELATIVE_PATH);
  }
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

// ── Per-agent writer descriptors (pln#546) ────────────────────────────────
//
// AGENT_WIRING_REGISTRY collapses what used to be three divergent dispatch
// tables — writeDetectedAgentAutoConfig (init/setup), writeExportCompanionFiles
// (export), and patchAllMcpConfigs (upgrade/doctor) — into a single per-agent
// descriptor. Each writer receives a uniform context (cwd / homeDir / env /
// optional workspacePath) and returns one or more AutoConfigWriteResult. The
// three orchestrators below just iterate this registry; adding a new agent N+1
// is a data entry, not a 3-table cross-edit.
//
// Writer grouping:
//   - workspaceWriters: project-scoped configs (cwd) — MCP, rules, skills, hooks
//   - userWriters: machine-scoped configs (homeDir) — fabricated only when the
//     agent is installed per agents-inventory (avoids polluting unrelated
//     machines with user-level config stubs)
//   - hookWriters: subset of workspace writers that target hook configs
//     (kept as a separate array so doctor / status can surface "wired with
//     hooks" vs "wired without hooks" without re-running every writer)

export interface AgentWriterContext {
  cwd: string;
  homeDir: string | undefined;
  env: NodeJS.ProcessEnv;
  /** Workspace path passed to writers that embed it (e.g. Hermes external_dirs). */
  workspacePath?: string;
}

export type AgentWriterFn = (ctx: AgentWriterContext) => AutoConfigWriteResult | AutoConfigWriteResult[] | undefined | null;

export interface AgentWriterDescriptor {
  workspaceWriters: AgentWriterFn[];
  userWriters: AgentWriterFn[];
  hookWriters: AgentWriterFn[];
}

// Shared writer builders — referenced across multiple agents.
const writeUniversalSkill: AgentWriterFn = (ctx) => ensureUniversalBrainclawSkill(ctx.cwd);
const writeProtocolSkills: AgentWriterFn = (ctx) => ensureProtocolSkills(ctx.cwd);
const writeVscodeExtensionRec: AgentWriterFn = (ctx) => ensureVscodeExtensionRecommendation(ctx.cwd);

/**
 * Per-agent writer wiring. The keys are canonical agent names from
 * `AgentName` (see agent-capability.ts) — keep in sync with AGENT_EXPORT_REGISTRY.
 * Agents missing from this map yield an empty writer list (no-op detection),
 * which the drift test below guards against.
 */
export const AGENT_WIRING_REGISTRY: Record<string, AgentWriterDescriptor> = {
  'claude-code': {
    // .claude/settings.local.json bundles permissions + session/Stop/PostToolUse
    // hooks in one file, so it lives in workspaceWriters — not duplicated in
    // hookWriters (which would double-count the result).
    workspaceWriters: [
      (ctx) => ensureClaudeCodeMcpConfig(ctx.cwd),
      (ctx) => ensureClaudeCodeCommand(ctx.cwd),
      (ctx) => ensureClaudeCodeSettings(ctx.cwd),
      writeVscodeExtensionRec,
      (ctx) => ensureProjectDevDependency(ctx.cwd),
    ],
    userWriters: [
      (ctx) => ensureClaudeCodeUserSettings(ctx.homeDir, ctx.env),
      (ctx) => ensureClaudeCodeUserCommand(ctx.homeDir),
    ],
    hookWriters: [],
  },
  cline: {
    workspaceWriters: [(ctx) => ensureClineMcpConfig(ctx.cwd)],
    userWriters: [],
    hookWriters: [],
  },
  windsurf: {
    workspaceWriters: [(ctx) => ensureWindsurfModernRules(ctx.cwd)],
    userWriters: [(ctx) => ensureWindsurfMcpConfig(ctx.homeDir)],
    hookWriters: [],
  },
  'github-copilot': {
    workspaceWriters: [
      (ctx) => ensureCopilotMcpConfig(ctx.cwd),
      (ctx) => ensureCopilotSkill(ctx.cwd),
      writeUniversalSkill,
      writeProtocolSkills,
      writeVscodeExtensionRec,
    ],
    userWriters: [],
    hookWriters: [(ctx) => ensureCopilotHooks(ctx.cwd)],
  },
  cursor: {
    workspaceWriters: [
      (ctx) => ensureCursorMdc(ctx.cwd),
      writeUniversalSkill,
      writeProtocolSkills,
    ],
    userWriters: [(ctx) => ensureCursorMcpConfig(ctx.homeDir)],
    hookWriters: [(ctx) => ensureCursorHooks(ctx.cwd)],
  },
  roo: {
    workspaceWriters: [
      (ctx) => ensureRooMcpConfig(ctx.cwd),
      writeUniversalSkill,
      writeProtocolSkills,
    ],
    userWriters: [],
    hookWriters: [],
  },
  kilocode: {
    workspaceWriters: [
      (ctx) => ensureKilocodeMcpConfig(ctx.cwd),
      (ctx) => ensureKilocodeConfig(ctx.cwd),
      writeUniversalSkill,
      writeProtocolSkills,
    ],
    userWriters: [],
    hookWriters: [],
  },
  'mistral-vibe': {
    workspaceWriters: [
      (ctx) => ensureMistralVibeMcpConfig(ctx.cwd),
      writeUniversalSkill,
      writeProtocolSkills,
    ],
    userWriters: [],
    hookWriters: [],
  },
  hermes: {
    workspaceWriters: [
      writeUniversalSkill,
      writeProtocolSkills,
    ],
    userWriters: [(ctx) => ensureHermesMcpConfig(ctx.homeDir, ctx.workspacePath ?? ctx.cwd)],
    hookWriters: [],
  },
  codex: {
    workspaceWriters: [
      writeUniversalSkill,
      writeProtocolSkills,
    ],
    userWriters: [(ctx) => ensureCodexMcpConfig(ctx.homeDir, ctx.env)],
    hookWriters: [],
  },
  continue: {
    workspaceWriters: [(ctx) => ensureContinueMcpConfig(ctx.cwd)],
    userWriters: [
      (ctx) => ensureContinueUserMcpConfig(ctx.homeDir),
      (ctx) => ensureContinueUserPermissions(ctx.homeDir),
    ],
    hookWriters: [],
  },
  opencode: {
    workspaceWriters: [
      (ctx) => ensureOpenCodeMcpConfig(ctx.cwd),
      writeUniversalSkill,
      writeProtocolSkills,
    ],
    userWriters: [],
    hookWriters: [],
  },
  antigravity: {
    workspaceWriters: [],
    userWriters: [(ctx) => ensureAntigravityMcpConfig(ctx.homeDir)],
    // Antigravity hook config lives under the user home — keep it in
    // hookWriters (semantic grouping) but skip with the inventory gate like
    // the other user-level fabricators.
    hookWriters: [(ctx) => ensureAntigravityHooks(ctx.homeDir)],
  },
  openclaw: {
    workspaceWriters: [],
    userWriters: [(ctx) => ensureOpenClawMcpConfig(ctx.homeDir)],
    hookWriters: [],
  },
  // Pure SKILL.md surfaces — nanoclaw/nemoclaw/picoclaw/zeroclaw have no MCP
  // config and their instruction file is written by the export pipeline.
  nanoclaw: { workspaceWriters: [], userWriters: [], hookWriters: [] },
  nemoclaw: { workspaceWriters: [], userWriters: [], hookWriters: [] },
  picoclaw: { workspaceWriters: [], userWriters: [], hookWriters: [] },
  zeroclaw: { workspaceWriters: [], userWriters: [], hookWriters: [] },
  // claude-sonnet: shares CLAUDE.md surface with claude-code; the workspace
  // and user wiring is identical, so detection should reuse claude-code's
  // descriptor rather than duplicate it.
  'claude-sonnet': {
    workspaceWriters: [
      (ctx) => ensureClaudeCodeMcpConfig(ctx.cwd),
      (ctx) => ensureClaudeCodeCommand(ctx.cwd),
      (ctx) => ensureClaudeCodeSettings(ctx.cwd),
      writeVscodeExtensionRec,
      (ctx) => ensureProjectDevDependency(ctx.cwd),
    ],
    userWriters: [
      (ctx) => ensureClaudeCodeUserSettings(ctx.homeDir, ctx.env),
      (ctx) => ensureClaudeCodeUserCommand(ctx.homeDir),
    ],
    hookWriters: [],
  },
};

/**
 * Drain a writer's return value into the result list (skip null/undefined,
 * flatten arrays from writers like ensureProtocolSkills).
 */
function pushWriterResult(
  results: AutoConfigWriteResult[],
  value: AutoConfigWriteResult | AutoConfigWriteResult[] | undefined | null,
): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const r of value) results.push(r);
  } else {
    results.push(value);
  }
}

/**
 * Run a descriptor's writers against the given context. The `skipUserIfNotInstalled`
 * flag consults `isAgentInstalledPerInventory` and drops user-level writers when
 * the agent isn't present on this machine — preventing init from fabricating
 * `~/.codex/config.toml` (etc.) on machines that never had codex installed.
 */
function runAgentWriters(
  descriptor: AgentWriterDescriptor,
  ctx: AgentWriterContext,
  agentName: string,
  opts: { skipUserIfNotInstalled?: boolean; kindFilter?: AutoConfigWriteResult['kind'] } = {},
): AutoConfigWriteResult[] {
  const out: AutoConfigWriteResult[] = [];

  for (const fn of descriptor.workspaceWriters) pushWriterResult(out, fn(ctx));
  for (const fn of descriptor.hookWriters) pushWriterResult(out, fn(ctx));

  // User-level writers fabricate machine-wide config. When agents-inventory is
  // available and reports the agent as NOT installed, skip them — see the
  // brief's "consult agent-inventory before fabricating user-level configs".
  const installed = opts.skipUserIfNotInstalled
    ? isAgentInstalledPerInventory(agentName)
    : undefined;
  const skipUser = opts.skipUserIfNotInstalled && installed === false;
  if (!skipUser) {
    for (const fn of descriptor.userWriters) pushWriterResult(out, fn(ctx));
  }

  if (opts.kindFilter) {
    return out.filter((r) => r.kind === opts.kindFilter);
  }
  return out;
}

export function writeDetectedAgentAutoConfig(
  agentName: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoConfigWriteResult[] {
  const descriptor = AGENT_WIRING_REGISTRY[agentName];
  if (!descriptor) return [];
  const ctx: AgentWriterContext = { cwd, homeDir: resolveHomeDir(env), env, workspacePath: cwd };
  return runAgentWriters(descriptor, ctx, agentName);
}

/**
 * Map an ExportFormat to the agent whose wiring should run. For formats shared
 * by multiple agents (e.g. agents-md is reused by codex / opencode / mistral /
 * hermes), the registry order in AGENT_EXPORT_REGISTRY determines the winner —
 * matching the existing dedupe behaviour in `brainclaw export --all`.
 */
function resolveAgentForFormat(format: ExportFormat): string | undefined {
  return AGENT_EXPORT_REGISTRY.find((t) => t.format === format)?.agentName;
}

export function writeExportCompanionFiles(
  format: ExportFormat,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoConfigWriteResult[] {
  const agentName = resolveAgentForFormat(format);
  if (!agentName) return [];
  const descriptor = AGENT_WIRING_REGISTRY[agentName];
  if (!descriptor) return [];
  const ctx: AgentWriterContext = { cwd, homeDir: resolveHomeDir(env), env, workspacePath: cwd };
  // Export is "I want this surface even if the agent isn't installed yet" —
  // the user explicitly asked for it, so we don't gate on the inventory.
  return runAgentWriters(descriptor, ctx, agentName);
}

/**
 * Patch all MCP config files to use the currently resolved brainclaw binary.
 *
 * Called after upgrade / version --publish-local to fix stale paths.
 * Re-resolves the brainclaw command, then iterates AGENT_WIRING_REGISTRY with
 * force-resolve enabled, filtering writer output to `kind: 'mcp'`. Agents that
 * aren't installed on this machine skip their user-level writers (avoids
 * minting unrelated user configs as a side effect of an upgrade).
 *
 * Returns the list of configs that were actually updated (not just created).
 */
export function patchAllMcpConfigs(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoConfigWriteResult[] {
  // Clear cached path so resolution picks up the new install location
  resetMcpCommandCache();

  const ctx: AgentWriterContext = { cwd, homeDir: resolveHomeDir(env), env, workspacePath: cwd };

  // Run inside withForcedResolve so brainclawMcpEntry overwrites existing
  // absolute paths in user configs (the whole point of the patch pass).
  const results = withForcedResolve<AutoConfigWriteResult[]>(() => {
    const acc: AutoConfigWriteResult[] = [];
    for (const [agentName, descriptor] of Object.entries(AGENT_WIRING_REGISTRY)) {
      const agentResults = runAgentWriters(descriptor, ctx, agentName, {
        skipUserIfNotInstalled: true,
        kindFilter: 'mcp',
      });
      for (const r of agentResults) acc.push(r);
    }
    return acc;
  });

  // Dedupe by filePath — claude-code and claude-sonnet share writers; running
  // each one twice would emit duplicate "Updated …/.mcp.json" lines.
  const seen = new Set<string>();
  const deduped: AutoConfigWriteResult[] = [];
  for (const r of results) {
    if (seen.has(r.filePath)) continue;
    seen.add(r.filePath);
    deduped.push(r);
  }

  return deduped.filter((r) => r.created || r.updated);
}
