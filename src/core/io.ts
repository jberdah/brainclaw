import fs from 'node:fs';
import path from 'node:path';
import { withLock, cleanStaleLocks } from './lock.js';

export { mutate } from './mutation-pipeline.js';

export const MEMORY_DIR = '.brainclaw';
const STORE_LOCK_BASENAME = '.store-mutation';
const RETRYABLE_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DEFAULT_RENAME_RETRY_ATTEMPTS = 6;
const DEFAULT_RENAME_RETRY_DELAY_MS = 25;

interface AtomicWriteOptions {
  fsImpl?: Pick<typeof fs, 'writeFileSync' | 'renameSync'>;
  maxRenameAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => void;
}

/**
 * Entity-aligned directory mapping.
 * Maps legacy flat directory names to their entity-partitioned paths.
 * Used by resolveEntityDir() for backward-compatible reads and forward writes.
 */
const ENTITY_DIR_MAP: Record<string, string> = {
  // memory/ — Project entity: durable knowledge
  'constraints': 'memory/constraints',
  'decisions': 'memory/decisions',
  'traps': 'memory/traps',
  'traps-hosts': 'memory/traps-hosts',
  'traps-private': 'memory/traps-private',
  'instructions': 'memory/instructions',

  // coordination/ — Agent↔Project: active work state
  'plans': 'coordination/plans',
  'sequences': 'coordination/sequences',
  'claims': 'coordination/claims',
  'handoffs': 'coordination/handoffs',
  'sessions': 'coordination/sessions',
  // Shared root: pending candidate JSONs live at inbox/, agent messages at inbox/{agent}/.
  'inbox': 'coordination/inbox',
  'inbox/accepted': 'coordination/inbox/accepted',
  'inbox/rejected': 'coordination/inbox/rejected',
  'runtime': 'coordination/runtime',
  'runtime-hosts': 'coordination/runtime-hosts',
  'runtime-private': 'coordination/runtime-private',
  'surface-tasks': 'coordination/surface-tasks',
  'assignments': 'coordination/assignments',
  'runs': 'coordination/runs',
  'actions': 'coordination/actions',

  // discovery/ — Project entity: what's available
  'bootstrap': 'discovery/bootstrap',
  'bootstrap/seeds': 'discovery/bootstrap/seeds',
  'capabilities': 'discovery/capabilities',
  'tools': 'discovery/tools',

  // agents/ — stays at top level (already entity-aligned)
  'agents': 'agents',
};

/**
 * Resolve a subdirectory path with entity-model awareness.
 *
 * For READS: tries the new entity path first, falls back to legacy flat path.
 * For WRITES: always uses the new entity path (creates parent dirs as needed).
 *
 * @param subdir Legacy subdirectory name (e.g. 'constraints', 'claims')
 * @param cwd Project root
 * @param mode 'read' checks both paths, 'write' uses new path only
 */
export function resolveEntityDir(
  subdir: string,
  cwd: string = process.cwd(),
  mode: 'read' | 'write' = 'read',
  preferredDirName?: string,
): string {
  const base = memoryDir(cwd, preferredDirName);
  const newPath = ENTITY_DIR_MAP[subdir];

  if (!newPath) {
    // Unknown subdirectory — use as-is
    return path.join(base, subdir);
  }

  const entityPath = path.join(base, newPath);
  const legacyPath = path.join(base, subdir);

  if (mode === 'write') {
    // Always write to new entity path
    return entityPath;
  }

  // Read: prefer entity path if it has content, fall back to legacy
  if (fs.existsSync(entityPath) && hasContent(entityPath)) return entityPath;
  if (fs.existsSync(legacyPath)) return legacyPath;

  // Neither exists — return entity path (caller will handle missing dir)
  return entityPath;
}

export function memoryDir(cwd: string = process.cwd(), preferredDirName?: string): string {
  return path.join(cwd, preferredDirName ?? MEMORY_DIR);
}

export function memoryPath(filename: string, cwd?: string, preferredDirName?: string): string {
  return path.join(memoryDir(cwd, preferredDirName), filename);
}

export function storeLockPath(cwd?: string, preferredDirName?: string): string {
  const root = cwd ?? process.cwd();
  const dirName = preferredDirName ?? MEMORY_DIR;
  // Keep the store-wide lock alongside the store root so it survives
  // upgrade park/swap renames. Writers and upgrade/rollback all share
  // this stable target.
  return path.join(root, `${dirName}${STORE_LOCK_BASENAME}`);
}

export function memoryExists(cwd?: string, preferredDirName?: string): boolean {
  return fs.existsSync(memoryDir(cwd, preferredDirName));
}

/**
 * Read the project vision from the first available source:
 * 1. PROJECT.md at workspace root (human-written, canonical)
 * 2. .brainclaw/project.md first non-header paragraph (legacy project.md export)
 * Returns undefined if no vision is found.
 */
