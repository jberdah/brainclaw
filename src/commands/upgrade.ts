import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureMemoryDir, memoryDir, memoryExists, resolveEntityDir } from '../core/io.js';
import { loadState, persistState, saveState } from '../core/state.js';
import { scanMigrationStatus } from '../core/migration.js';
import { commitMemoryChange, initMemoryRepo } from '../core/memory-git.js';
import {
  BRAINCLAW_SECTION_END,
  BRAINCLAW_SECTION_START,
  buildBrainclawSection,
  buildClaudeCodeCommandText,
  ensureClaudeCodeCommand,
  hasBrainclawSection,
  patchAllMcpConfigs,
} from '../core/agent-files.js';
import { loadConfig } from '../core/config.js';
import { checkBrainclawInstallableUpdate, getInstalledBrainclawVersion } from '../core/brainclaw-version.js';
import { resolvePrimaryStore } from '../core/store-resolution.js';
import {
  BackupError,
  createBackup,
  listBackups,
  restoreBackup,
  type BackupHandle,
} from '../core/upgrades/backup.js';
import { renderAgentExportForAgent, writeAgentExportForAgent } from './export.js';
import { generateCursorHook, writeHook } from './hooks.js';

/** Schema target versions supported by `brainclaw upgrade --to=<version>`. */
export const SUPPORTED_SCHEMA_TARGETS = ['1.0'] as const;
export type SchemaTarget = typeof SUPPORTED_SCHEMA_TARGETS[number];

export interface UpgradeOptions {
  cwd?: string;
  json?: boolean;
  dryRun?: boolean;
  /** If true, detect a newer brainclaw package version and install it before upgrading memory. */
  selfUpdate?: boolean;
  /**
   * Target schema version for the one-shot v1.0 upgrade path. Enables
   * the candidate archive / handoff strip / provenance rollout patches
   * (implemented in later steps of pln_bc6e88cc). Presence of `to`
   * also implies `backup: true` unless explicitly disabled via
   * `backup: false`.
   */
  to?: SchemaTarget;
  /** Create a timestamped backup before any write. Default: true when `to` is set. */
  backup?: boolean;
  /** Restore the most recent backup and park the current live store. Early-exits, skips other phases. */
  rollback?: boolean;
  /** Skip interactive confirmations. Currently no-op (prompts not yet added). */
  yes?: boolean;
}

interface MigrationAction {
  type: 'create_dir' | 'move_file' | 'migrate_schema' | 'refresh_agent_file';
  from?: string;
  to?: string;
  description: string;
}

/**
 * Entity directory layout mapping: legacy flat name → entity-aligned path.
 * Must match ENTITY_DIR_MAP in io.ts.
 */
const ENTITY_DIRS: Array<{ legacy: string; entity: string }> = [
  { legacy: 'constraints', entity: 'memory/constraints' },
  { legacy: 'decisions', entity: 'memory/decisions' },
  { legacy: 'traps', entity: 'memory/traps' },
  { legacy: 'instructions', entity: 'memory/instructions' },
  { legacy: 'plans', entity: 'coordination/plans' },
  { legacy: 'sequences', entity: 'coordination/sequences' },
  { legacy: 'claims', entity: 'coordination/claims' },
  { legacy: 'handoffs', entity: 'coordination/handoffs' },
  { legacy: 'sessions', entity: 'coordination/sessions' },
  { legacy: 'inbox', entity: 'coordination/inbox' },
  { legacy: 'runtime', entity: 'coordination/runtime' },
];

const WORKSPACE_EXPORT_REFRESH_AGENTS = [
  { agentName: 'claude-code', relativePath: 'CLAUDE.md' },
  { agentName: 'cursor', relativePath: '.cursor/rules/brainclaw.md' },
  { agentName: 'windsurf', relativePath: '.windsurfrules' },
  { agentName: 'cline', relativePath: '.clinerules/brainclaw.md' },
  { agentName: 'roo', relativePath: '.roo/rules/brainclaw.md' },
  { agentName: 'continue', relativePath: '.continue/rules/brainclaw.md' },
  { agentName: 'antigravity', relativePath: 'GEMINI.md' },
] as const;

