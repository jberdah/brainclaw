import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { MEMORY_DIR } from './io.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentModelInfo {
  name: string;
  /** Approximate context window in tokens (if known) */
  context_window?: number;
}

export interface AgentInventoryEntry {
  /** Canonical agent name (e.g. 'claude-code', 'cursor') */
  name: string;
  /** Whether the agent is installed / detectable on this machine */
  installed: boolean;
  /** How we detected it */
  detection_method: string;
  /** Version string if discoverable */
  version?: string;
  /** Models this agent can use (known or configured) */
  models: AgentModelInfo[];
  /** Native tools the agent provides (read, write, bash, etc.) */
  native_tools: string[];
  /** Whether agent supports MCP servers */
  mcp_support: boolean;
  /** MCP config format and path pattern */
  mcp_config_format?: string;
  /** Whether agent supports skills/commands */
  skills_support: boolean;
  /** Skills path pattern (e.g. '.claude/commands/') */
  skills_path_pattern?: string;
  /** Whether agent supports custom rules */
  rules_support: boolean;
  /** Whether agent supports hooks */
  hooks_support: boolean;
  /** Instruction file pattern (e.g. 'CLAUDE.md') */
  instruction_file?: string;
}

export interface AgentInventory {
  schema_version: number;
  generated_at: string;
  agents: AgentInventoryEntry[];
}

// ── Agent Definitions (static knowledge) ───────────────────────────────────────

interface AgentDefinition {
  name: string;
  /** How to detect if installed (checked in order) */
  detect: (homeDir: string, env: NodeJS.ProcessEnv) => { installed: boolean; method: string; version?: string };
  models: AgentModelInfo[];
  native_tools: string[];
  mcp_support: boolean;
  mcp_config_format?: string;
  skills_support: boolean;
  skills_path_pattern?: string;
  rules_support: boolean;
  hooks_support: boolean;
  instruction_file?: string;
}

