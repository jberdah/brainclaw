import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadActiveProject } from './active-project.js';
import { loadConfig } from './config.js';
import { loadCurrentSession } from './identity.js';
import { MEMORY_DIR } from './io.js';
import { summarizeWorkspaceProjects } from './workspace-projects.js';

export type StoreRole = 'service' | 'repo' | 'workspace' | 'user' | 'unknown';

export interface StoreRef {
  /** Absolute path to the .brainclaw/ directory */
  storePath: string;
  /** Absolute path to the directory containing .brainclaw/ */
  cwd: string;
  /** Distance from the origin cwd: 0 = closest (highest priority) */
  depth: number;
  /** Role declared in config.yaml store_type, or inferred */
  role: StoreRole;
}

export interface ResolveStoreChainOptions {
  /** Override the directory name (default: .brainclaw) */
  dirName?: string;
  /**
   * Absolute path at which to stop walking up.
   * Defaults to os.homedir(). Walk never goes above this directory.
   */
  boundary?: string;
  /**
   * If true, include stores even when their .brainclaw/ directory exists
   * but has no config.yaml (partially initialised stores).
   */
  includePartial?: boolean;
}

/**
 * Walk up the filesystem from `cwd`, collecting every `.brainclaw/` directory
 * found along the way, up to (and including) `boundary`.
 *
 * The returned array is ordered from closest to farthest (index 0 = highest
 * priority). Returns an empty array when no store is found.
 */
export function resolveStoreChain(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): StoreRef[] {
  const dirName = options.dirName ?? MEMORY_DIR;
  const boundary = options.boundary ?? process.env.BRAINCLAW_STORE_BOUNDARY ?? os.homedir();
  const includePartial = options.includePartial ?? false;

  const results: StoreRef[] = [];
  let current = path.resolve(cwd);
  const boundaryResolved = path.resolve(boundary);
  let depth = 0;

  while (true) {
    const candidate = path.join(current, dirName);
    if (fs.existsSync(candidate)) {
      const configPath = path.join(candidate, 'config.yaml');
      const hasConfig = fs.existsSync(configPath);
      if (hasConfig || includePartial) {
        results.push({
          storePath: candidate,
          cwd: current,
          depth,
          role: inferRole(candidate, configPath, hasConfig),
        });
      }
    }

    // Stop at boundary (inclusive — we already checked it above if applicable)
    if (current === boundaryResolved) break;

    const parent = path.dirname(current);
    // Stop if we've hit the filesystem root (dirname returns same path)
    if (parent === current) break;

    // Stop if we'd go above the boundary
    if (!isAtOrBelow(parent, boundaryResolved)) break;

    current = parent;
    depth++;
  }

  return results;
}

/**
 * Return the single "primary" store for a given cwd — the closest one.
 * Returns undefined when no store exists in the chain.
 */
export function resolvePrimaryStore(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): StoreRef | undefined {
  return resolveStoreChain(cwd, options)[0];
}

export type StoreTarget = 'local' | 'repo' | 'workspace' | 'user';

/**
 * Resolve the effective cwd for a write operation targeting a specific store level.
 *
 * - `local`     → the closest store (default, current behaviour)
 * - `repo`      → the first store with role='repo' in the chain; falls back to closest
 * - `workspace` → the first store with role='workspace', or the farthest store found
 * - `user`      → the first store with role='user' in the chain; falls back to os.homedir()
 *
 * Returns the original cwd unchanged when no chain exists or when target='local'.
 */
export function resolveTargetStore(
  cwd: string = process.cwd(),
  target: StoreTarget = 'local',
  options: ResolveStoreChainOptions = {},
): string {
  if (target === 'local') return cwd;
  const chain = resolveStoreChain(cwd, options);
  if (chain.length === 0) return cwd;
  if (target === 'repo') {
    const match = chain.find((s) => s.role === 'repo');
    return match?.cwd ?? chain[0]!.cwd;
  }
  if (target === 'workspace') {
    // workspace: prefer declared role, otherwise take farthest
    const match = chain.find((s) => s.role === 'workspace');
    return match?.cwd ?? chain[chain.length - 1]!.cwd;
  }
  // user: prefer declared role, otherwise os.homedir()
  const match = chain.find((s) => s.role === 'user');
  return match?.cwd ?? os.homedir();
}

