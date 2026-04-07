import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './io.js';
import { logger } from './logger.js';

const GIT_DIR_NAME = '.git';
const ROLLBACK_ROOT_FILES = new Set([
  'config.yaml',
  'state.yaml',
  'project.md',
  'project.identity.json',
  '.id-counter.json',
]);
const ROLLBACK_EXCLUDED_BASENAMES = new Set([
  'archive.jsonl',
  'compacted.jsonl',
]);
const ROLLBACK_ALLOWED_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
]);
const ROLLBACK_ROOTS = [
  'constraints/',
  'decisions/',
  'traps/',
  'instructions/',
  'plans/',
  'sequences/',
  'claims/',
  'handoffs/',
  'surface-tasks/',
  'memory/constraints/',
  'memory/decisions/',
  'memory/traps/',
  'memory/instructions/',
  'coordination/plans/',
  'coordination/sequences/',
  'coordination/claims/',
  'coordination/handoffs/',
  'coordination/sessions/',
  'coordination/surface-tasks/',
  'sessions/',
] as const;

/**
 * Check if the memory directory has an internal git repo.
 */
export function hasMemoryRepo(cwd?: string): boolean {
  const gitDir = path.join(memoryDir(cwd), GIT_DIR_NAME);
  return fs.existsSync(gitDir);
}

/**
 * Initialize a git repo inside .brainclaw/ for memory versioning.
 * Idempotent — skips if already initialized.
 * Returns true if a new repo was created.
 */
export function initMemoryRepo(cwd?: string): boolean {
  const dir = memoryDir(cwd);
  if (!fs.existsSync(dir)) return false;
  if (hasMemoryRepo(cwd)) return false;

  try {
    git(dir, ['init', '--quiet']);

    // Configure the repo to avoid user identity errors on commit
    git(dir, ['config', 'user.name', 'brainclaw']);
    git(dir, ['config', 'user.email', 'brainclaw@local']);

    // Ignore temp files and locks
    const gitignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, ['*.tmp', '*.lock', ''].join('\n'), 'utf-8');
    }

    // Initial commit
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'brainclaw: initial memory snapshot']);

    return true;
  } catch (err) {
    logger.debug('Failed to initialize memory git repo:', err);
    return false;
  }
}

/**
 * Commit all pending changes in the memory repo.
 * Called after write operations (saveState, saveRuntimeNote, etc.).
 *
 * No-op if:
 * - No memory repo exists
 * - No changes to commit
 *
 * Returns true if a commit was created.
 */
export function commitMemoryChange(message: string, cwd?: string): boolean {
  if (!hasMemoryRepo(cwd)) return false;

  const dir = memoryDir(cwd);
  try {
    // Stage all changes
    git(dir, ['add', '-A']);

    // Check if there's anything to commit
    const status = git(dir, ['status', '--porcelain']);
    if (!status.trim()) return false;

    git(dir, ['commit', '--quiet', '-m', message]);
    return true;
  } catch (err) {
    logger.debug('Failed to commit memory change:', err);
    return false;
  }
}

/**
 * Get the short log of recent memory commits.
 */
