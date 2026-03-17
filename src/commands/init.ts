import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { registerAgentIdentity, resolveDefaultAgentName, resolveExistingCurrentAgent } from '../core/agent-registry.js';
import { MEMORY_DIR, memoryExists, ensureMemoryDir, memoryPath, writeFileAtomic } from '../core/io.js';
import { emptyState, loadState, saveState } from '../core/state.js';
import { defaultConfig, saveConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { buildProjectIdentity, resolveExistingProjectIdentity, saveProjectIdentity } from '../core/project-registry.js';
import { analyzeRepository, scanWorkspaceBoundaries } from '../core/repo-analysis.js';
import { isAgentIntegrationName, upsertAgentIntegrationDeclaration } from '../core/agent-integrations.js';
import { describeAutoConfigWrite, ensureAgentFiles, ensureGitignoreEntries, writeDetectedAgentAutoConfig } from '../core/agent-files.js';
import { detectAiAgent, detectWslEnvironment } from '../core/ai-agent-detection.js';
import { writeDetectedAgentExport } from './export.js';
import { writeDetectedAgentHooks } from './hooks.js';
import type { IgnoreStrategy, ProjectMode, ProjectStrategy, TopologyMode } from '../core/schema.js';

export interface InitOptions {
  yes?: boolean;
  force?: boolean;
  compact?: boolean;
  projectMode?: ProjectMode;
  projectStrategy?: ProjectStrategy;
  storageDir?: string;
  topology?: TopologyMode;
  analyzeRepo?: boolean;
  scan?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();

  // --scan: detect service boundaries and suggest init targets, then exit
  if (options.scan) {
    const { suggestions, alreadyInitialised } = scanWorkspaceBoundaries(cwd);
    if (alreadyInitialised.length > 0) {
      console.log(`Already initialised (${alreadyInitialised.length}):`);
      for (const { relativePath } of alreadyInitialised) {
        console.log(`  ✔ ./${relativePath}`);
      }
      console.log('');
    }
    if (suggestions.length === 0) {
      console.log('No service boundaries detected in subdirectories.');
    } else {
      console.log(`Detected ${suggestions.length} service boundary candidate(s):`);
      for (const { relativePath, markers } of suggestions) {
        console.log(`  → ./${relativePath}  [${markers.join(', ')}]`);
        console.log(`    cd ${relativePath} && brainclaw init -y`);
      }
    }
    return;
  }

  const existingIdentity = resolveExistingProjectIdentity(cwd);
  const existingCurrentAgent = resolveExistingCurrentAgent(cwd);
  const storageDir = resolveStorageDir(options.storageDir);
  const topology = resolveTopology(options.topology);
  const ignoreStrategy: IgnoreStrategy = topology === 'embedded' ? 'none' : 'project-gitignore';
  const skipAgentBootstrap = process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP === '1';

  if (memoryExists(cwd) && !options.force) {
    console.error('Error: project memory already exists. Use --force to overwrite.');
    process.exit(1);
  }

  // Derive project name from directory
  const projectName = path.basename(cwd);

  const shouldAnalyzeRepo = options.analyzeRepo !== false
    && process.env.BRAINCLAW_SKIP_REPO_ANALYSIS !== '1';
  const analysis = shouldAnalyzeRepo ? analyzeRepository(cwd) : undefined;

  const projectMode = await resolveProjectMode(options, analysis);
  const projectStrategy = await resolveProjectStrategy(options, projectMode);

  ensureMemoryDir(cwd, storageDir);

  const currentAgent = registerAgentIdentity({
    agentName: existingCurrentAgent?.agent_name ?? resolveDefaultAgentName(),
    kind: existingCurrentAgent?.kind ?? 'human',
    trustLevel: 'curator',
    cwd,
    preferredDirName: storageDir,
  });

  // Auto-detect and register the AI coding agent running in this environment
  const detectedAi = skipAgentBootstrap ? undefined : detectAiAgent();
  let registeredAiAgent = detectedAi
    ? registerAgentIdentity({
        agentName: detectedAi.name,
        kind: detectedAi.kind,
        trustLevel: detectedAi.trust_level,
        cwd,
        preferredDirName: storageDir,
      })
    : undefined;

  // Write to the detected agent's native instruction file
  const detectedExport = detectedAi ? writeDetectedAgentExport(detectedAi.name, cwd) : undefined;

  // Write deterministic session-trigger hooks for Cursor / Windsurf
  const detectedHooks = detectedAi ? writeDetectedAgentHooks(detectedAi.name, projectName, cwd) : [];

  const detectedAutoConfig = detectedAi ? writeDetectedAgentAutoConfig(detectedAi.name, cwd) : [];

  const state = emptyState();
  saveState(state, cwd);

  // Create config
  const projectIdentity = buildProjectIdentity({
    existing: existingIdentity,
    projectName,
    storageDir,
    topology,
  });
  const config = defaultConfig(projectName, {
    projectId: projectIdentity.project_id,
    currentAgent: currentAgent.agent_name,
    currentAgentId: currentAgent.agent_id,
    projectMode,
    projectStrategy,
    storageDir,
    topology,
    ignoreStrategy,
  });
  if (options.compact) {
    config.markdown = { max_items_per_section: 20, compact_mode: true };
  }
  if (detectedAi && isAgentIntegrationName(detectedAi.name)) {
    upsertAgentIntegrationDeclaration(config, detectedAi.name, 'detected');
  }
  saveConfig(config, cwd, storageDir);
  saveProjectIdentity(projectIdentity, cwd, storageDir);

  // Create project.md
  const md = generateMarkdown(state);
  writeFileAtomic(memoryPath('project.md', cwd, storageDir), md);

  if (ignoreStrategy === 'project-gitignore') {
    ensureProjectGitignore(cwd, storageDir);
  }

  // Create or update AGENTS.md and .github/copilot-instructions.md
  const agentFiles = skipAgentBootstrap
    ? {
        agentsMdCreated: false,
        agentsMdUpdated: false,
        copilotInstructionsCreated: false,
        copilotInstructionsUpdated: false,
      }
    : ensureAgentFiles(cwd, storageDir);

  // Add agent instruction files to .gitignore (they are generated, not source)
  if (!skipAgentBootstrap) {
    const generatedWorkspacePaths = detectedAutoConfig
      .map((item) => item.relativePath)
      .filter((item): item is string => item !== undefined)
      .filter((item) => !item.startsWith('.codeium/'));
    ensureGitignoreEntries(cwd, ['AGENTS.md', '.github/copilot-instructions.md', ...generatedWorkspacePaths]);
  }

  console.log(`✔ Initialized project memory in ${storageDir}/`);
  console.log('✔ Created project.md, config.yaml, and split state directories');
  console.log(`✔ Project ID: ${projectIdentity.project_id}`);
  console.log(`✔ Current agent: ${currentAgent.agent_name} (${currentAgent.agent_id})`);
  if (registeredAiAgent) {
    console.log(`✔ AI agent detected: ${registeredAiAgent.agent_name} [${detectedAi!.detection_source}] (${registeredAiAgent.agent_id})`);
  }  if (detectedExport) {
    console.log(`\u2714 Agent instructions written to ${detectedExport.relativePath} (${detectedExport.created ? 'created' : 'updated'})`);
  }
  for (const hook of detectedHooks) {
    console.log(`\u2714 Session hook written to ${hook.relativePath} (${hook.created ? 'created' : 'updated'})`);
  }
  console.log(`\u2714 Topology: ${topology}`);
  console.log(`✔ Storage dir: ${storageDir}`);
  console.log(`✔ Project mode: ${projectMode}`);
  if (projectMode === 'multi-project') {
    console.log(`✔ Project strategy: ${projectStrategy}`);
  }
  if (ignoreStrategy === 'project-gitignore') {
    console.log(`✔ Added ${storageDir}/ to .gitignore`);
  }
  if (agentFiles.agentsMdCreated) {
    console.log('✔ Created AGENTS.md with brainclaw bootstrap section');
  } else if (agentFiles.agentsMdUpdated) {
    console.log('✔ Updated AGENTS.md with brainclaw bootstrap section');
  }
  if (agentFiles.copilotInstructionsCreated) {
    console.log('✔ Created .github/copilot-instructions.md with brainclaw bootstrap section');
  } else if (agentFiles.copilotInstructionsUpdated) {
    console.log('✔ Updated .github/copilot-instructions.md with brainclaw bootstrap section');
  }
  for (const autoConfig of detectedAutoConfig) {
    const message = describeAutoConfigWrite(autoConfig);
    if (message) {
      console.log(message);
    }
  }
  if (!skipAgentBootstrap) {
    console.log('✔ Added generated agent files to .gitignore');
  }

  if (analysis) {
    console.log('');
    console.log(`Recommended project mode: ${analysis.recommendedMode}`);
    for (const reason of analysis.reasons) {
      console.log(`  - ${reason}`);
    }
  }

  const wsl = detectWslEnvironment();
  if (wsl) {
    console.log('');
    console.log(`⚠  WSL detected (${wsl.distro}). brainclaw is installed in this WSL environment only.`);
    console.log(`   To use brainclaw from a Windows terminal (PowerShell/cmd), run inside this project:`);
    console.log(`     npm link    (in PowerShell, with Node.js for Windows)`);
  }

  console.log('');
  console.log(`Tip: run 'brainclaw context --json' to load the shared memory into your agent session.`);
}

function resolveStorageDir(storageDir?: string): string {
  const candidate = (storageDir ?? MEMORY_DIR).trim();
  if (candidate !== MEMORY_DIR) {
    console.error(`Error: custom storage directories are no longer supported. Use "${MEMORY_DIR}".`);
    process.exit(1);
  }
  return candidate;
}

function resolveTopology(topology?: TopologyMode): TopologyMode {
  return topology ?? 'embedded';
}

function ensureProjectGitignore(cwd: string, storageDir: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const ignoreLine = `${storageDir}/`;
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = current.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.includes(ignoreLine)) {
    return;
  }
  const next = current.length === 0
    ? `${ignoreLine}\n`
    : `${current.replace(/\s*$/, '')}\n${ignoreLine}\n`;
  fs.writeFileSync(gitignorePath, next, 'utf-8');
}