export interface ResolveEffectiveCwdOptions {
  /** Explicit --cwd flag value (highest priority). */
  explicitCwd?: string;
  /** Store chain options passed through to resolveStoreChain. */
  storeChainOptions?: ResolveStoreChainOptions;
}

/**
 * Single source of truth for the effective working directory.
 *
 * Priority:
 * 1. explicitCwd (--cwd flag)
 * 2. BRAINCLAW_PROJECT env var → resolved by name/path from workspace
 * 3. Session-scoped active project (from .current-session)
 * 4. Global active-project.json in workspace root
 * 5. process.cwd()
 */
export function resolveEffectiveCwd(
  options: ResolveEffectiveCwdOptions = {},
): string {
  // 1. Explicit --cwd flag
  if (options.explicitCwd) {
    return path.resolve(options.explicitCwd);
  }

  // 2. BRAINCLAW_PROJECT env var
  const envProject = process.env.BRAINCLAW_PROJECT;
  if (envProject) {
    const resolved = resolveProjectRef(envProject, process.cwd(), options.storeChainOptions);
    if (resolved) return resolved;
  }

  // 3. Session-scoped active project (per-agent, no cross-agent interference)
  const session = loadCurrentSession(process.cwd());
  if (session?.active_project) {
    const sp = session.active_project;
    if (fs.existsSync(path.join(sp.path, MEMORY_DIR, 'config.yaml'))) {
      return sp.path;
    }
  }

  // 4. Global active-project.json from workspace root
  const wsRoot = resolveWorkspaceRoot(process.cwd(), options.storeChainOptions);
  if (wsRoot) {
    const active = loadActiveProject(wsRoot);
    if (active && fs.existsSync(path.join(active.path, MEMORY_DIR, 'config.yaml'))) {
      return active.path;
    }
  }

  // 5. Default
  return process.cwd();
}

/**
 * Find the workspace root (farthest store in the chain, or the one with
 * role=workspace). Returns undefined when no store exists.
 */
export function resolveWorkspaceRoot(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): string | undefined {
  const chain = resolveStoreChain(cwd, options);
  if (chain.length === 0) return undefined;
  const ws = chain.find((s) => s.role === 'workspace');
  return ws?.cwd ?? chain[chain.length - 1]!.cwd;
}

/**
 * Resolve a project reference (name or relative path) to an absolute path.
 * Returns undefined when the reference cannot be resolved to a valid brainclaw project.
 */
export function resolveProjectRef(
  ref: string,
  cwd: string = process.cwd(),
  storeChainOptions?: ResolveStoreChainOptions,
): string | undefined {
  // Walk UP from real cwd to find the outermost .brainclaw/ — this avoids
  // circular resolution when an active project narrows the workspace view.
  const wsRoot = findOutermostBrainclawRoot(process.cwd())
    ?? resolveWorkspaceRoot(cwd, storeChainOptions);
  if (!wsRoot) return undefined;

  // Try as absolute path
  if (path.isAbsolute(ref)) {
    return fs.existsSync(path.join(ref, MEMORY_DIR, 'config.yaml')) ? ref : undefined;
  }

  // Try as relative path from workspace root
  const asPath = path.resolve(wsRoot, ref);
  if (fs.existsSync(path.join(asPath, MEMORY_DIR, 'config.yaml'))) {
    return asPath;
  }

  // Try by project name or project ID: scan child stores
  const chain = resolveStoreChain(wsRoot, storeChainOptions);
  for (const store of chain) {
    if (store.cwd === wsRoot) continue;
    try {
      const config = loadConfig(store.cwd);
      if (config.project_name === ref || config.project_id === ref) return store.cwd;
    } catch {
      // skip unreadable configs
    }
  }

  // Try discovering child projects by scanning filesystem (deep scan for monorepos)
  try {
    const wsConfig = loadConfig(wsRoot);
    const summary = summarizeWorkspaceProjects(wsRoot, wsConfig);
    for (const project of summary.discovered_projects) {
      const projectPath = path.resolve(wsRoot, project.path);
      if (
        project.project_name === ref
        || project.project_id === ref
        || path.basename(project.path) === ref
      ) {
        if (fs.existsSync(path.join(projectPath, MEMORY_DIR, 'config.yaml'))) {
          return projectPath;
        }
      }
    }
  } catch {
    // fall through
  }

  return undefined;
}

/**
 * Walk UP from a directory and return the outermost .brainclaw/ root found.
 * This bypasses resolveEffectiveCwd / active project to find the true workspace root.
 */