export function getMemoryLog(limit: number = 20, cwd?: string): string[] {
  if (!hasMemoryRepo(cwd)) return [];

  const dir = memoryDir(cwd);
  try {
    const output = git(dir, ['log', '--oneline', `-${limit}`]);
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Restore live files from the current project's Brainclaw store to a previous
 * commit without deleting durable logs, archives, or compaction outputs.
 *
 * Behaviour note: this is intentionally selective and non-destructive.
 * It replaces an older "full-store reset" rollback model.
 *
 * This intentionally creates a new commit instead of performing a hard reset.
 * Returns true if successful.
 */
export function rollbackMemory(ref: string, cwd?: string): boolean {
  if (!hasMemoryRepo(cwd)) return false;

  const dir = memoryDir(cwd);
  try {
    git(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);

    const currentLiveFiles = listRollbackManagedFilesOnDisk(dir);
    const targetLiveFiles = listRollbackManagedFilesAtRef(dir, ref);
    const targetSet = new Set(targetLiveFiles);

    for (const relPath of currentLiveFiles) {
      if (!targetSet.has(relPath)) {
        removeManagedPath(dir, relPath);
      }
    }

    for (const relPath of targetLiveFiles) {
      restoreManagedPathFromRef(dir, ref, relPath);
    }

    stageManagedPaths(dir, new Set([...currentLiveFiles, ...targetLiveFiles]));
    const staged = git(dir, ['diff', '--cached', '--name-only'])
      .trim()
      .split('\n')
      .map((entry) => normalizeRelativePath(entry))
      .filter((entry) => entry.length > 0 && isRollbackManagedPath(entry));
    if (staged.length === 0) return false;

    git(dir, ['commit', '--quiet', '-m', `brainclaw: rollback live memory to ${ref}`]);
    return true;
  } catch (err) {
    logger.debug('Failed to rollback memory:', err);
    return false;
  }
}

/**
 * Get the current HEAD short hash.
 */
export function getMemoryHead(cwd?: string): string | undefined {
  if (!hasMemoryRepo(cwd)) return undefined;

  try {
    return git(memoryDir(cwd), ['rev-parse', '--short', 'HEAD']).trim();
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function normalizeRelativePath(filepath: string): string {
  return filepath.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function isRollbackManagedPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  if (ROLLBACK_ROOT_FILES.has(normalized)) return true;

  const rootMatched = ROLLBACK_ROOTS.some((prefix) => normalized.startsWith(prefix));
  if (!rootMatched) return false;

  const basename = path.posix.basename(normalized);
  if (ROLLBACK_EXCLUDED_BASENAMES.has(basename)) return false;

  const extension = path.posix.extname(basename).toLowerCase();
  return ROLLBACK_ALLOWED_EXTENSIONS.has(extension);
}

function listRollbackManagedFilesAtRef(cwd: string, ref: string): string[] {
  const output = git(cwd, ['ls-tree', '-r', '--name-only', ref]);
  return output
    .split('\n')
    .map((entry) => normalizeRelativePath(entry))
    .filter((entry) => entry.length > 0 && isRollbackManagedPath(entry))
    .sort();
}

function listRollbackManagedFilesOnDisk(cwd: string): string[] {
  const results: string[] = [];
  walkFiles(cwd, cwd, results);
  results.sort();
  return results;
}

function walkFiles(baseDir: string, currentDir: string, results: string[]): void {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === GIT_DIR_NAME) continue;
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(baseDir, absolutePath, results);
      continue;
    }
    const relativePath = normalizeRelativePath(path.relative(baseDir, absolutePath));
    if (isRollbackManagedPath(relativePath)) {
      results.push(relativePath);
    }
  }
}

function removeManagedPath(cwd: string, relativePath: string): void {
  const absolutePath = path.join(cwd, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  fs.unlinkSync(absolutePath);
  removeEmptyParentDirs(path.dirname(absolutePath), cwd);
}

function removeEmptyParentDirs(startDir: string, stopDir: string): void {
  let current = startDir;
  const resolvedStop = path.resolve(stopDir);
  while (path.resolve(current).startsWith(resolvedStop) && path.resolve(current) !== resolvedStop) {
    const entries = fs.readdirSync(current);
    if (entries.length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function restoreManagedPathFromRef(cwd: string, ref: string, relativePath: string): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const content = gitBuffer(cwd, ['show', `${ref}:${relativePath}`]);
  fs.writeFileSync(absolutePath, content);
}

function stageManagedPaths(cwd: string, managedPaths: Set<string>): void {
  const paths = [...managedPaths].filter(Boolean);
  const chunkSize = 64;
  for (let index = 0; index < paths.length; index += chunkSize) {
    const chunk = paths.slice(index, index + chunkSize);
    git(cwd, ['add', '-A', '--', ...chunk]);
  }
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
