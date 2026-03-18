import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { runInit } from './init.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import { buildMachineProfile, saveMachineProfile, loadMachineProfile } from '../core/machine-profile.js';
import { buildAgentInventory, saveAgentInventory, loadAgentInventory } from '../core/agent-inventory.js';
import {
  ensureClaudeCodeUserSettings,
  ensureClaudeCodeUserCommand,
  ensureCursorMcpConfig,
  ensureWindsurfMcpConfig,
  ensureAntigravityMcpConfig,
  ensureContinueUserMcpConfig,
  ensureCodexMcpConfig,
  writeDetectedAgentAutoConfig,
  describeAutoConfigWrite,
} from '../core/agent-files.js';
import { memoryExists, writeFileAtomic, ensureMemoryDir } from '../core/io.js';
import { loadConfig, saveConfig, defaultConfig } from '../core/config.js';
import { writeDetectedAgentHooks } from './hooks.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SetupOptions {
  roots?: string;
  agents?: string;
  repos?: string;
  yes?: boolean;
}

export interface RepoInfo {
  path: string;
  name: string;
  alreadyInitialised: boolean;
}

export interface SetupState {
  completed_at: string;
  roots: string[];
  initialised_repos: string[];
  global_configs_written: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const ALL_KNOWN_AGENTS = [
  'claude-code',
  'cursor',
  'windsurf',
  'github-copilot',
  'cline',
  'codex',
  'opencode',
  'antigravity',
  'continue',
  'roo',
];

const BRAINCLAW_ASCII = [
  '',
  '    ╔╗ ┬─┐┌─┐┬┌┐┌╔═╗╦  ╔═╗╦ ╦',
  '    ╠╩╗├┬┘├─┤││││║  ║  ╠═╣║║║',
  '    ╚═╝┴└─┴ ┴┴┘└┘╚═╝╩═╝╴ ╴╚╩╝',
  '',
].join('\n');

// ─── Home dir resolution ──────────────────────────────────────────────────────

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

// ─── Setup state ──────────────────────────────────────────────────────────────

function setupStatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = resolveHomeDir(env);
  if (!home) return undefined;
  return path.join(home, '.brainclaw', 'setup.json');
}

export function readSetupState(env: NodeJS.ProcessEnv = process.env): SetupState | undefined {
  const statePath = setupStatePath(env);
  if (!statePath) return undefined;
  try {
    if (!fs.existsSync(statePath)) return undefined;
    const raw = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as SetupState;
  } catch {
    return undefined;
  }
}

function writeSetupState(state: SetupState, env: NodeJS.ProcessEnv = process.env): void {
  const statePath = setupStatePath(env);
  if (!statePath) return;
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + '\n');
}

// ─── Step 0: Git check ────────────────────────────────────────────────────────

export function checkGitPresence(): boolean {
  const result = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  return !result.error && result.status === 0;
}

// ─── Step 1: Roots ────────────────────────────────────────────────────────────

function getDefaultRoots(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHomeDir(env) ?? '';
  const candidates = ['Projects', 'dev', 'code', 'repos'].map((d) => path.join(home, d));
  const existing = candidates.filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
  return existing.length > 0 ? existing.join(',') : '';
}

export function parseRoots(input: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = resolveHomeDir(env) ?? '';
  const results: string[] = [];
  for (const raw of input.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = trimmed.startsWith('~') ? trimmed.replace(/^~/, home) : trimmed;
    try {
      if (fs.statSync(resolved).isDirectory()) {
        results.push(resolved);
      } else {
        console.warn(`  ⚠ Not a directory: ${resolved}`);
      }
    } catch {
      console.warn(`  ⚠ Path not found: ${resolved}`);
    }
  }
  return results;
}

// ─── Step 2: Scan repos ───────────────────────────────────────────────────────

export function scanGitRepos(roots: string[]): RepoInfo[] {
  const repos: RepoInfo[] = [];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const repoPath = path.join(root, entry.name);
        if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
        repos.push({
          path: repoPath,
          name: entry.name,
          alreadyInitialised: memoryExists(repoPath),
        });
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return repos;
}

// ─── Step 3: Repo selection ───────────────────────────────────────────────────

export function parseRepoSelection(
  choice: string,
  repos: RepoInfo[],
  cwd: string = process.cwd(),
): RepoInfo[] {
  const c = choice.trim().toLowerCase();
  if (c === 'a' || c === 'all') return repos;
  if (c === 'c' || c === 'current') {
    const curr = repos.find((r) => r.path === cwd)
      ?? repos.find((r) => cwd.startsWith(r.path + path.sep));
    return curr ? [curr] : [];
  }
  const indices = c
    .split(',')
    .map((n) => parseInt(n.trim(), 10) - 1)
    .filter((i) => !isNaN(i) && i >= 0 && i < repos.length);
  return indices.map((i) => repos[i]!);
}

// ─── Step 4: Agent selection ──────────────────────────────────────────────────