function tryCommand(command: string, args: string[], timeout = 5000): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync(command, args, { encoding: 'utf-8', timeout, windowsHide: true });
    return { ok: r.status === 0, stdout: r.stdout ?? '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    name: 'claude-code',
    detect: (_home, env) => {
      // Check if claude CLI is available
      const cli = tryCommand('claude', ['--version'], 3000);
      if (cli.ok) {
        const ver = cli.stdout.trim().match(/(\d+\.\d+\.\d+)/)?.[1];
        return { installed: true, method: 'claude CLI', version: ver };
      }
      // Check env var (means it's running)
      if (env.CLAUDE_CODE_VERSION) {
        return { installed: true, method: 'CLAUDE_CODE_VERSION env', version: env.CLAUDE_CODE_VERSION };
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'claude-opus-4-6', context_window: 1000000 },
      { name: 'claude-sonnet-4-6', context_window: 200000 },
      { name: 'claude-haiku-4-5', context_window: 200000 },
    ],
    native_tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch', 'NotebookEdit'],
    mcp_support: true,
    mcp_config_format: '.mcp.json (workspace)',
    skills_support: true,
    skills_path_pattern: '.claude/commands/',
    rules_support: false,
    hooks_support: true,
    instruction_file: 'CLAUDE.md',
  },
  {
    name: 'cursor',
    detect: (home) => {
      // Check for Cursor config directories
      const cursorDir = path.join(home, '.cursor');
      if (fs.existsSync(cursorDir)) {
        return { installed: true, method: '~/.cursor directory' };
      }
      // Check common install paths
      if (process.platform === 'win32') {
        const appData = process.env.LOCALAPPDATA ?? '';
        if (appData && fs.existsSync(path.join(appData, 'Programs', 'cursor'))) {
          return { installed: true, method: 'AppData/Programs/cursor' };
        }
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'claude-sonnet-4-6', context_window: 200000 },
      { name: 'gpt-4o', context_window: 128000 },
      { name: 'cursor-small', context_window: 128000 },
    ],
    native_tools: ['edit', 'terminal', 'codebase-search', 'file-search'],
    mcp_support: true,
    mcp_config_format: '.cursor/mcp.json (machine)',
    skills_support: false,
    rules_support: true,
    hooks_support: false,
    instruction_file: '.cursor/rules/',
  },
  {
    name: 'codex',
    detect: (home) => {
      const codexDir = path.join(home, '.codex');
      if (fs.existsSync(codexDir)) {
        return { installed: true, method: '~/.codex directory' };
      }
      const cli = tryCommand('codex', ['--version'], 3000);
      if (cli.ok) {
        const ver = cli.stdout.trim().match(/(\d+\.\d+\.\d+)/)?.[1];
        return { installed: true, method: 'codex CLI', version: ver };
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'o4-mini', context_window: 200000 },
      { name: 'o3', context_window: 200000 },
      { name: 'gpt-4.1', context_window: 1000000 },
    ],
    native_tools: ['shell', 'file_read', 'file_write', 'file_edit'],
    mcp_support: true,
    mcp_config_format: '.codex/config.toml (TOML)',
    skills_support: true,
    skills_path_pattern: '.codex/skills/',
    rules_support: false,
    hooks_support: false,
    instruction_file: 'AGENTS.md',
  },
  {
    name: 'windsurf',
    detect: (home) => {
      if (process.platform === 'win32') {
        const appData = process.env.LOCALAPPDATA ?? '';
        if (appData && fs.existsSync(path.join(appData, 'Programs', 'windsurf'))) {
          return { installed: true, method: 'AppData/Programs/windsurf' };
        }
      }
      // Check for Windsurf config
      const wsConfig = path.join(home, '.codeium', 'windsurf');
      if (fs.existsSync(wsConfig)) {
        return { installed: true, method: '~/.codeium/windsurf directory' };
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'claude-sonnet-4-6', context_window: 200000 },
      { name: 'gpt-4o', context_window: 128000 },
    ],
    native_tools: ['edit', 'terminal', 'search'],
    mcp_support: true,
    mcp_config_format: '.codeium/windsurf/mcp_config.json',
    skills_support: false,
    rules_support: true,
    hooks_support: true,
    instruction_file: '.windsurfrules',
  },
  {
    name: 'github-copilot',
    detect: (_home, env) => {
      if (env.GITHUB_COPILOT_TOKEN || env.GITHUB_COPILOT_PRODUCT) {
        return { installed: true, method: 'GITHUB_COPILOT_* env' };
      }
      // Check VS Code extensions directory for copilot
      const vscodeExt = path.join(_home, '.vscode', 'extensions');
      if (fs.existsSync(vscodeExt)) {
        try {
          const exts = fs.readdirSync(vscodeExt);
          if (exts.some(e => e.startsWith('github.copilot-'))) {
            return { installed: true, method: 'VS Code extension' };
          }
        } catch { /* non-fatal */ }
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'gpt-4o', context_window: 128000 },
      { name: 'claude-sonnet-4-6', context_window: 200000 },
    ],
    native_tools: ['code-completion', 'chat', 'inline-edit'],
    mcp_support: false,
    skills_support: true,
    skills_path_pattern: '.github/skills/',
    rules_support: false,
    hooks_support: false,
    instruction_file: '.github/copilot-instructions.md',
  },
  {
    name: 'cline',
    detect: (_home, env) => {
      if (env.CLINE_AGENT || env.CLINE_SESSION_ID) {
        return { installed: true, method: 'CLINE_* env' };
      }
      const vscodeExt = path.join(_home, '.vscode', 'extensions');
      if (fs.existsSync(vscodeExt)) {
        try {
          const exts = fs.readdirSync(vscodeExt);
          if (exts.some(e => e.includes('cline'))) {
            return { installed: true, method: 'VS Code extension' };
          }
        } catch { /* non-fatal */ }
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'claude-sonnet-4-6', context_window: 200000 },
      { name: 'gpt-4o', context_window: 128000 },
    ],
    native_tools: ['read_file', 'write_file', 'execute_command', 'browser_action', 'search_files'],
    mcp_support: true,
    mcp_config_format: '.vscode/cline_mcp_settings.json',
    skills_support: false,
    rules_support: true,
    hooks_support: false,
    instruction_file: '.clinerules/',
  },
  {
    name: 'roo',
    detect: (_home, env) => {
      if (env.ROO_AGENT || env.ROO_SESSION_ID) {
        return { installed: true, method: 'ROO_* env' };
      }
      const vscodeExt = path.join(_home, '.vscode', 'extensions');
      if (fs.existsSync(vscodeExt)) {
        try {
          const exts = fs.readdirSync(vscodeExt);
          if (exts.some(e => e.includes('roo'))) {
            return { installed: true, method: 'VS Code extension' };
          }
        } catch { /* non-fatal */ }
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'claude-sonnet-4-6', context_window: 200000 },
    ],
    native_tools: ['read_file', 'write_file', 'execute_command', 'browser_action', 'search_files'],
    mcp_support: true,
    mcp_config_format: '.roo/mcp.json',
    skills_support: false,
    rules_support: true,
    hooks_support: false,
    instruction_file: '.roo/rules/',
  },
  {
    name: 'opencode',
    detect: (home, env) => {
      if (env.OPENCODE_SESSION_ID || env.OPENCODE_AGENT) {
        return { installed: true, method: 'OPENCODE_* env' };
      }
      if (fs.existsSync(path.join(home, '.config', 'opencode'))) {
        return { installed: true, method: '~/.config/opencode directory' };
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'claude-sonnet-4-6', context_window: 200000 },
      { name: 'gpt-4o', context_window: 128000 },
    ],
    native_tools: ['file_read', 'file_write', 'shell', 'search'],
    mcp_support: true,
    mcp_config_format: 'opencode.json',
    skills_support: false,
    rules_support: false,
    hooks_support: false,
    instruction_file: 'AGENTS.md',
  },
  {
    name: 'antigravity',
    detect: (home, env) => {
      if (env.ANTIGRAVITY_SESSION_ID || env.ANTIGRAVITY_AGENT) {
        return { installed: true, method: 'ANTIGRAVITY_* env' };
      }
      if (fs.existsSync(path.join(home, '.gemini', 'antigravity'))) {
        return { installed: true, method: '~/.gemini/antigravity directory' };
      }
      const cli = tryCommand('gemini', ['--version'], 3000);
      if (cli.ok) {
        return { installed: true, method: 'gemini CLI', version: cli.stdout.trim() };
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'gemini-2.5-pro', context_window: 1000000 },
      { name: 'gemini-2.5-flash', context_window: 1000000 },
    ],
    native_tools: ['shell', 'file_read', 'file_write', 'file_edit', 'web_search'],
    mcp_support: true,
    mcp_config_format: '.gemini/antigravity/mcp_config.json',
    skills_support: false,
    rules_support: false,
    hooks_support: false,
    instruction_file: 'GEMINI.md',
  },
  {
    name: 'continue',
    detect: (_home, env) => {
      if (env.CONTINUE_AGENT || env.CONTINUE_SESSION_ID) {
        return { installed: true, method: 'CONTINUE_* env' };
      }
      const vscodeExt = path.join(_home, '.vscode', 'extensions');
      if (fs.existsSync(vscodeExt)) {
        try {
          const exts = fs.readdirSync(vscodeExt);
          if (exts.some(e => e.includes('continue'))) {
            return { installed: true, method: 'VS Code extension' };
          }
        } catch { /* non-fatal */ }
      }
      return { installed: false, method: '' };
    },
    models: [
      { name: 'claude-sonnet-4-6', context_window: 200000 },
      { name: 'gpt-4o', context_window: 128000 },
    ],
    native_tools: ['edit', 'terminal', 'codebase-search'],
    mcp_support: true,
    mcp_config_format: '.continue/config.json',
    skills_support: false,
    rules_support: true,
    hooks_support: false,
    instruction_file: '.continue/rules/',
  },
];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Detect ALL installed agents on this machine (not just the running one).
 */
