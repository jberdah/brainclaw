import fs from 'node:fs';
import path from 'node:path';
import { withLock, cleanStaleLocks } from './lock.js';

export const MEMORY_DIR = '.brainclaw';

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
  'claims': 'coordination/claims',
  'handoffs': 'coordination/handoffs',
  'sessions': 'coordination/sessions',
  'inbox': 'coordination/inbox',
  'inbox/accepted': 'coordination/inbox/accepted',
  'inbox/rejected': 'coordination/inbox/rejected',
  'runtime': 'coordination/runtime',
  'runtime-hosts': 'coordination/runtime-hosts',
  'runtime-private': 'coordination/runtime-private',

  // discovery/ — Project entity: what's available
  'bootstrap': 'discovery/bootstrap',
  'bootstrap/seeds': 'discovery/bootstrap/seeds',

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

export function memoryExists(cwd?: string, preferredDirName?: string): boolean {
  return fs.existsSync(memoryDir(cwd, preferredDirName));
}

export function ensureMemoryDir(cwd?: string, preferredDirName?: string): void {
  const dir = memoryDir(cwd, preferredDirName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure entity-aligned subdirectories exist
  const entityDirs = [
    'memory/constraints', 'memory/decisions', 'memory/traps', 'memory/instructions',
    'coordination/plans', 'coordination/claims', 'coordination/handoffs', 'coordination/sessions',
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

/** Atomic write with advisory file locking: acquire lock, write to a temp file, then rename. */
export function writeFileAtomic(filepath: string, content: string): void {
  withLock(filepath, () => {
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filepath);
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