export function runUpgrade(options: UpgradeOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  // Rollback short-circuit: restore the most recent backup, park the
  // current live store, and exit. Runs before any other upgrade work.
  if (options.rollback) {
    runRollback(cwd, options);
    return;
  }

  // Validate --to target before touching anything.
  if (options.to && !SUPPORTED_SCHEMA_TARGETS.includes(options.to)) {
    console.error(`Error: unsupported schema target "${options.to}". Supported: ${SUPPORTED_SCHEMA_TARGETS.join(', ')}`);
    process.exit(1);
  }

  // Backup pass: create a timestamped backup before any modification.
  // Explicit --backup always triggers it; --to implies --backup unless
  // the caller explicitly passed backup:false.
  const backupRequested = options.backup ?? (options.to !== undefined);
  let backupHandle: BackupHandle | undefined;
  if (backupRequested && !options.dryRun) {
    try {
      backupHandle = createUpgradeBackup(cwd, options);
    } catch (error: unknown) {
      const message = error instanceof BackupError ? error.message : (error as Error).message;
      console.error(`Error: backup failed — ${message}`);
      console.error('Aborting upgrade. No changes made.');
      process.exit(1);
    }
    if (!options.json) {
      console.log(`✔ Backup created at ${backupHandle.backupPath}`);
    }
  } else if (backupRequested && options.dryRun && !options.json) {
    console.log('(dry run — would create backup before upgrade)');
  }

  // Self-update: install a newer brainclaw version from npm/local-pack before upgrading memory
  if (options.selfUpdate) {
    const config = loadConfig(cwd);
    const updateCheck = checkBrainclawInstallableUpdate(config, cwd, { useDefaultNpmSource: true });
    if (updateCheck.status === 'update_available' && updateCheck.install_command) {
      const installedVersion = getInstalledBrainclawVersion();
      if (!options.json) {
        console.log(`📦 New version available: ${updateCheck.latest_installable_version} (current: ${installedVersion})`);
        console.log(`   Running: ${updateCheck.install_command}`);
      }
      if (!options.dryRun) {
        const parts = updateCheck.install_command.split(' ');
        const result = spawnSync(parts[0]!, parts.slice(1), { stdio: 'inherit', encoding: 'utf-8' });
        if (result.status !== 0) {
          console.error('Error: install command failed. Check output above.');
          if (!options.json) {
            console.error(`  Re-run manually: ${updateCheck.install_command}`);
          }
          process.exit(1);
        }
        if (!options.json) {
          console.log(`✔ Brainclaw updated to ${updateCheck.latest_installable_version}`);
          console.log('  MCP servers using this installation will need a restart.');
          console.log('  In Claude Code: use /restart or restart the MCP session.');
        }
      } else {
        if (!options.json) {
          console.log(`  (dry run — would run: ${updateCheck.install_command})`);
        }
      }
    } else if (updateCheck.status === 'up_to_date') {
      if (!options.json) {
        console.log(`✔ Brainclaw is already up to date (${getInstalledBrainclawVersion()})`);
      }
    } else {
      if (!options.json) {
        console.log(`ℹ No installable update found (${updateCheck.status})`);
      }
    }
    if (!options.json) console.log('');
  }

  const base = memoryDir(cwd);
  const actions: MigrationAction[] = [];
  let movedFiles = 0;

  // Phase 1: Ensure entity-aligned directories exist
  ensureMemoryDir(cwd);

  // Phase 2: Detect and plan file migrations (legacy → entity)
  for (const { legacy, entity } of ENTITY_DIRS) {
    const legacyDir = path.join(base, legacy);
    const entityDir = path.join(base, entity);

    if (!fs.existsSync(legacyDir)) continue;

    // Recursively collect all JSON files (handles subdirs like runtime/agent/, inbox/accepted/)
    const files = listJsonFilesRecursive(legacyDir);
    if (files.length === 0) continue;

    for (const file of files) {
      // Preserve subdirectory structure: runtime/jberdah/rtn_xxx.json → coordination/runtime/jberdah/rtn_xxx.json
      const relativeToLegacy = path.relative(legacyDir, file);
      const target = path.join(entityDir, relativeToLegacy);

      if (fs.existsSync(target)) {
        // Entity dir already has this file — skip (entity takes precedence)
        continue;
      }

      actions.push({
        type: 'move_file',
        from: path.relative(base, file),
        to: path.relative(base, target),
        description: `Move ${relativeToLegacy} from ${legacy}/ to ${entity}/`,
      });
    }
  }

  // Phase 3: Check schema migration status
  const migrationStatus = scanMigrationStatus(cwd);
  const outdated = migrationStatus.filter(e => e.status === 'outdated');
  for (const entry of outdated) {
    actions.push({
      type: 'migrate_schema',
      from: entry.path,
      description: `Migrate ${entry.documentType} from v${entry.detectedVersion} to v${entry.currentVersion}`,
    });
  }

  const agentRefreshActions = scanManagedWorkspaceAgentFileRefreshes(cwd);
  actions.push(...agentRefreshActions);

  // Report
  if (options.json) {
    outputJson(actions, options.dryRun ?? false);
    return;
  }

  if (actions.length === 0) {
    console.log('✔ Project memory is up to date. No upgrade needed.');
    return;
  }

  console.log(`Found ${actions.length} upgrade action(s):\n`);
  for (const action of actions) {
    const prefix = action.type === 'move_file' ? '→' : '↑';
    console.log(`  ${prefix} ${action.description}`);
  }

  if (options.dryRun) {
    console.log('\n(dry run — no changes made)');
    return;
  }

  // Execute file moves
  console.log('');
  for (const action of actions) {
    if (action.type === 'move_file' && action.from && action.to) {
      const src = path.join(base, action.from);
      const dst = path.join(base, action.to);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      movedFiles++;
    }
  }

  // Execute schema migrations by re-saving state (loadState auto-migrates via Zod parse)
  if (outdated.length > 0) {
    const state = loadState(cwd);
    persistState(state, cwd);
  }

  const refreshedAgentFiles = refreshManagedWorkspaceAgentFiles(cwd);

  // Patch all MCP config files to use the newly resolved brainclaw binary
  const patchedMcpConfigs = patchAllMcpConfigs(cwd);

  // Clean up empty legacy directories (recursively removes empty subdirs first)
  let removedDirs = 0;
  for (const { legacy } of ENTITY_DIRS) {
    const legacyDir = path.join(base, legacy);
    if (fs.existsSync(legacyDir)) {
      removedDirs += removeEmptyDirsRecursive(legacyDir);
    }
  }

  // Ensure memory git repo exists and commit the upgrade
  initMemoryRepo(cwd);
  commitMemoryChange(`upgrade: ${movedFiles} files moved, ${outdated.length} schemas migrated`, cwd);

  const parts = [
    `${movedFiles} file(s) moved`,
    `${outdated.length} schema(s) migrated`,
    `${refreshedAgentFiles.length} managed agent file(s) refreshed`,
  ];
  if (patchedMcpConfigs.length > 0) parts.push(`${patchedMcpConfigs.length} MCP config(s) patched`);
  if (removedDirs > 0) parts.push(`${removedDirs} empty legacy dir(s) removed`);
  console.log(`✔ Upgrade complete: ${parts.join(', ')}.`);
}