async function resolveProjectMode(
  options: InitOptions,
  analysis: ReturnType<typeof analyzeRepository> | undefined,
): Promise<ProjectMode> {
  if (options.projectMode) {
    return options.projectMode;
  }

  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return 'auto';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('How is this repository organized?');
    console.log('  1) single-project - Use one shared memory space for the whole repository.');
    console.log('  2) multi-project  - Segment memory across multiple projects or domains in this repository.');
    console.log('  3) auto           - Start simple now and allow project segmentation later.');
    if (analysis) {
      console.log(`Suggested mode: ${analysis.recommendedMode}`);
    }

    const answer = (await rl.question('Select project mode [auto]: ')).trim().toLowerCase();
    return parseProjectMode(answer) ?? 'auto';
  } finally {
    rl.close();
  }
}

async function resolveProjectStrategy(
  options: InitOptions,
  projectMode: ProjectMode,
): Promise<ProjectStrategy> {
  if (options.projectStrategy) {
    return options.projectStrategy;
  }

  if (projectMode !== 'multi-project') {
    return 'manual';
  }

  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return 'manual';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('How should project boundaries be managed?');
    console.log('  1) manual - Projects are named explicitly and assigned later.');
    console.log('  2) folder - Use folder paths as the default way to infer project boundaries.');

    const answer = (await rl.question('Select project strategy [manual]: ')).trim().toLowerCase();
    return parseProjectStrategy(answer) ?? 'manual';
  } finally {
    rl.close();
  }
}

function parseProjectMode(value: string): ProjectMode | undefined {
  switch (value) {
    case '1':
    case 'single-project':
    case 'single':
      return 'single-project';
    case '2':
    case 'multi-project':
    case 'multi':
      return 'multi-project';
    case '3':
    case 'auto':
      return 'auto';
    default:
      return undefined;
  }
}

function parseProjectStrategy(value: string): ProjectStrategy | undefined {
  switch (value) {
    case '1':
    case 'manual':
      return 'manual';
    case '2':
    case 'folder':
      return 'folder';
    default:
      return undefined;
  }
}
