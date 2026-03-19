import fs from 'node:fs';
import path from 'node:path';
import { ensureMemoryDir, memoryDir, memoryExists, resolveEntityDir } from '../core/io.js';
import { loadState, saveState } from '../core/state.js';
import { scanMigrationStatus } from '../core/migration.js';
import { commitMemoryChange, initMemoryRepo } from '../core/memory-git.js';

export interface UpgradeOptions {
  cwd?: string;
  json?: boolean;
  dryRun?: boolean;
}

interface MigrationAction {
  type: 'create_dir' | 'move_file' | 'migrate_schema';
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
  { legacy: 'claims', entity: 'coordination/claims' },
  { legacy: 'handoffs', entity: 'coordination/handoffs' },
  { legacy: 'sessions', entity: 'coordination/sessions' },
  { legacy: 'inbox', entity: 'coordination/inbox' },
  { legacy: 'runtime', entity: 'coordination/runtime' },
];

export function runUpgrade(options: UpgradeOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
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
    saveState(state, cwd);
  }

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

  const parts = [`${movedFiles} file(s) moved`, `${outdated.length} schema(s) migrated`];
  if (removedDirs > 0) parts.push(`${removedDirs} empty legacy dir(s) removed`);
  console.log(`✔ Upgrade complete: ${parts.join(', ')}.`);
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