function scanManagedWorkspaceAgentFileRefreshes(cwd: string): MigrationAction[] {
  const config = loadConfig(cwd);
  const storageDir = config.storage_dir ?? '.brainclaw';
  const actions: MigrationAction[] = [];

  const agentsPath = path.join(cwd, 'AGENTS.md');
  const agentsMode = getManagedInstructionMode(agentsPath);
  if (agentsMode === 'bootstrap' && needsBootstrapSectionRefresh(agentsPath, buildBrainclawSection(storageDir))) {
    actions.push({
      type: 'refresh_agent_file',
      to: 'AGENTS.md',
      description: 'Refresh managed Brainclaw section in AGENTS.md',
    });
  } else if (agentsMode === 'export') {
    const rendered = renderAgentExportForAgent('codex', cwd);
    if (rendered && needsExportSectionRefresh(agentsPath, rendered.content)) {
      actions.push({
        type: 'refresh_agent_file',
        to: 'AGENTS.md',
        description: 'Refresh generated Brainclaw instructions in AGENTS.md',
      });
    }
  }

  const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
  const copilotMode = getManagedInstructionMode(copilotPath);
  if (copilotMode === 'bootstrap' && needsBootstrapSectionRefresh(copilotPath, buildBrainclawSection(storageDir))) {
    actions.push({
      type: 'refresh_agent_file',
      to: '.github/copilot-instructions.md',
      description: 'Refresh managed Brainclaw section in .github/copilot-instructions.md',
    });
  } else if (copilotMode === 'export') {
    const rendered = renderAgentExportForAgent('github-copilot', cwd);
    if (rendered && needsExportSectionRefresh(copilotPath, rendered.content)) {
      actions.push({
        type: 'refresh_agent_file',
        to: '.github/copilot-instructions.md',
        description: 'Refresh generated Brainclaw instructions in .github/copilot-instructions.md',
      });
    }
  }

  for (const target of WORKSPACE_EXPORT_REFRESH_AGENTS) {
    const filePath = path.join(cwd, target.relativePath);
    const rendered = renderAgentExportForAgent(target.agentName, cwd);
    if (rendered && needsExportSectionRefresh(filePath, rendered.content)) {
      actions.push({
        type: 'refresh_agent_file',
        to: target.relativePath,
        description: `Refresh generated Brainclaw instructions in ${target.relativePath}`,
      });
    }
  }

  const claudeCommandPath = path.join(cwd, '.claude', 'commands', 'brainclaw.md');
  if (fs.existsSync(claudeCommandPath) && fs.readFileSync(claudeCommandPath, 'utf-8') !== buildClaudeCodeCommandText()) {
    actions.push({
      type: 'refresh_agent_file',
      to: '.claude/commands/brainclaw.md',
      description: 'Refresh Claude Code Brainclaw command instructions',
    });
  }

  const cursorHookPath = path.join(cwd, '.cursor', 'rules', 'brainclaw-session.mdc');
  const expectedCursorHook = generateCursorHook(config.project_name);
  if (fs.existsSync(cursorHookPath) && fs.readFileSync(cursorHookPath, 'utf-8') !== expectedCursorHook) {
    actions.push({
      type: 'refresh_agent_file',
      to: '.cursor/rules/brainclaw-session.mdc',
      description: 'Refresh Cursor Brainclaw session hook',
    });
  }

  return actions;
}