export function findOutermostBrainclawRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  const home = os.homedir();
  let outermost: string | undefined;

  while (dir !== root && dir !== home) {
    if (fs.existsSync(path.join(dir, MEMORY_DIR, 'config.yaml'))) {
      outermost = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return outermost;
}

/**
 * Resolve the most specific child store that should answer a context request.
 *
 * This keeps the current cwd by default, but when `target` clearly points inside
 * a nested Brainclaw project (for example from a workspace root in folder mode),
 * it returns that child store cwd instead.
 */
export function resolveContextStoreCwd(
  cwd: string = process.cwd(),
  target?: string,
): string {
  const trimmedTarget = target?.trim();
  if (!trimmedTarget) {
    return cwd;
  }

  const primary = resolvePrimaryStore(cwd);
  if (!primary) {
    return cwd;
  }

  const absoluteTarget = resolveAbsoluteTargetPath(cwd, trimmedTarget);
  if (!absoluteTarget) {
    return cwd;
  }

  // ── Fast path: walk from target upward to cwd looking for a child store ──
  // This works regardless of project_mode or strategy configuration.
  const childStore = findClosestStoreBelow(absoluteTarget, primary.cwd);
  if (childStore) {
    return childStore;
  }

  // ── Fallback: use workspace project discovery (folder mode, registry, etc.) ──
  let config;
  try {
    config = loadConfig(primary.cwd);
  } catch {
    return cwd;
  }

  const summary = summarizeWorkspaceProjects(primary.cwd, config);
  if (summary.discovered_projects.length === 0) {
    return cwd;
  }

  const candidates = summary.discovered_projects
    .map((project) => path.resolve(primary.cwd, project.path))
    .filter((candidatePath) => candidatePath !== primary.cwd)
    .filter((candidatePath) => fs.existsSync(path.join(candidatePath, MEMORY_DIR)))
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    if (isAtOrBelow(absoluteTarget, candidate)) {
      return candidate;
    }
  }

  return cwd;
}

/**
 * Walk from `target` upward toward `ceiling` (exclusive), returning the first
 * directory that contains a `.brainclaw/config.yaml`.  Returns undefined when
 * no child store is found between target and ceiling.
 *
 * This deliberately bypasses workspace project discovery so that child stores
 * are resolved even when the parent config is set to auto/manual mode.
 */
function findClosestStoreBelow(target: string, ceiling: string): string | undefined {
  const resolvedCeiling = path.resolve(ceiling);

  // If target is a file, start from its parent directory
  let current: string;
  try {
    current = fs.statSync(target).isDirectory() ? path.resolve(target) : path.resolve(path.dirname(target));
  } catch {
    // Target doesn't exist on disk — try its parent as a directory
    current = path.resolve(path.dirname(target));
  }

  while (current !== resolvedCeiling) {
    const configPath = path.join(current, MEMORY_DIR, 'config.yaml');
    if (fs.existsSync(configPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }

  return undefined;
}

/**
 * Return true if `dir` is at or below `ancestor` in the filesystem hierarchy.
 */
function isAtOrBelow(dir: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, dir);
  // If relative path starts with '..', dir is above ancestor
  return !rel.startsWith('..');
}

function resolveAbsoluteTargetPath(cwd: string, target: string): string | undefined {
  if (path.isAbsolute(target)) {
    return path.resolve(target);
  }

  const joined = path.resolve(cwd, target);
  if (fs.existsSync(joined)) {
    return joined;
  }

  if (target.includes('/') || target.includes('\\') || target.startsWith('.')) {
    return joined;
  }

  return undefined;
}

/**
 * Infer the store role from config.yaml store_type field, or fall back to
 * heuristics (presence of .git sibling = repo, no parent store = workspace).
 */
function inferRole(
  storePath: string,
  configPath: string,
  hasConfig: boolean,
): StoreRole {
  if (hasConfig) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const match = raw.match(/store_type:\s*(\S+)/);
      if (match) {
        const val = match[1].trim();
        if (val === 'workspace' || val === 'repo' || val === 'service' || val === 'user') {
          return val as StoreRole;
        }
      }
    } catch {
      // non-fatal — fall through to heuristics
    }
  }
  // Heuristic: if a .git directory lives alongside .brainclaw/, treat as repo
  const siblingGit = path.join(path.dirname(storePath), '.git');
  if (fs.existsSync(siblingGit)) return 'repo';
  return 'unknown';
}