export function parseAgentSelection(choice: string, detected: string | undefined): string[] {
  const c = choice.trim().toLowerCase();
  if (c === 'a' || c === 'all') return [...ALL_KNOWN_AGENTS];
  if (c === 'd' || c === 'detected') return detected ? [detected] : [];
  return c.split(',').map((a) => a.trim()).filter((a) => ALL_KNOWN_AGENTS.includes(a));
}

// ─── Step 5: Global install ───────────────────────────────────────────────────

export function initUserStore(
  home: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!home) return [];
  const written: string[] = [];

  // Ensure ~/.brainclaw/ directory and subdirs exist
  const userStorePath = path.join(home, '.brainclaw');
  ensureMemoryDir(home);

  // Check if config.yaml already exists (idempotent)
  const configPath = path.join(userStorePath, 'config.yaml');
  if (fs.existsSync(configPath)) {
    return [];
  }

  try {
    // Write a minimal config.yaml for the user store
    const defaultCfg = defaultConfig('user-global');
    saveConfig(defaultCfg, home);

    // Append store_type: user to the config.yaml (pattern already used in tests)
    fs.appendFileSync(configPath, 'store_type: user\n');
    written.push(configPath);
  } catch (err) {
    // Non-fatal: if user store init fails, continue with agent setup
    console.warn(`Warning: failed to initialize user store at ${configPath}:`, err instanceof Error ? err.message : String(err));
  }

  return written;
}

export function runGlobalInstall(
  selectedAgents: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = resolveHomeDir(env);
  const written: string[] = [];

  // Initialize user-global store first
  if (home) {
    written.push(...initUserStore(home, env));
  }

  // Generate machine profile if missing
  try {
    const existing = loadMachineProfile();
    if (!existing) {
      const profile = buildMachineProfile();
      const profilePath = saveMachineProfile(profile);
      written.push(profilePath);
    }
  } catch {
    // Non-fatal: machine profile is optional
  }

  // Generate agent inventory if missing
  try {
    const existingInv = loadAgentInventory();
    if (!existingInv) {
      const inventory = buildAgentInventory();
      const inventoryPath = saveAgentInventory(inventory);
      written.push(inventoryPath);
    }
  } catch {
    // Non-fatal: agent inventory is optional
  }

  if (selectedAgents.includes('claude-code')) {
    const s = ensureClaudeCodeUserSettings(home, env);
    if (s && (s.created || s.updated)) written.push(s.filePath);
    const c = ensureClaudeCodeUserCommand(home);
    if (c && (c.created || c.updated)) written.push(c.filePath);
  }
  if (selectedAgents.includes('cursor')) {
    const r = ensureCursorMcpConfig(home);
    if (r && (r.created || r.updated)) written.push(r.filePath);
  }
  if (selectedAgents.includes('windsurf')) {
    const r = ensureWindsurfMcpConfig(home);
    if (r && (r.created || r.updated)) written.push(r.filePath);
  }
  if (selectedAgents.includes('antigravity')) {
    const r = ensureAntigravityMcpConfig(home);
    if (r && (r.created || r.updated)) written.push(r.filePath);
  }
  if (selectedAgents.includes('continue')) {
    const r = ensureContinueUserMcpConfig(home);
    if (r && (r.created || r.updated)) written.push(r.filePath);
  }
  if (selectedAgents.includes('codex')) {
    const r = ensureCodexMcpConfig(home, env);
    if (r && (r.created || r.updated)) written.push(r.filePath);
  }
  return written;
}

// ─── Step 6: Init repos + configure agents ────────────────────────────────────

export async function initReposAndConfigureAgents(
  selectedRepos: RepoInfo[],
  selectedAgents: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ initialisedRepos: string[]; configActions: string[] }> {
  const initialisedRepos: string[] = [];
  const configActions: string[] = [];

  for (const repo of selectedRepos) {
    if (repo.alreadyInitialised) {
      console.log(`  [skip] ${repo.name} — already initialised`);
      continue;
    }
    console.log(`  → Initialising ${repo.name}...`);
    await runInit({ yes: true, skipAgentBootstrap: true, cwd: repo.path });
    initialisedRepos.push(repo.path);
  }

  for (const repo of selectedRepos) {
    for (const agentName of selectedAgents) {
      const configs = writeDetectedAgentAutoConfig(agentName, repo.path, env);
      for (const config of configs) {
        const msg = describeAutoConfigWrite(config);
        if (msg) {
          console.log(`  ${msg}`);
          configActions.push(msg);
        }
      }
      const hooks = writeDetectedAgentHooks(agentName, repo.name, repo.path);
      for (const hook of hooks) {
        if (hook.created) {
          const msg = `✔ Created hook at ${hook.relativePath}`;
          console.log(`  ${msg}`);
          configActions.push(msg);
        }
      }
    }
  }

  return { initialisedRepos, configActions };
}

// ─── Step 7: Reload reminder ──────────────────────────────────────────────────