function refreshManagedWorkspaceAgentFiles(cwd: string): string[] {
  const config = loadConfig(cwd);
  const storageDir = config.storage_dir ?? '.brainclaw';
  const refreshed = new Set<string>();

  const agentsPath = path.join(cwd, 'AGENTS.md');
  const agentsMode = getManagedInstructionMode(agentsPath);
  if (agentsMode === 'bootstrap') {
    if (writeBootstrapSectionFile(agentsPath, buildBrainclawSection(storageDir))) {
      refreshed.add('AGENTS.md');
    }
  } else if (agentsMode === 'export') {
    const result = writeAgentExportForAgent('codex', cwd);
    if (result && (result.created || result.updated)) {
      refreshed.add(result.relativePath);
    }
  }

  const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
  const copilotMode = getManagedInstructionMode(copilotPath);
  if (copilotMode === 'bootstrap') {
    if (writeBootstrapSectionFile(copilotPath, buildBrainclawSection(storageDir))) {
      refreshed.add('.github/copilot-instructions.md');
    }
  } else if (copilotMode === 'export') {
    const result = writeAgentExportForAgent('github-copilot', cwd);
    if (result && (result.created || result.updated)) {
      refreshed.add(result.relativePath);
    }
  }

  for (const target of WORKSPACE_EXPORT_REFRESH_AGENTS) {
    const filePath = path.join(cwd, target.relativePath);
    if (!fs.existsSync(filePath) || !hasBrainclawSection(fs.readFileSync(filePath, 'utf-8'))) {
      continue;
    }

    const result = writeAgentExportForAgent(target.agentName, cwd);
    if (result && (result.created || result.updated)) {
      refreshed.add(result.relativePath);
    }
  }

  if (fs.existsSync(path.join(cwd, '.claude', 'commands', 'brainclaw.md'))) {
    const result = ensureClaudeCodeCommand(cwd);
    if (result.created || result.updated) {
      refreshed.add(result.relativePath ?? '.claude/commands/brainclaw.md');
    }
  }

  if (fs.existsSync(path.join(cwd, '.cursor', 'rules', 'brainclaw-session.mdc'))) {
    const expected = generateCursorHook(config.project_name);
    const filePath = path.join(cwd, '.cursor', 'rules', 'brainclaw-session.mdc');
    if (fs.readFileSync(filePath, 'utf-8') !== expected) {
      const result = writeHook(expected, '.cursor/rules/brainclaw-session.mdc', cwd);
      refreshed.add(result.relativePath);
    }
  }

  return [...refreshed];
}