export function readProjectVision(cwd: string = process.cwd()): string | undefined {
  // 1. PROJECT.md at workspace root — canonical source
  const projectMdPath = path.join(cwd, 'PROJECT.md');
  if (fs.existsSync(projectMdPath)) {
    try {
      const content = fs.readFileSync(projectMdPath, 'utf-8').trim();
      if (content) return content;
    } catch { /* fall through */ }
  }

  // 2. .brainclaw/project.md — extract description from first paragraph after title
  const legacyPath = path.join(cwd, MEMORY_DIR, 'project.md');
  if (fs.existsSync(legacyPath)) {
    try {
      const content = fs.readFileSync(legacyPath, 'utf-8');
      const vision = extractVisionFromProjectMd(content);
      if (vision) return vision;
    } catch { /* fall through */ }
  }

  return undefined;
}

/**
 * Extract the vision paragraph from the legacy .brainclaw/project.md format.
 * Looks for a description/vision section or the first non-header, non-list paragraph.
 */
function extractVisionFromProjectMd(content: string): string | undefined {
  const lines = content.split('\n');
  // Look for a line that starts with a descriptive phrase, skip headers and list items
  const descriptionLines: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, markdown headers, sentinel lines, and list items at start
    if (!trimmed) {
      if (inSection && descriptionLines.length > 0) break; // end of paragraph
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed.startsWith('- **[')) continue;
    if (trimmed.startsWith('- (none)')) continue;

    // Found a content line
    inSection = true;
    descriptionLines.push(trimmed);
  }

  return descriptionLines.length > 0 ? descriptionLines.join('\n') : undefined;
}

export function ensureMemoryDir(cwd?: string, preferredDirName?: string): void {
  const dir = memoryDir(cwd, preferredDirName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure entity-aligned subdirectories exist
  const entityDirs = [
    'memory/constraints', 'memory/decisions', 'memory/traps', 'memory/instructions',
    'coordination/plans', 'coordination/sequences', 'coordination/claims', 'coordination/handoffs', 'coordination/sessions',
    'coordination/inbox',
    'discovery',
    'agents',
  ];
  for (const subdir of entityDirs) {
    const p = path.join(dir, subdir);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  }
}

export function withStoreLock<T>(cwd: string = process.cwd(), fn: () => T, preferredDirName?: string): T {
  return withLock(storeLockPath(cwd, preferredDirName), () => {
    ensureMemoryDir(cwd, preferredDirName);
    return fn();
  });
}

/** Check if a path is a file, or a directory with at least one entry. */
function hasContent(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return true;
    if (stat.isDirectory()) return fs.readdirSync(p).length > 0;
    return false;
  } catch {
    return false;
  }
}

export function readFileSync(filepath: string): string {
  return fs.readFileSync(filepath, 'utf-8');
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makeTempPath(filepath: string): string {
  const dir = path.dirname(filepath);
  const base = path.basename(filepath);
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  return path.join(dir, `.${base}.${unique}.tmp`);
}

function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code ? RETRYABLE_RENAME_ERROR_CODES.has(code) : false;
}

function renameWithRetry(
  tmpPath: string,
  targetPath: string,
  options: Required<Pick<AtomicWriteOptions, 'fsImpl' | 'maxRenameAttempts' | 'retryDelayMs' | 'sleep'>>,
): void {
  const { fsImpl, maxRenameAttempts, retryDelayMs, sleep } = options;

  for (let attempt = 0; attempt < maxRenameAttempts; attempt++) {
    try {
      fsImpl.renameSync(tmpPath, targetPath);
      return;
    } catch (error: unknown) {
      if (!isRetryableRenameError(error) || attempt === maxRenameAttempts - 1) {
        throw error;
      }
      sleep(retryDelayMs * (attempt + 1));
    }
  }
}

/** Atomic write with advisory file locking: acquire lock, write to a temp file, then rename. */
export function writeFileAtomic(filepath: string, content: string, options: AtomicWriteOptions = {}): void {
  withLock(filepath, () => {
    const fsImpl = options.fsImpl ?? fs;
    const tmp = makeTempPath(filepath);
    fsImpl.writeFileSync(tmp, content, 'utf-8');
    renameWithRetry(tmp, filepath, {
      fsImpl,
      maxRenameAttempts: options.maxRenameAttempts ?? DEFAULT_RENAME_RETRY_ATTEMPTS,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RENAME_RETRY_DELAY_MS,
      sleep: options.sleep ?? syncSleep,
    });
  });
}

/**
 * Remove orphan .tmp and .lock files left by crashed processes.
 * Call once at CLI startup. Returns count of removed files.
 */
export function cleanOrphanFiles(dirPath: string): number {
  let removed = 0;
  if (!fs.existsSync(dirPath)) return 0;

  // Clean .tmp files (residual from crashed writeFileAtomic)
  try {
    for (const entry of fs.readdirSync(dirPath)) {
      const full = path.join(dirPath, entry);
      if (entry.endsWith('.tmp') && fs.statSync(full).isFile()) {
        try { fs.unlinkSync(full); removed++; } catch { /* already gone */ }
      }
      // Recurse into subdirectories
      if (fs.statSync(full).isDirectory()) {
        removed += cleanOrphanFiles(full);
      }
    }
  } catch { /* dir unreadable — skip */ }

  // Clean stale .lock files
  removed += cleanStaleLocks(dirPath);
  return removed;
}