export function printReloadReminder(detectedAgent: string | undefined): void {
  console.log('');
  console.log('✔ Setup complete! Reload your AI agent session to activate brainclaw MCP tools.');
  if (detectedAgent === 'claude-code') {
    console.log('  → In VS Code: Cmd/Ctrl+Shift+P → "Claude: Reload MCP Servers"');
  } else if (detectedAgent === 'cursor') {
    console.log('  → In Cursor: restart the editor');
  } else if (detectedAgent === 'windsurf') {
    console.log('  → In Windsurf: restart the editor');
  } else if (detectedAgent === 'continue') {
    console.log('  → In VS Code: reload the Continue extension');
  } else {
    console.log('  → Restart your AI coding agent to pick up the new MCP configuration.');
  }
}

// ─── Main CLI wizard ──────────────────────────────────────────────────────────

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const env = process.env;

  // Step 0: Git check
  if (!checkGitPresence()) {
    console.error(BRAINCLAW_ASCII);
    console.error('brainclaw needs git to work.');
    console.error('Install git from https://git-scm.com and try again.');
    process.exit(1);
  }

  // Check if already run
  const existingState = readSetupState(env);
  if (existingState && !options.yes && process.stdin.isTTY) {
    const date = new Date(existingState.completed_at).toLocaleDateString();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`Setup already run on ${date}. Re-run? [y/N]: `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  // Step 1: Project roots
  let rootsInput: string;
  if (options.roots) {
    rootsInput = options.roots;
  } else if (options.yes || !process.stdin.isTTY) {
    rootsInput = process.cwd();
  } else {
    const defaultRoots = getDefaultRoots(env);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const prompt = defaultRoots
        ? `Where are your projects? [${defaultRoots}]: `
        : 'Where are your projects? Enter one or more root directories (comma-separated): ';
      const answer = (await rl.question(prompt)).trim();
      rootsInput = answer || defaultRoots || process.cwd();
    } finally {
      rl.close();
    }
  }

  const roots = parseRoots(rootsInput, env);
  if (roots.length === 0) {
    console.error('No valid project root directories found. Aborting.');
    process.exit(1);
  }

  // Step 2: Scan repos
  console.log('\nScanning for git repositories...');
  const repos = scanGitRepos(roots);
  if (repos.length === 0) {
    console.log('No git repositories found in the specified roots.');
    console.log('Tip: run `brainclaw init` from within a project directory.');
    return;
  }

  console.log(`Found ${repos.length} repository candidate(s):`);
  repos.forEach((r, i) => {
    const status = r.alreadyInitialised ? '[✔ init]' : '[      ]';
    console.log(`  ${i + 1}) ${status} ${r.name}  (${r.path})`);
  });

  // Step 3: Repo selection
  let repoChoice: string;
  if (options.repos) {
    repoChoice = options.repos;
  } else if (options.yes || !process.stdin.isTTY) {
    repoChoice = 'all';
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      repoChoice = (await rl.question('\nInitialise: (a)ll, (c)urrent dir, or enter numbers e.g. 1,3 [all]: ')).trim() || 'all';
    } finally {
      rl.close();
    }
  }

  const selectedRepos = parseRepoSelection(repoChoice, repos);
  if (selectedRepos.length === 0) {
    console.log('No repositories selected. Aborting.');
    return;
  }
  console.log(`\nSelected ${selectedRepos.length} repository(s).`);

  // Step 4: Agent detection & selection
  const detectedAi = detectAiAgent(env);
  const detectedName = detectedAi?.name;
  console.log('');
  if (detectedName) {
    console.log(`Detected AI agent: ${detectedName}`);
  } else {
    console.log('No AI agent detected automatically.');
  }
  console.log('Supported agents:');
  ALL_KNOWN_AGENTS.forEach((a, i) => {
    const tag = a === detectedName ? ' ← detected' : '';
    console.log(`  ${i + 1}) ${a}${tag}`);
  });

  let agentChoice: string;
  if (options.agents) {
    agentChoice = options.agents;
  } else if (options.yes || !process.stdin.isTTY) {
    agentChoice = detectedName ? 'detected' : 'all';
  } else {
    const defaultChoice = detectedName ? 'detected' : 'all';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      agentChoice = (await rl.question(`Configure agents: (d)etected, (a)ll, or numbers e.g. 1,3 [${defaultChoice}]: `)).trim() || defaultChoice;
    } finally {
      rl.close();
    }
  }

  const selectedAgents = parseAgentSelection(agentChoice, detectedName);
  console.log(`Selected agents: ${selectedAgents.length === 0 ? '(none)' : selectedAgents.join(', ')}`);

  // Step 5: Global install
  if (selectedAgents.length > 0) {
    console.log('\n→ Installing global agent configurations...');
    const written = runGlobalInstall(selectedAgents, env);
    if (written.length > 0) {
      for (const f of written) console.log(`  ✔ ${f}`);
    } else {
      console.log('  (all global configs already up to date)');
    }
  }

  // Step 6: Init repos + configure agents
  console.log('\n→ Initialising repositories and configuring agents...');
  const { initialisedRepos, configActions } = await initReposAndConfigureAgents(
    selectedRepos,
    selectedAgents,
    env,
  );

  // Save state
  writeSetupState({
    completed_at: new Date().toISOString(),
    roots,
    initialised_repos: initialisedRepos,
    global_configs_written: selectedAgents,
  }, env);

  // Step 7: Reload reminder
  printReloadReminder(detectedName);

  void configActions;
}
