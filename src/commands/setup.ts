import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { runInit } from './init.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import { buildAiSurfaceInventory, renderAiSurfaceUsageHints } from '../core/ai-surface-inventory.js';
import { buildMachineProfile, saveMachineProfile, loadMachineProfile } from '../core/machine-profile.js';
import { buildAgentInventory, saveAgentInventory, loadAgentInventory, type AgentInventory } from '../core/agent-inventory.js';
import {
  ensureClaudeCodeUserSettings,
  ensureClaudeCodeUserCommand,
  ensureCursorMcpConfig,
  ensureWindsurfMcpConfig,
  ensureAntigravityMcpConfig,
  ensureContinueUserMcpConfig,
  ensureContinueUserPermissions,
  ensureCodexMcpConfig,
  ensureHermesMcpConfig,
  writeDetectedAgentAutoConfig,
  describeAutoConfigWrite,
  ensureGitignoreEntries,
  collectWorkspaceGitignoreEntries,
  BRAINCLAW_EXCLUSIVE_DIRECTORIES,
} from '../core/agent-files.js';
import { MEMORY_DIR, memoryExists, writeFileAtomic, ensureMemoryDir } from '../core/io.js';
import { loadConfig, saveConfig, defaultConfig } from '../core/config.js';
import { readSetupState, resolveHomeDir, type SetupState, writeSetupState } from '../core/setup-state.js';
import { writeDetectedAgentHooks } from './hooks.js';

export { readSetupState } from '../core/setup-state.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SetupOptions {
  roots?: string;
  agents?: string;
  repos?: string;
  yes?: boolean;
}

export interface SetupMachineOptions {
  agents?: string;
  yes?: boolean;
}

export interface RepoInfo {
  path: string;
  name: string;
  alreadyInitialised: boolean;
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
  'kilocode',
  'mistral-vibe',
  'hermes',
  'openclaw',
  'nanoclaw',
  'nemoclaw',
  'picoclaw',
  'zeroclaw',
];

const BRAINCLAW_ASCII = [
  '',
  '    ╔╗ ┬─┐┌─┐┬┌┐┌╔═╗╦  ╔═╗╦ ╦',
  '    ╠╩╗├┬┘├─┤││││║  ║  ╠═╣║║║',
  '    ╚═╝┴└─┴ ┴┴┘└┘╚═╝╩═╝╴ ╴╚╩╝',
  '',
].join('\n');

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
  const seen = new Set<string>();
  for (const root of roots) {
    const candidates = [root];
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        candidates.push(path.join(root, entry.name));
      }
    } catch {
      // skip unreadable dirs
    }

    for (const candidate of candidates) {
      const repoPath = path.resolve(candidate);
      if (seen.has(repoPath)) continue;
      if (isBrainclawInternalPath(repoPath)) continue;
      if (!fs.existsSync(path.join(repoPath, '.git'))) continue;

      seen.add(repoPath);
      repos.push({
        path: repoPath,
        name: path.basename(repoPath) || repoPath,
        alreadyInitialised: memoryExists(repoPath),
      });
    }
  }
  return repos;
}