export function buildAgentInventory(
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): AgentInventory {
  const agents: AgentInventoryEntry[] = AGENT_DEFINITIONS.map(def => {
    const detection = def.detect(homeDir, env);
    return {
      name: def.name,
      installed: detection.installed,
      detection_method: detection.method,
      version: detection.version,
      models: def.models,
      native_tools: def.native_tools,
      mcp_support: def.mcp_support,
      mcp_config_format: def.mcp_config_format,
      skills_support: def.skills_support,
      skills_path_pattern: def.skills_path_pattern,
      rules_support: def.rules_support,
      hooks_support: def.hooks_support,
      instruction_file: def.instruction_file,
    };
  });

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    agents,
  };
}

/**
 * Path to the agent inventory file.
 */
export function agentInventoryPath(): string {
  return path.join(os.homedir(), MEMORY_DIR, 'agents-inventory.yaml');
}

/**
 * Save agent inventory to ~/.brainclaw/agents-inventory.yaml.
 */
export function saveAgentInventory(inventory: AgentInventory): string {
  const filePath = agentInventoryPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = yaml.stringify(inventory, { lineWidth: 120 });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Load agent inventory from ~/.brainclaw/agents-inventory.yaml.
 */
export function loadAgentInventory(): AgentInventory | undefined {
  const filePath = agentInventoryPath();
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return yaml.parse(content) as AgentInventory;
  } catch {
    return undefined;
  }
}