function getManagedInstructionMode(filePath: string): 'bootstrap' | 'export' | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const existing = fs.readFileSync(filePath, 'utf-8');
  if (!hasBrainclawSection(existing)) {
    return undefined;
  }
  if (existing.includes('## Brainclaw — shared project memory')) {
    return 'bootstrap';
  }
  return 'export';
}

function writeBootstrapSectionFile(filePath: string, section: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const existing = fs.readFileSync(filePath, 'utf-8');
  if (!hasBrainclawSection(existing)) {
    return false;
  }
  const next = upsertSection(existing, section);
  if (next === existing) {
    return false;
  }
  fs.writeFileSync(filePath, next, 'utf-8');
  return true;
}

function needsBootstrapSectionRefresh(filePath: string, section: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const existing = fs.readFileSync(filePath, 'utf-8');
  if (!hasBrainclawSection(existing)) {
    return false;
  }
  return existing !== upsertSection(existing, section);
}

function needsExportSectionRefresh(filePath: string, content: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const existing = fs.readFileSync(filePath, 'utf-8');
  if (!hasBrainclawSection(existing)) {
    return false;
  }
  const section = `${BRAINCLAW_SECTION_START}\n${content}\n${BRAINCLAW_SECTION_END}`;
  return existing !== upsertSection(existing, section);
}

function upsertSection(existingContent: string, section: string): string {
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

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

function listJsonFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listJsonFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/** Recursively remove empty directories bottom-up. Returns count of dirs removed. */
function removeEmptyDirsRecursive(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removed += removeEmptyDirsRecursive(path.join(dir, entry.name));
    }
  }

  if (isEmptyDir(dir)) {
    fs.rmdirSync(dir);
    removed++;
  }

  return removed;
}

function outputJson(actions: MigrationAction[], dryRun: boolean): void {
  console.log(JSON.stringify({
    upgrade_needed: actions.length > 0,
    dry_run: dryRun,
    actions_count: actions.length,
    actions,
  }, null, 2));
}

function createUpgradeBackup(cwd: string, options: UpgradeOptions): BackupHandle {
  const store = resolvePrimaryStore(cwd);
  if (!store) {
    throw new BackupError('no_store', `No .brainclaw/ store resolved from ${cwd}`);
  }
  const note = options.to
    ? `brainclaw upgrade --to=${options.to}`
    : 'brainclaw upgrade';
  return createBackup({ storePath: store.storePath, note });
}

function runRollback(cwd: string, options: UpgradeOptions): void {
  const store = resolvePrimaryStore(cwd);
  if (!store) {
    console.error(`Error: no .brainclaw/ store resolved from ${cwd}`);
    process.exit(1);
  }

  const backups = listBackups(store.storePath);
  if (backups.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'noop', reason: 'no_backups', store_path: store.storePath }, null, 2));
    } else {
      console.error(`Error: no backups found next to ${store.storePath}. Nothing to roll back.`);
    }
    process.exit(1);
  }

  const target = backups[0]!;
  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify({
        status: 'dry_run',
        backup_path: target.backupPath,
        created_at: target.manifest.created_at,
      }, null, 2));
    } else {
      console.log(`(dry run — would restore ${target.backupPath} created ${target.manifest.created_at})`);
    }
    return;
  }

  try {
    const result = restoreBackup({ storePath: store.storePath, backupPath: target.backupPath });
    if (options.json) {
      console.log(JSON.stringify({
        status: 'rolled_back',
        store_path: store.storePath,
        backup_path: target.backupPath,
        parked_path: result.parkedPath,
        created_at: target.manifest.created_at,
      }, null, 2));
    } else {
      console.log(`✔ Rolled back to ${target.backupPath} (created ${target.manifest.created_at})`);
      console.log(`  Previous live store parked at ${result.parkedPath}`);
    }
  } catch (error: unknown) {
    const message = error instanceof BackupError ? error.message : (error as Error).message;
    console.error(`Error: rollback failed — ${message}`);
    process.exit(1);
  }
}