function isBrainclawInternalPath(candidate: string): boolean {
  const parts = path.resolve(candidate).split(path.sep).filter(Boolean);
  return parts.includes(MEMORY_DIR);
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

function uniqueKnownAgents(names: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (!name || !ALL_KNOWN_AGENTS.includes(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export function getInstalledAgentNames(inventory: AgentInventory | undefined): string[] {
  return uniqueKnownAgents(inventory?.agents.filter((agent) => agent.installed).map((agent) => agent.name) ?? []);
}

export function getDetectedSetupAgentNames(
  detected: string | undefined,
  installedAgents: string[] = [],
): string[] {
  return uniqueKnownAgents([
    detected,
    ...ALL_KNOWN_AGENTS.filter((agent) => installedAgents.includes(agent)),
  ]);
}

export function parseAgentSelection(
  choice: string,
  detected: string | undefined,
  installedAgents: string[] = [],
): string[] {
  const c = choice.trim().toLowerCase();
  if (c === 'a' || c === 'all') return [...ALL_KNOWN_AGENTS];
  if (c === 'd' || c === 'detected' || c === 'installed') {
    return getDetectedSetupAgentNames(detected, installedAgents);
  }

  const selected: string[] = [];
  for (const token of c.split(',').map((a) => a.trim()).filter(Boolean)) {
    const index = Number.parseInt(token, 10);
    if (/^\d+$/.test(token) && index >= 1 && index <= ALL_KNOWN_AGENTS.length) {
      selected.push(ALL_KNOWN_AGENTS[index - 1]!);
      continue;
    }
    if (ALL_KNOWN_AGENTS.includes(token)) selected.push(token);
  }
  return uniqueKnownAgents(selected);
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
    const perms = ensureContinueUserPermissions(home);
    if (perms && (perms.created || perms.updated)) written.push(perms.filePath);
  }
  if (selectedAgents.includes('codex')) {
    const r = ensureCodexMcpConfig(home, env);
    if (r && (r.created || r.updated)) written.push(r.filePath);
  }
  if (selectedAgents.includes('hermes')) {
    const r = ensureHermesMcpConfig(home);
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
    await runInit({ yes: true, skipAgentBootstrap: true, skipSetupRequirement: true, cwd: repo.path });
    initialisedRepos.push(repo.path);
  }

  for (const repo of selectedRepos) {
    const gitignoreEntries = new Set<string>();
    for (const agentName of selectedAgents) {
      const configs = writeDetectedAgentAutoConfig(agentName, repo.path, env);
      for (const entry of collectWorkspaceGitignoreEntries(repo.path, configs)) {
        gitignoreEntries.add(entry);
      }
      for (const config of configs) {
        const msg = describeAutoConfigWrite(config);
        if (msg) {
          console.log(`  ${msg}`);
          configActions.push(msg);
        }
      }
      const hooks = writeDetectedAgentHooks(agentName, repo.name, repo.path);
      for (const hook of hooks) {
        gitignoreEntries.add(hook.relativePath);
      }
      for (const hook of hooks) {
        if (hook.created) {
          const msg = `✔ Created hook at ${hook.relativePath}`;
          console.log(`  ${msg}`);
          configActions.push(msg);
        }
      }
    }
    if (gitignoreEntries.size > 0) {
      ensureGitignoreEntries(repo.path, [...gitignoreEntries, ...BRAINCLAW_EXCLUSIVE_DIRECTORIES]);
      console.log(`  ✔ Updated .gitignore with generated agent files (${[...gitignoreEntries].join(', ')})`);
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

function logDetectedAgentSurfaces(
  detectedName: string | undefined,
  detectedSurfaces: ReturnType<typeof buildAiSurfaceInventory>,
): void {
  console.log('');
  if (detectedName) {
    console.log(`Detected AI agent: ${detectedName}`);
  } else {
    console.log('No AI agent detected automatically.');
  }
  const visibleSurfaces = detectedSurfaces.filter((surface) => surface.status !== 'not_detected');
  if (visibleSurfaces.length > 0) {
    console.log('Other AI work surfaces on this machine:');
    for (const surface of visibleSurfaces) {
      console.log(`  - ${surface.display_name} [${surface.surface_kind}, ${surface.status}]`);
    }
    const usageHints = renderAiSurfaceUsageHints(visibleSurfaces);
    if (usageHints.length > 0) {
      console.log('');
      console.log('Suggested uses:');
      for (const line of usageHints) {
        console.log(`  ${line}`);
      }
    }
    console.log('');
    console.log('These surfaces are tracked separately from coding agents and will use tailored onboarding flows.');
  }
}

async function resolveSelectedAgentsForSetup(
  options: { agents?: string; yes?: boolean },
  detectedName: string | undefined,
  installedAgents: string[] = [],
): Promise<string[]> {
  const detectedSetupAgents = getDetectedSetupAgentNames(detectedName, installedAgents);
  console.log('Supported agents:');
  ALL_KNOWN_AGENTS.forEach((a, i) => {
    const tag = a === detectedName ? ' ← detected' : '';
    const installedTag = installedAgents.includes(a) ? ' ← installed' : '';
    console.log(`  ${i + 1}) ${a}${tag}${tag ? '' : installedTag}`);
  });
  if (detectedSetupAgents.length > 0) {
    console.log(`Detected install set: ${detectedSetupAgents.join(', ')}`);
  }

  let agentChoice: string;
  if (options.agents) {
    agentChoice = options.agents;
  } else if (options.yes || !process.stdin.isTTY) {
    agentChoice = detectedSetupAgents.length > 0 ? 'detected' : 'all';
  } else {
    const defaultChoice = detectedSetupAgents.length > 0 ? 'detected' : 'all';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      agentChoice = (await rl.question(`Configure agents: (d)etected installed, (a)ll, names, or numbers e.g. 1,3 [${defaultChoice}]: `)).trim() || defaultChoice;
    } finally {
      rl.close();
    }
  }

  const selectedAgents = parseAgentSelection(agentChoice, detectedName, installedAgents);
  console.log(`Selected agents: ${selectedAgents.length === 0 ? '(none)' : selectedAgents.join(', ')}`);
  return selectedAgents;
}

export async function runSetupMachine(options: SetupMachineOptions = {}): Promise<void> {
  const env = process.env;
  const detectedAi = detectAiAgent(env);
  const detectedName = detectedAi?.name;
  const testMode = process.env.BRAINCLAW_TEST_MODE === '1';
  const detectedSurfaces = testMode ? [] : buildAiSurfaceInventory();
  const agentInventory = testMode ? undefined : buildAgentInventory(resolveHomeDir(env) ?? os.homedir(), env);
  const installedAgents = getInstalledAgentNames(agentInventory);

  console.log(BRAINCLAW_ASCII);
  console.log('Machine bootstrap only — no repositories will be scanned or initialized.');
  logDetectedAgentSurfaces(detectedName, detectedSurfaces);

  const selectedAgents = await resolveSelectedAgentsForSetup(options, detectedName, installedAgents);

  console.log('\n→ Installing machine-level brainclaw prerequisites...');
  const written = runGlobalInstall(selectedAgents, env);
  if (written.length > 0) {
    for (const filePath of written) {
      console.log(`  ✔ ${filePath}`);
    }
  } else {
    console.log('  (all machine-level prerequisites already up to date)');
  }

  installVscodeExtension();

  writeSetupState({
    completed_at: new Date().toISOString(),
    roots: [],
    initialised_repos: [],
    global_configs_written: selectedAgents,
  }, env);

  printReloadReminder(detectedName);
  console.log('');
  console.log('Next step: run `brainclaw init` inside the project you want to create or refresh.');
  console.log('If the project already has .brainclaw/ and you want to register another agent explicitly, run `brainclaw enable-agent <agent-name>` there.');
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
  const testMode = process.env.BRAINCLAW_TEST_MODE === '1';
  const detectedSurfaces = testMode ? [] : buildAiSurfaceInventory();
  const agentInventory = testMode ? undefined : buildAgentInventory(resolveHomeDir(env) ?? os.homedir(), env);
  const installedAgents = getInstalledAgentNames(agentInventory);
  logDetectedAgentSurfaces(detectedName, detectedSurfaces);
  const selectedAgents = await resolveSelectedAgentsForSetup(options, detectedName, installedAgents);

  // Step 5: Global install
  console.log('\n→ Installing global brainclaw prerequisites...');
  const written = runGlobalInstall(selectedAgents, env);
  if (written.length > 0) {
    for (const f of written) console.log(`  ✔ ${f}`);
  } else {
    console.log('  (all global prerequisites already up to date)');
  }

  // Step 6: Init repos + configure agents
  console.log('\n→ Initialising repositories and configuring agents...');
  const { initialisedRepos, configActions } = await initReposAndConfigureAgents(
    selectedRepos,
    selectedAgents,
    env,
  );

  // Step 7: VS Code extension
  installVscodeExtension();

  // Save state
  writeSetupState({
    completed_at: new Date().toISOString(),
    roots,
    initialised_repos: initialisedRepos,
    global_configs_written: selectedAgents,
  }, env);

  // Step 8: Reload reminder
  printReloadReminder(detectedName);

  void configActions;
}

// ─── VS Code extension auto-install ──────────────────────────────────────────

function installVscodeExtension(): void {
  // Find the bundled vsix
  const vsixPath = resolveVsixPath();
  if (!vsixPath) return;

  // Check if `code` CLI is available
  const codeAvailable = spawnSync('code', ['--version'], { stdio: 'ignore', timeout: 5000 });
  if (codeAvailable.status !== 0) return; // VS Code not installed or not in PATH — skip silently

  // Install the extension
  const result = spawnSync('code', ['--install-extension', vsixPath, '--force'], { stdio: 'pipe', timeout: 30000 });
  if (result.status === 0) {
    console.log('  ✔ Installed Brainclaw VS Code extension');
  }
}

function resolveVsixPath(): string | undefined {
  const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
  // 1. Bundled in dist/ (npm install) — dist/commands/setup.js → dist/brainclaw-vscode.vsix
  const distVsix = path.join(thisDir, '..', 'brainclaw-vscode.vsix');
  if (fs.existsSync(distVsix)) return distVsix;

  // 2. Dev mode: vscode-extension/ directory
  const devVsix = path.join(thisDir, '..', '..', 'vscode-extension', 'brainclaw-vscode-0.1.0.vsix');
  if (fs.existsSync(devVsix)) return devVsix;

  return undefined;
}