/**
 * Render a human-readable summary of the agent inventory.
 */
export function renderAgentInventorySummary(inventory: AgentInventory): string {
  const lines: string[] = [];
  const installed = inventory.agents.filter(a => a.installed);
  const notInstalled = inventory.agents.filter(a => !a.installed);

  lines.push(`Agents detected: ${installed.length}/${inventory.agents.length}`);
  lines.push('');

  for (const agent of installed) {
    const ver = agent.version ? ` v${agent.version}` : '';
    lines.push(`✔ ${agent.name}${ver} (${agent.detection_method})`);
    lines.push(`  Models: ${agent.models.map(m => m.name).join(', ')}`);
    lines.push(`  Tools: ${agent.native_tools.join(', ')}`);

    const features: string[] = [];
    if (agent.mcp_support) features.push('MCP');
    if (agent.skills_support) features.push('Skills');
    if (agent.rules_support) features.push('Rules');
    if (agent.hooks_support) features.push('Hooks');
    lines.push(`  Features: ${features.join(', ') || 'none'}`);

    if (agent.instruction_file) {
      lines.push(`  Instructions: ${agent.instruction_file}`);
    }
    lines.push('');
  }

  if (notInstalled.length > 0) {
    lines.push(`Not detected: ${notInstalled.map(a => a.name).join(', ')}`);
  }

  lines.push(`Inventory generated: ${inventory.generated_at}`);
  return lines.join('\n');
}

// ── Inventory Diff ──────────────────────────────────────────────────────────

export interface InventoryDiff {
  appeared: string[];
  disappeared: string[];
  version_changed: Array<{ name: string; from?: string; to?: string }>;
}

/**
 * Compare two agent inventories and return what changed.
 * Only considers agents that are `installed` in either snapshot.
 */
export function diffInventory(previous: AgentInventory | undefined, current: AgentInventory): InventoryDiff {
  const prevMap = new Map(
    (previous?.agents ?? []).filter(a => a.installed).map(a => [a.name, a]),
  );
  const currMap = new Map(
    current.agents.filter(a => a.installed).map(a => [a.name, a]),
  );

  const appeared: string[] = [];
  const disappeared: string[] = [];
  const version_changed: InventoryDiff['version_changed'] = [];

  for (const [name, entry] of currMap) {
    if (!prevMap.has(name)) {
      appeared.push(name);
    } else {
      const prev = prevMap.get(name)!;
      if (prev.version !== entry.version && (prev.version || entry.version)) {
        version_changed.push({ name, from: prev.version, to: entry.version });
      }
    }
  }
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) {
      disappeared.push(name);
    }
  }

  return { appeared, disappeared, version_changed };
}
