import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { clearEnumerationMemo } from '../core/entity-locator.js';
import { registerAgentIdentity, resolveDefaultAgentName, resolveExistingCurrentAgent } from '../core/agent-registry.js';
import { MEMORY_DIR, memoryExists, ensureMemoryDir, memoryPath, writeFileAtomic } from '../core/io.js';
import { emptyState, loadState, saveState } from '../core/state.js';
import { defaultConfig, loadConfig, saveConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { initMemoryRepo } from '../core/memory-git.js';
import { buildProjectIdentity, resolveExistingProjectIdentity, saveProjectIdentity } from '../core/project-registry.js';
import { scanProject, upsertProject } from '../core/global-registry.js';
import { analyzeRepository, scanWorkspaceBoundaries } from '../core/repo-analysis.js';
import { renderBootstrapSummary, runBootstrapProfile } from '../core/bootstrap.js';
import { isAgentIntegrationName, upsertAgentIntegrationDeclaration } from '../core/agent-integrations.js';
import { BRAINCLAW_EXCLUSIVE_DIRECTORIES, describeAutoConfigWrite, ensureAgentFiles, ensureGitignoreEntries, writeDetectedAgentAutoConfig } from '../core/agent-files.js';
import { detectAiAgent, detectWslEnvironment } from '../core/ai-agent-detection.js';
import { buildAiSurfaceInventory, renderAiSurfaceUsageHints } from '../core/ai-surface-inventory.js';
import { ensureUserStore, hasCompletedSetup } from '../core/setup-state.js';
import { resolveEmptyMemoryRecommendation } from '../core/setup-flow.js';
import { writeDetectedAgentExport } from './export.js';
import { writeDetectedAgentHooks } from './hooks.js';
import { checkGitPresence, runGlobalInstall } from './setup.js';
import { createBackup, BackupError } from '../core/upgrades/backup.js';
import { ConfigSchema, type Config, type IgnoreStrategy, type ProjectMode, type ProjectStrategy, type TopologyMode } from '../core/schema.js';

export interface InitOptions {
  yes?: boolean;
  force?: boolean;
  compact?: boolean;
  projectMode?: ProjectMode;
  projectStrategy?: ProjectStrategy;
  storageDir?: string;
  topology?: TopologyMode;
  analyzeRepo?: boolean;
  aiScan?: boolean;
  scan?: boolean;
  cwd?: string;
  noAiScan?: boolean;
  skipAgentBootstrap?: boolean;
  skipSetupRequirement?: boolean;
  /**
   * Skip the per-agent machine-prereq slice that init normally runs for the
   * detected agent (the same writes setup performs at machine scope, scoped
   * to just one agent). Disabled implicitly by BRAINCLAW_TEST_MODE and by
   * skipAgentBootstrap, so tests and explicit no-bootstrap callers don't
   * spuriously touch ~/.<agent>/ files.
   */
  skipMachinePrereqs?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const containingMemoryStore = resolveContainingMemoryStore(cwd);
  // Auto-create user store if absent (replaces the old "setup required" guard).
  // The skipSetupRequirement flag and BRAINCLAW_SKIP_SETUP_REQUIREMENT env var
  // are kept for backward compatibility but are now effectively no-ops —
  // init always ensures the user store exists before proceeding.
  if (!hasCompletedSetup()) {
    ensureUserStore();
  }

  // Git-presence gate, aligned with `brainclaw setup`: agent-first onboarding
  // assumes git for memory versioning + post-merge hooks. Allow override via
  // BRAINCLAW_SKIP_REPO_ANALYSIS=1 for tests that exercise non-git fixtures.
  if (process.env.BRAINCLAW_SKIP_REPO_ANALYSIS !== '1' && !checkGitPresence()) {
    console.error('brainclaw init needs git to work.');
    console.error('Install git from https://git-scm.com and try again.');
    process.exit(1);
  }

  if (containingMemoryStore) {
    console.error(`Error: cannot run \`brainclaw init\` from inside an existing project memory store (${containingMemoryStore}).`);
    console.error('Run `brainclaw init` from the project root directory instead.');
    process.exit(1);
  }

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
  const projectMemoryExists = memoryExists(cwd);
  const existingConfig = projectMemoryExists ? loadExistingConfig(cwd, storageDir) : undefined;

  // --force backup gate: feedback_no_init_force (June 2026) entered the code.
  // Before rebuilding identity fields on top of an existing store, take a
  // sibling backup so curator personalisations (redaction patterns, claim
  // TTL, governance, sensitive_paths) can always be recovered even if the
  // merge below regresses or the agent ran `init --force` by mistake.
  let forceBackupPath: string | undefined;
  if (options.force && projectMemoryExists) {
    try {
      const handle = createBackup({
        storePath: path.join(cwd, storageDir),
        note: 'init --force pre-reconstruction snapshot',
        storeSchemaVersion: existingConfig ? String(existingConfig.schema_version) : null,
      });
      forceBackupPath = handle.backupPath;
    } catch (err) {
      const reason = err instanceof BackupError
        ? `${err.code}: ${err.message}`
        : err instanceof Error ? err.message : String(err);
      console.error(`Error: --force backup failed (${reason}). Aborting to preserve the existing store. Re-run without --force, or move the store aside manually.`);
      process.exit(1);
    }
  }
  const topology = resolveTopology(options.topology, existingConfig?.topology);
  const ignoreStrategy = resolveIgnoreStrategy(topology, existingConfig?.ignore_strategy);
  const skipAgentBootstrap = options.skipAgentBootstrap === true || process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP === '1';
  const testMode = process.env.BRAINCLAW_TEST_MODE === '1';
  const skipAiSurfaceScan = testMode || options.noAiScan === true || options.aiScan === false;

  // Derive project name from directory
  const projectName = path.basename(cwd);

  const shouldAnalyzeRepo = options.analyzeRepo !== false
    && process.env.BRAINCLAW_SKIP_REPO_ANALYSIS !== '1';
  const analysis = shouldAnalyzeRepo ? analyzeRepository(cwd) : undefined;

  const projectMode = await resolveProjectMode(options, analysis, existingConfig?.project_mode);
  const projectStrategy = await resolveProjectStrategy(options, projectMode, existingConfig?.projects?.strategy);

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
  const registeredAiAgent = detectedAi
    ? registerAgentIdentity({
        agentName: detectedAi.name,
        kind: detectedAi.kind,
        // pln#562 step 2 — auto-registration never exceeds contributor;
        // elevation is an explicit curator act (set-trust / register-agent).
        trustLevel: 'contributor',
        cwd,
        preferredDirName: storageDir,
      })
    : undefined;

  // Only write empty state if no data exists yet.
  // When --force is used on an existing project, preserve the data
  // and only refresh config/agent registration/directory structure.
  const existingState = loadState(cwd);
  const hasExistingData =
    existingState.active_constraints.length > 0 ||
    existingState.recent_decisions.length > 0 ||
    existingState.known_traps.length > 0 ||
    existingState.open_handoffs.length > 0 ||
    existingState.plan_items.length > 0;

  if (!hasExistingData) {
    saveState(emptyState(), cwd);
  }

  // Create config
  const projectIdentity = buildProjectIdentity({
    existing: existingIdentity,
    projectName,
    storageDir,
    topology,
  });
  const config = buildInitConfig({
    projectName,
    projectIdentity,
    currentAgent: {
      name: currentAgent.agent_name,
      id: currentAgent.agent_id,
    },
    projectMode,
    projectStrategy,
    storageDir,
    topology,
    ignoreStrategy,
    // --force rebuilds identity (project_id, agent, topology, storage_dir)
    // but merges through existingConfig so curator personalisations
    // (redaction patterns, governance, claims TTL, sensitive_paths,
    // cross_project_links, custom markdown caps) survive the reset.
    // The original `force ? undefined` path wiped these silently —
    // discovered when feedback_no_init_force was promoted from a memory
    // habit to a tracked regression.
    existingConfig,
    defaultJournalMode: !projectMemoryExists,
    compact: options.compact === true,
  });
  if (detectedAi && isAgentIntegrationName(detectedAi.name)) {
    upsertAgentIntegrationDeclaration(config, detectedAi.name, 'detected');
  }
  saveConfig(config, cwd, storageDir);
  saveProjectIdentity(projectIdentity, cwd, storageDir);

  // Write to the detected agent's native instruction file after config exists.
  const detectedExport = detectedAi ? writeDetectedAgentExport(detectedAi.name, cwd) : undefined;

  // Write deterministic session-trigger hooks for Cursor / Windsurf
  const detectedHooks = detectedAi
    ? (detectedAi.name === 'windsurf'
        ? []
        : writeDetectedAgentHooks(detectedAi.name, projectName, cwd)
          .filter((hook) => hook.relativePath !== detectedExport?.relativePath))
    : [];

  const detectedAutoConfig = detectedAi ? writeDetectedAgentAutoConfig(detectedAi.name, cwd) : [];

  // Per-agent slice of machine prerequisites (the same writes setup performs
  // globally, but scoped to the detected agent). This makes `init` the single
  // entry point for the carte-blanche / fresh-repo case: an agent-first
  // bootstrap no longer needs a separate `brainclaw setup` shell-out + session
  // reload. Idempotent — each ensure* function returns "skipped" when the
  // agent's user-scope config doesn't exist.
  const skipMachinePrereqs =
    options.skipMachinePrereqs === true
    || skipAgentBootstrap
    || testMode
    || process.env.BRAINCLAW_INIT_SKIP_MACHINE_PREREQS === '1';
  const machinePrereqsWritten = detectedAi && !skipMachinePrereqs
    ? safeRunMachinePrereqs(detectedAi.name)
    : [];

  // Register in global project registry
  try {
    const entry = scanProject(cwd);
    if (entry) upsertProject(entry);
  } catch {
    // Non-fatal: global registry is optional
  }

  // Create project.md
  const md = generateMarkdown(loadState(cwd));
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
      .filter((item) => item.kind !== 'recommendation')
      .map((item) => item.relativePath)
      .filter((item): item is string => item !== undefined)
      .filter((item) => !item.startsWith('.codeium/'));
    ensureGitignoreEntries(cwd, ['AGENTS.md', '.github/copilot-instructions.md', ...generatedWorkspacePaths, ...BRAINCLAW_EXCLUSIVE_DIRECTORIES]);
  }

  if (projectMemoryExists) {
    console.log(`✔ Refreshed existing project memory in ${storageDir}/`);
    if (options.force) {
      if (forceBackupPath) {
        console.log(`✔ Pre-reconstruction backup at ${forceBackupPath} (rollback: brainclaw upgrade --rollback)`);
      }
      console.log('✔ Existing memory preserved; rebuilt managed identity and refreshed agent integration files (customisations merged through)');
    } else {
      console.log('✔ Existing memory preserved; refreshed managed configuration and agent integration files');
    }
  } else {
    console.log(`✔ Initialized project memory in ${storageDir}/`);
    console.log('✔ Created project.md, config.yaml, and split state directories');
  }
  console.log(`✔ Project ID: ${projectIdentity.project_id}`);
  console.log(`✔ Current agent: ${currentAgent.agent_name} (${currentAgent.agent_id})`);
  if (registeredAiAgent) {
    console.log(`✔ AI agent detected: ${registeredAiAgent.agent_name} [${detectedAi!.detection_source}] (${registeredAiAgent.agent_id})`);
  }
  if (machinePrereqsWritten.length > 0) {
    console.log(`\u2714 Machine prerequisites for ${detectedAi!.name}:`);
    for (const filePath of machinePrereqsWritten) {
      console.log(`  - ${filePath}`);
    }
  }
  if (detectedExport) {
    console.log(`\u2714 Agent instructions written to ${detectedExport.relativePath} (${detectedExport.created ? 'created' : 'updated'})`);
  }
  if (!skipAiSurfaceScan) {
    const visibleSurfaces = buildAiSurfaceInventory().filter((surface) => surface.status !== 'not_detected');
    if (visibleSurfaces.length > 0) {
      console.log('✔ Other AI work surfaces detected on this machine:');
      for (const surface of visibleSurfaces) {
        console.log(`  - ${surface.display_name} [${surface.surface_kind}, ${surface.status}]`);
      }
      const usageHints = renderAiSurfaceUsageHints(visibleSurfaces);
      if (usageHints.length > 0) {
        console.log('  Suggested uses:');
        for (const line of usageHints) {
          console.log(`    ${line}`);
        }
      }
    }
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

  // Initialize internal git repo for memory versioning
  if (initMemoryRepo(cwd)) {
    console.log('✔ Initialized memory git repo for versioning');
  }

  // Install post-merge hook for auto-release of claims after merge
  installPostMergeHookIfMissing(cwd);

  if (!testMode) {
    // Shared empty-memory rule (see docs/concepts/workspace-bootstrapping.md):
    // repo with content → bclaw_bootstrap extraction; greenfield → bootstrap
    // loop. The brownfield preflight scan is skipped on greenfield — there is
    // nothing to harvest yet.
    const emptyMemoryRec = resolveEmptyMemoryRecommendation(cwd);
    console.log('');
    if (emptyMemoryRec.route === 'ideate') {
      console.log(`Onboarding: ${emptyMemoryRec.text}`);
    } else {
      const onboardingPreflight = runBootstrapProfile({ cwd, refresh: true });
      console.log('Onboarding preflight:');
      console.log(`  ${emptyMemoryRec.text}`);
      for (const line of renderBootstrapSummary(onboardingPreflight).split('\n')) {
        console.log(`  ${line}`);
      }
      if (onboardingPreflight.importPlan.suggestion_count > 0) {
        console.log('');
        console.log(`Next step: run 'brainclaw bootstrap --apply' to import ${onboardingPreflight.importPlan.suggestion_count} suggested item(s) into canonical memory.`);
        console.log(`Rollback: run 'brainclaw bootstrap --uninstall' to deactivate the last bootstrap-managed import.`);
      }
      if ((onboardingPreflight.importPlan.interview?.question_count ?? 0) > 0) {
        console.log('');
        console.log(`Interview: run 'brainclaw bootstrap --interview --audience cli' for terminal agents or '--audience ide_chat' for IDE chat agents.`);
        console.log(`Apply confirmed answers: write a JSON answers file and run 'brainclaw bootstrap --answers-file <path> --apply'.`);
      } else if ((onboardingPreflight.profile.gaps?.length ?? 0) > 0) {
        console.log('');
        console.log(`Next step: review the onboarding gaps, then use 'brainclaw bootstrap --json' as the basis for an interview/import flow.`);
      }
    }
  }

  console.log('');
  if (projectMemoryExists) {
    console.log(`Tip: run 'brainclaw enable-agent <agent-name>' when you want to explicitly add another agent to this existing project.`);
  } else {
    console.log(`Tip: run 'brainclaw init' again later to refresh the detected agent's integration files on this project.`);
  }
  console.log(`Tip: in an agent session, call the bclaw_work MCP tool (intent: "consult") to load the shared memory; from a terminal, 'brainclaw context --json' does the same.`);

  // A STORE JUST CAME INTO EXISTENCE, so the routing memo's candidate list is stale.
  //
  // `clearEnumerationMemo` was documented as being "for tests, and for any caller that has
  // just created a store" — and that second caller did not exist (Fable audit found the
  // claim describing intent rather than code). The consequence was small but real: for up
  // to the memo TTL, a mutation routed right after `brainclaw init` / `bclaw_init_project`
  // could not see the new project. Wiring it HERE rather than in the MCP handler covers
  // every path that materialises a store, since both the CLI and the tool go through
  // runInit.
  clearEnumerationMemo();
}

function safeRunMachinePrereqs(agentName: string): string[] {
  try {
    return runGlobalInstall([agentName]);
  } catch {
    // Non-fatal: machine-scope writes are best-effort, never block init.
    return [];
  }
}

function installPostMergeHookIfMissing(cwd: string): void {
  try {
    let dir = path.resolve(cwd);
    let gitRoot: string | undefined;
    while (true) {
      if (fs.existsSync(path.join(dir, '.git'))) { gitRoot = dir; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!gitRoot) return;

    const hooksDir = path.join(gitRoot, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'post-merge');
    if (fs.existsSync(hookPath)) return; // don't overwrite existing hooks

    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    const script = [
      '#!/bin/sh',
      '# brainclaw post-merge hook — auto-release claims on merged files',
      'BCLAW_CMD=""',
      'if command -v brainclaw >/dev/null 2>&1; then BCLAW_CMD="brainclaw"',
      'elif command -v bclaw >/dev/null 2>&1; then BCLAW_CMD="bclaw"',
      'else BCLAW_CMD="npx --no brainclaw"; fi',
      '$BCLAW_CMD release-claims --from-git-diff 2>/dev/null || true',
      '',
    ].join('\n');
    fs.writeFileSync(hookPath, script, { encoding: 'utf-8', mode: 0o755 });
    console.log('✔ Installed post-merge hook for auto-release of claims');
  } catch {
    // Non-critical — skip silently
  }
}

function resolveStorageDir(storageDir?: string): string {
  const candidate = (storageDir ?? MEMORY_DIR).trim();
  if (candidate !== MEMORY_DIR) {
    console.error(`Error: custom storage directories are no longer supported. Use "${MEMORY_DIR}".`);
    process.exit(1);
  }
  return candidate;
}

function resolveContainingMemoryStore(cwd: string): string | undefined {
  let current = path.resolve(cwd);

  while (true) {
    if (path.basename(current) === MEMORY_DIR && looksLikeBrainclawStore(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function looksLikeBrainclawStore(storePath: string): boolean {
  return fs.existsSync(path.join(storePath, 'config.yaml'))
    || fs.existsSync(path.join(storePath, 'project.identity.json'))
    || fs.existsSync(path.join(storePath, '.git'));
}

function resolveTopology(topology?: TopologyMode, existingTopology?: TopologyMode): TopologyMode {
  return topology ?? existingTopology ?? 'embedded';
}

function resolveIgnoreStrategy(topology: TopologyMode, existingIgnoreStrategy?: IgnoreStrategy): IgnoreStrategy {
  return existingIgnoreStrategy ?? (topology === 'embedded' ? 'none' : 'project-gitignore');
}

function loadExistingConfig(cwd: string, storageDir: string): Config | undefined {
  try {
    return loadConfig(cwd, storageDir);
  } catch {
    return undefined;
  }
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
  existingProjectMode?: ProjectMode,
): Promise<ProjectMode> {
  if (options.projectMode) {
    return options.projectMode;
  }

  if (existingProjectMode) {
    return existingProjectMode;
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
  existingProjectStrategy?: ProjectStrategy,
): Promise<ProjectStrategy> {
  if (options.projectStrategy) {
    return options.projectStrategy;
  }

  if (projectMode !== 'multi-project') {
    return 'manual';
  }

  if (existingProjectStrategy) {
    return existingProjectStrategy;
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

function buildInitConfig(input: {
  projectName: string;
  projectIdentity: { project_id: string };
  currentAgent: { name: string; id: string };
  projectMode: ProjectMode;
  projectStrategy: ProjectStrategy;
  storageDir: string;
  topology: TopologyMode;
  ignoreStrategy: IgnoreStrategy;
  existingConfig?: Config;
  defaultJournalMode?: boolean;
  compact: boolean;
}): Config {
  const fallbackConfig = defaultConfig(input.projectName, {
    projectId: input.projectIdentity.project_id,
    currentAgent: input.currentAgent.name,
    currentAgentId: input.currentAgent.id,
    projectMode: input.projectMode,
    projectStrategy: input.projectStrategy,
    storageDir: input.storageDir,
    topology: input.topology,
    ignoreStrategy: input.ignoreStrategy,
    // Solo-agent fresh default: the human running init is the default curator.
    // Without it, approval_policy=review + curators=[] = every candidate sits
    // in pending forever — a surprise the 2026-06-10 front-door audit flagged.
    // mergeConfigWithDefaults preserves any explicit curators list on an
    // existing store, so this only takes effect on fresh installs.
    curatorName: input.currentAgent.name,
  });
  const config = input.existingConfig
    ? mergeConfigWithDefaults(input.existingConfig, fallbackConfig)
    : fallbackConfig;
  const projects = config.projects ?? fallbackConfig.projects;

  config.project_name = input.projectName;
  config.project_id = input.projectIdentity.project_id;
  config.current_agent = input.currentAgent.name;
  config.current_agent_id = input.currentAgent.id;
  config.storage_dir = input.storageDir;
  config.topology = input.topology;
  config.ignore_strategy = input.ignoreStrategy;
  config.project_mode = input.projectMode;
  config.projects = {
    ...projects,
    strategy: input.projectStrategy,
    known: projects.known ?? fallbackConfig.projects.known,
  };

  if (input.compact) {
    const markdown = config.markdown ?? fallbackConfig.markdown ?? {
      max_items_per_section: 20,
      compact_mode: false,
    };
    config.markdown = {
      ...markdown,
      compact_mode: true,
      max_items_per_section: Math.min(markdown.max_items_per_section, 20),
    };
  }

  // pln#567 (decision A) — the event journal is ON by default for projects
  // created through init. Set HERE, never in defaultConfig:
  // createTestWorkspace builds its config straight from defaultConfig, so a dual
  // default there would make the whole core suite dual-write (trp_65176454).
  // Existing stores keep their current value, including unset legacy configs:
  // `migrate --enable-journal` is the explicit path that turns them on and
  // backfills genesis before future dual-writes depend on the journal.
  if (input.defaultJournalMode === true && config.store?.journal?.mode === undefined) {
    config.store = { ...config.store, journal: { ...config.store?.journal, mode: 'dual' } };
  }

  return config;
}

function mergeConfigWithDefaults(existingConfig: Config, fallbackConfig: Config): Config {
  return ConfigSchema.parse({
    ...fallbackConfig,
    ...existingConfig,
    projects: {
      ...fallbackConfig.projects,
      ...(existingConfig.projects ?? {}),
      known: existingConfig.projects?.known ?? fallbackConfig.projects.known,
    },
    redaction: {
      ...fallbackConfig.redaction,
      ...(existingConfig.redaction ?? {}),
      patterns: existingConfig.redaction?.patterns ?? fallbackConfig.redaction.patterns,
    },
    security: existingConfig.security
      ? {
          ...fallbackConfig.security,
          ...existingConfig.security,
        }
      : fallbackConfig.security,
    markdown: existingConfig.markdown
      ? {
          ...fallbackConfig.markdown,
          ...existingConfig.markdown,
        }
      : fallbackConfig.markdown,
    reflective_memory: existingConfig.reflective_memory
      ? {
          ...fallbackConfig.reflective_memory,
          ...existingConfig.reflective_memory,
        }
      : fallbackConfig.reflective_memory,
    governance: fallbackConfig.governance
      ? {
          ...fallbackConfig.governance,
          ...existingConfig.governance,
          curators: existingConfig.governance?.curators ?? fallbackConfig.governance.curators,
        }
      : existingConfig.governance,
    reputation: existingConfig.reputation
      ? {
          ...fallbackConfig.reputation,
          ...existingConfig.reputation,
        }
      : fallbackConfig.reputation,
    agent_integrations: {
      ...fallbackConfig.agent_integrations,
      ...(existingConfig.agent_integrations ?? {}),
      declarations: existingConfig.agent_integrations?.declarations ?? fallbackConfig.agent_integrations.declarations,
    },
    claims: existingConfig.claims
      ? {
          ...fallbackConfig.claims,
          ...existingConfig.claims,
        }
      : fallbackConfig.claims,
    sensitive_paths: existingConfig.sensitive_paths ?? fallbackConfig.sensitive_paths,
    cross_project_links: existingConfig.cross_project_links ?? fallbackConfig.cross_project_links,
  });
}
