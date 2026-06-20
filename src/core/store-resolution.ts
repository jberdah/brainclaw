import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadActiveProject } from './active-project.js';
import { loadConfig } from './config.js';
import { loadCurrentSession, loadSessionById } from './identity.js';
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
  /** Base cwd used to resolve session/global active project state. */
  baseCwd?: string;
  /** Explicit MCP connection/session id. Takes precedence over process env. */
  sessionId?: string;
  /** Store chain options passed through to resolveStoreChain. */
  storeChainOptions?: ResolveStoreChainOptions;
}

export type EffectiveCwdSource = 'explicit' | 'env_project' | 'session' | 'cwd_child' | 'global' | 'cwd';

export interface ResolvedEffectiveCwd {
  cwd: string;
  active_source: EffectiveCwdSource;
  resolved_project?: {
    path: string;
    name?: string;
  };
}

/**
 * Single source of truth for the effective working directory.
 *
 * Priority:
 * 1. explicitCwd (--cwd flag)
 * 2. BRAINCLAW_CWD env var → workspace anchor injected by MCP configs
 * 3. BRAINCLAW_PROJECT env var → resolved by name/path from workspace anchor
 * 4. Session-scoped active project (from .current-session under the anchor)
 * 5. cwd_child — the child project the agent is physically inside, under the anchor
 * 6. Global active-project.json in workspace root
 * 7. Workspace anchor or process.cwd()
 */
export function resolveEffectiveCwd(
  options: ResolveEffectiveCwdOptions = {},
): string {
  return resolveEffectiveCwdInfo(options).cwd;
}

/**
 * Resolve the effective cwd and explain which selector won. Use this for MCP
 * facades that must echo their project scope to avoid silent cross-project reads.
 */
export function resolveEffectiveCwdInfo(
  options: ResolveEffectiveCwdOptions = {},
): ResolvedEffectiveCwd {
  const baseCwd = path.resolve(options.baseCwd ?? process.cwd());

  // 1. Explicit --cwd flag
  if (options.explicitCwd) {
    const cwd = path.resolve(options.explicitCwd);
    return { cwd, active_source: 'explicit', resolved_project: projectInfo(cwd) };
  }

  // 2. BRAINCLAW_CWD env var — set by MCP configs to anchor resolution to the
  //    workspace regardless of the IDE's process.cwd() at launch time. It is a
  //    workspace anchor, not the final answer: session/global active project
  //    state still overrides it.
  let anchorCwd = baseCwd;
  const envCwd = process.env.BRAINCLAW_CWD?.trim();
  const hasEnvWorkspace = !!envCwd && fs.existsSync(path.join(path.resolve(envCwd), MEMORY_DIR, 'config.yaml'));
  if (hasEnvWorkspace) {
    anchorCwd = path.resolve(envCwd);
  }

  // 3. BRAINCLAW_PROJECT env var
  const envProject = process.env.BRAINCLAW_PROJECT;
  if (envProject) {
    const resolved = resolveProjectRef(envProject, anchorCwd, options.storeChainOptions);
    if (resolved) return { cwd: resolved, active_source: 'env_project', resolved_project: projectInfo(resolved) };
  }

  // 4. Session-scoped active project (per-agent, no cross-agent interference)
  const session = options.sessionId
    ? loadSessionById(options.sessionId, anchorCwd)
    : loadCurrentSession(anchorCwd);
  if (session?.active_project) {
    const sp = session.active_project;
    if (fs.existsSync(path.join(sp.path, MEMORY_DIR, 'config.yaml'))) {
      return { cwd: sp.path, active_source: 'session', resolved_project: { path: sp.path, name: sp.name } };
    }
  }

  // 5. cwd_child — when anchored and the agent is physically inside a child store
  //    STRICTLY under the anchor, resolve THAT child rather than the shared global
  //    pointer or the anchor root. This is the independence rule: physical location
  //    beats a shared/stale global (an agent working in apps/api resolves api, not the
  //    monorepo root, and is not hijacked by another agent's global switch).
  //
  //    GUARD (Codex review): only fire when baseCwd differs from the anchor AND is
  //    at/below it. `findClosestStoreBelow` walks UP to the ceiling but does NOT prove
  //    baseCwd sits below it — without the `isAtOrBelow` guard a baseCwd OUTSIDE the
  //    anchor could match an unrelated `.brainclaw` before hitting the filesystem root.
  if (baseCwd !== anchorCwd && isAtOrBelow(baseCwd, anchorCwd)) {
    const child = findClosestStoreBelow(baseCwd, anchorCwd);
    if (child && path.resolve(child) !== path.resolve(anchorCwd)) {
      return { cwd: child, active_source: 'cwd_child', resolved_project: projectInfo(child) };
    }
  }

  // 6. Global active-project.json from workspace root
  const wsRoot = hasEnvWorkspace ? anchorCwd : resolveWorkspaceRoot(anchorCwd, options.storeChainOptions);
  if (wsRoot) {
    const active = loadActiveProject(wsRoot);
    if (active && fs.existsSync(path.join(active.path, MEMORY_DIR, 'config.yaml'))) {
      return { cwd: active.path, active_source: 'global', resolved_project: { path: active.path, name: active.name } };
    }
  }

  // 7. Default
  return { cwd: anchorCwd, active_source: 'cwd', resolved_project: projectInfo(anchorCwd) };
}

function projectInfo(cwd: string): { path: string; name?: string } {
  try {
    const config = loadConfig(cwd);
    return { path: cwd, name: config.project_name };
  } catch {
    return { path: cwd };
  }
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
  const envWorkspace = process.env.BRAINCLAW_CWD?.trim();
  const workspaceAnchor = envWorkspace && fs.existsSync(path.join(path.resolve(envWorkspace), MEMORY_DIR, 'config.yaml'))
    ? path.resolve(envWorkspace)
    : undefined;

  // Walk UP from real cwd to find the outermost .brainclaw/ — this avoids
  // circular resolution when an active project narrows the workspace view.
  const wsRoot = workspaceAnchor
    ?? findOutermostBrainclawRoot(cwd)
    ?? resolveWorkspaceRoot(cwd, storeChainOptions);
  if (!wsRoot) return undefined;

  // The trust boundary for raw path refs is the provided cwd.  Callers in
  // MCP context set cwd to the workspace root, so child projects resolve
  // naturally.  Walking further up (to a user-level store at home) would
  // allow path-injection to sibling or home stores — that is the vulnerability
  // we are closing.  Name-based lookup below is unrestricted since it matches
  // by project_name / project_id, not by arbitrary path.
  const trustBoundary = path.resolve(cwd);

  // Try as absolute path — only allowed if within the cwd boundary.
  if (path.isAbsolute(ref)) {
    if (!isAtOrBelow(ref, trustBoundary)) return undefined;
    return fs.existsSync(path.join(ref, MEMORY_DIR, 'config.yaml')) ? ref : undefined;
  }

  // Try as relative path resolved from the cwd boundary.
  // Guards against ../ traversal (e.g. "../sibling-project").
  const asPath = path.resolve(trustBoundary, ref);
  if (!isAtOrBelow(asPath, trustBoundary)) return undefined;
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
  // '..' prefix → dir is above ancestor. An absolute result means a different
  // Windows drive (path.relative returns the absolute `to` path then), which is
  // also outside the boundary — without this check `D:\evil` would pass.
  return !rel.startsWith('..') && !path.isAbsolute(rel);
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
