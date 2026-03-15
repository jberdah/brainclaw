import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { registerAgentIdentity, resolveDefaultAgentName, resolveExistingCurrentAgent } from '../core/agent-registry.js';
import { MEMORY_DIR, memoryExists, ensureMemoryDir, memoryPath, writeFileAtomic } from '../core/io.js';
import { emptyState, loadState, saveState } from '../core/state.js';
import { defaultConfig, saveConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { buildProjectIdentity, resolveExistingProjectIdentity, saveProjectIdentity } from '../core/project-registry.js';
import { analyzeRepository } from '../core/repo-analysis.js';
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
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const existingIdentity = resolveExistingProjectIdentity(cwd);
  const existingCurrentAgent = resolveExistingCurrentAgent(cwd);
  const storageDir = resolveStorageDir(options.storageDir);
  const topology = resolveTopology(options.topology);
  const ignoreStrategy: IgnoreStrategy = topology === 'embedded' ? 'none' : 'project-gitignore';

  if (memoryExists(cwd) && !options.force) {
    console.error('Error: project memory already exists. Use --force to overwrite.');
    process.exit(1);
  }

  // Derive project name from directory
  const projectName = path.basename(cwd);

  const analysis = options.analyzeRepo === false
    ? undefined
    : analyzeRepository(cwd);

  const projectMode = await resolveProjectMode(options, analysis);
  const projectStrategy = await resolveProjectStrategy(options, projectMode);

  ensureMemoryDir(cwd, storageDir);

  const currentAgent = registerAgentIdentity({
    agentName: existingCurrentAgent?.agent_name ?? resolveDefaultAgentName(),
    kind: existingCurrentAgent?.kind ?? 'unknown',
    cwd,
    preferredDirName: storageDir,
  });

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
  saveConfig(config, cwd, storageDir);
  saveProjectIdentity(projectIdentity, cwd, storageDir);

  // Create project.md
  const md = generateMarkdown(state);
  writeFileAtomic(memoryPath('project.md', cwd, storageDir), md);

  if (ignoreStrategy === 'project-gitignore') {
    ensureProjectGitignore(cwd, storageDir);
  }

  console.log(`✔ Initialized project memory in ${storageDir}/`);
  console.log('✔ Created project.md, config.yaml, and split state directories');
  console.log(`✔ Project ID: ${projectIdentity.project_id}`);
  console.log(`✔ Current agent: ${currentAgent.agent_name} (${currentAgent.agent_id})`);
  console.log(`✔ Topology: ${topology}`);
  console.log(`✔ Storage dir: ${storageDir}`);
  console.log(`✔ Project mode: ${projectMode}`);
  if (projectMode === 'multi-project') {
    console.log(`✔ Project strategy: ${projectStrategy}`);
  }
  if (ignoreStrategy === 'project-gitignore') {
    console.log(`✔ Added ${storageDir}/ to .gitignore`);
  }

  if (analysis) {
    console.log('');
    console.log(`Recommended project mode: ${analysis.recommendedMode}`);
    for (const reason of analysis.reasons) {
      console.log(`  - ${reason}`);
    }
  }

  // Check for AGENTS.md
  if (fs.existsSync(path.join(cwd, 'AGENTS.md'))) {
    console.log('');
    console.log('Tip: AGENTS.md detected. Consider adding:');
    console.log('  ## Shared project memory');
    console.log(`  Read ${storageDir}/project.md before making significant changes or handing off work.`);
  }

  console.log('');
  console.log(`Tip: add ${storageDir}/project.md to your agent context files.`);
}

function resolveStorageDir(storageDir?: string): string {
  const candidate = (storageDir ?? MEMORY_DIR).trim();
  if (!candidate || candidate === '.' || candidate === '..' || candidate.includes('/') || candidate.includes('\\')) {
    console.error(`Error: invalid storage directory "${storageDir}". Use a single directory name such as "${MEMORY_DIR}".`);
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
