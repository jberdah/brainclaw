import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock, cleanStaleLocks } from './lock.js';

export { mutate } from './mutation-pipeline.js';

export const MEMORY_DIR = '.brainclaw';
const STORE_LOCK_BASENAME = '.store-mutation';
const RETRYABLE_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DEFAULT_RENAME_RETRY_ATTEMPTS = 6;
const DEFAULT_RENAME_RETRY_DELAY_MS = 25;
const TMP_ORPHAN_MIN_AGE_MS = 60_000;

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
/**
 * Exported (pln#649 step 2, review P1-1) so a caller that needs the CANONICAL
 * relative path for a kind can build a file path directly. `resolveEntityDir`
 * answers "where do records of this kind generally live" by picking whichever
 * directory has content — which is the wrong primitive when the question is
 * "where is THIS record", because a mid-migration store makes the other layout
 * invisible. Read-only by contract: never mutate this map.
 */
export const ENTITY_DIR_MAP: Record<string, string> = {
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
  // federation/ — outbound cloud sync queue (pln#101 Phase 2): durable outbox,
  // archived 'sent' markers, and 'parked' dead-letters.
  'federation': 'coordination/federation',
  'federation/outbox': 'coordination/federation/outbox',
  'federation/sent': 'coordination/federation/sent',
  'federation/parked': 'coordination/federation/parked',
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

/**
 * EVERY directory a record of `subdir` can occupy in ONE store, canonical first.
 *
 * THE PRIMITIVE THAT WAS MISSING (pln#649, after three reviews found the same defect
 * at three different call sites). `resolveEntityDir(mode='read')` answers a
 * DIRECTORY question — "where do records of this kind generally live" — using a
 * `hasContent` heuristic. Every by-id loader used it for a FILE question — "where is
 * THIS record" — and the two are not the same: in a store mid-migration, one file in
 * the canonical directory makes every legacy record invisible. That produced a
 * reproduced defect in the entity locator, then again in `loadAssignment`, and it is
 * still latent wherever a loader resolves a directory before looking for an id.
 *
 * Callers that need a specific record MUST iterate these, not pick one. Writes keep
 * using `resolveEntityDir(..., 'write')`, which is always canonical, so nothing new
 * is ever created in the legacy layout — this is a read-compatibility primitive, not
 * a migration.
 */
export function entityRecordDirs(subdir: string, cwd: string = process.cwd(), preferredDirName?: string): string[] {
  const base = memoryDir(cwd, preferredDirName);
  const mapped = ENTITY_DIR_MAP[subdir];
  const legacy = path.join(base, subdir);
  if (!mapped) return [legacy];
  const canonical = path.join(base, mapped);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

/** The same, as record file paths for one id. */
export function entityRecordPaths(subdir: string, id: string, cwd?: string, preferredDirName?: string): string[] {
  return entityRecordDirs(subdir, cwd ?? process.cwd(), preferredDirName).map((d) => path.join(d, `${id}.json`));
}

export const SESSION_SNAPSHOT_FILENAME_SUFFIX = '.snapshot.json';

/**
 * Filesystem type discriminator for session snapshots (codex review, pln#670).
 * Case-fold before the suffix comparison because default Windows filesystems
 * are case-insensitive: `X.SNAPSHOT.json` IS the path a lower-case probe
 * resolves, and every suffix decision must agree on its type.
 */
export function isSessionSnapshotRecordFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(SESSION_SNAPSHOT_FILENAME_SUFFIX);
}

/**
 * EVERY path a session_snapshot record for `sessionId` can occupy, canonical first.
 *
 * session_snapshot and current_session are two different record types that share
 * the `sessions` directory family AND the same session_id — only the filename keeps
 * them apart (pln#670). Snapshots are written as `<id>.snapshot.json` so a
 * current_session `<id>.json` for the same session can never clobber them, whatever
 * directory each resolver picks. The plain `<id>.json` probes cover records written
 * before the split; readers must schema-validate every candidate.
 */
export function sessionSnapshotRecordPaths(sessionId: string, cwd?: string, preferredDirName?: string): string[] {
  const dirs = entityRecordDirs('sessions', cwd ?? process.cwd(), preferredDirName);
  return [
    ...dirs.map((d) => path.join(d, `${sessionId}.snapshot.json`)),
    ...dirs.map((d) => path.join(d, `${sessionId}.json`)),
  ];
}

export function memoryDir(cwd: string = process.cwd(), preferredDirName?: string): string {
  return path.join(cwd, preferredDirName ?? MEMORY_DIR);
}

/**
 * Walk UP from a directory and return the outermost .brainclaw/ root found.
 * Bypasses resolveEffectiveCwd / active project entirely — the answer depends
 * only on the filesystem, which is what makes it safe for identity-level state
 * that must NOT follow the active project (pln#648: a session record anchored
 * on the effective cwd moved with every switch, out of the resolver's reach).
 *
 * Lives HERE, in a leaf module: identity.ts needs it, and store-resolution.ts
 * imports identity.ts — the import cycle that blocked pln#648's first attempt.
 * store-resolution re-exports it for its existing callers.
 *
 * Stops at the filesystem root, at $HOME (a user-level store is never a
 * workspace root), and never climbs ABOVE BRAINCLAW_STORE_BOUNDARY when set —
 * the containment contract tests and agent shells rely on (a leaked parent
 * store must not widen the walk into the host machine).
 */
export function findOutermostBrainclawRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  const home = os.homedir();
  const boundaryRaw = process.env.BRAINCLAW_STORE_BOUNDARY?.trim();
  const boundary = boundaryRaw ? path.resolve(boundaryRaw) : undefined;
  let outermost: string | undefined;

  while (dir !== root && dir !== home) {
    if (fs.existsSync(path.join(dir, MEMORY_DIR, 'config.yaml'))) {
      outermost = dir;
    }
    if (boundary && dir === boundary) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return outermost;
}

/**
 * The workspace anchor for identity-level state (pln#648 review P1): walking
 * UP, the NEAREST store declaring `store_type: workspace` wins; only when no
 * workspace is declared does the outermost store answer. Without the role
 * check, two sibling declared workspaces under a common parent store would
 * anchor to that parent and see each other's sessions — breaking exactly the
 * isolation `resolveWorkspaceRoot` (chain-based, role-aware) guarantees.
 * The role is read from the raw YAML — the same convention the store-chain
 * walk uses (`store_type` is not part of the typed Config surface) — so this
 * stays a leaf-module fs answer with no config.ts dependency.
 * Same stops as the outermost walk: filesystem root, $HOME, and never above
 * BRAINCLAW_STORE_BOUNDARY.
 */
export function findSessionAnchorRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  const home = os.homedir();
  const boundaryRaw = process.env.BRAINCLAW_STORE_BOUNDARY?.trim();
  const boundary = boundaryRaw ? path.resolve(boundaryRaw) : undefined;
  let outermost: string | undefined;

  while (dir !== root && dir !== home) {
    const configPath = path.join(dir, MEMORY_DIR, 'config.yaml');
    if (fs.existsSync(configPath)) {
      outermost = dir;
      try {
        if (/^store_type:\s*workspace\b/m.test(fs.readFileSync(configPath, 'utf-8'))) {
          return dir;
        }
      } catch { /* unreadable config — treat as a plain store */ }
    }
    if (boundary && dir === boundary) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return outermost;
}

export function memoryPath(filename: string, cwd?: string, preferredDirName?: string): string {
  return path.join(memoryDir(cwd, preferredDirName), filename);
}

export function storeLockPath(cwd?: string, preferredDirName?: string): string {
  // O3 (lop_e2d566765b8b4ce3): canonicalize so two spellings of the same store
  // (relative vs absolute) produce one lock target / re-entrancy key.
  const root = path.resolve(cwd ?? process.cwd());
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
export function readProjectVision(cwd: string = process.cwd(), thresholdLines: number = 20): string | undefined {
  // 1. PROJECT.md at workspace root — canonical source
  const projectMdPath = path.join(cwd, 'PROJECT.md');
  if (fs.existsSync(projectMdPath)) {
    try {
      const content = fs.readFileSync(projectMdPath, 'utf-8').trim();
      if (content) {
        const lines = content.split('\n');
        if (lines.length <= thresholdLines) {
          return content;
        }
        return `> **Project Domain Rules**\n> This project maintains detailed domain rules and architecture externally to avoid context bloat.\n> You MUST read \`PROJECT.md\` in the workspace root to understand the project constraints, tech stack, and conventions before coding.`;
      }
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

/**
 * Canonical list of entity-aligned subdirectories expected under `.brainclaw/`.
 * Exposed so doctor + repair flows can audit presence without duplicating the
 * list (pln#397 stp_b5337e30).
 */
export const REQUIRED_ENTITY_SUBDIRS = [
  'memory/constraints', 'memory/decisions', 'memory/traps', 'memory/instructions',
  'coordination/plans', 'coordination/sequences', 'coordination/claims', 'coordination/handoffs', 'coordination/sessions',
  'coordination/inbox',
  'discovery',
  'agents',
] as const;

export function ensureMemoryDir(cwd?: string, preferredDirName?: string): void {
  const dir = memoryDir(cwd, preferredDirName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure entity-aligned subdirectories exist
  for (const subdir of REQUIRED_ENTITY_SUBDIRS) {
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tempOwnerPid(entry: string): number | undefined {
  if (!entry.endsWith('.tmp')) return undefined;
  const parts = entry.split('.');
  const pid = Number(parts.at(-4));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function shouldRemoveTmp(entry: string, stat: fs.Stats): boolean {
  const pid = tempOwnerPid(entry);
  if (!pid) return false;
  if (Date.now() - stat.mtimeMs < TMP_ORPHAN_MIN_AGE_MS) return false;
  return !isProcessAlive(pid);
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
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (entry.endsWith('.tmp') && stat.isFile() && shouldRemoveTmp(entry, stat)) {
        try { fs.unlinkSync(full); removed++; } catch { /* already gone */ }
      }
      // Recurse into subdirectories
      if (stat.isDirectory()) {
        removed += cleanOrphanFiles(full);
      }
    }
  } catch { /* dir unreadable — skip */ }

  // Clean stale .lock files
  removed += cleanStaleLocks(dirPath);
  return removed;
}
