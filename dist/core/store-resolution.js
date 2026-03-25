import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadActiveProject } from './active-project.js';
import { loadConfig } from './config.js';
import { MEMORY_DIR } from './io.js';
import { summarizeWorkspaceProjects } from './workspace-projects.js';
/**
 * Walk up the filesystem from `cwd`, collecting every `.brainclaw/` directory
 * found along the way, up to (and including) `boundary`.
 *
 * The returned array is ordered from closest to farthest (index 0 = highest
 * priority). Returns an empty array when no store is found.
 */
export function resolveStoreChain(cwd = process.cwd(), options = {}) {
    const dirName = options.dirName ?? MEMORY_DIR;
    const boundary = options.boundary ?? process.env.BRAINCLAW_STORE_BOUNDARY ?? os.homedir();
    const includePartial = options.includePartial ?? false;
    const results = [];
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
        if (current === boundaryResolved)
            break;
        const parent = path.dirname(current);
        // Stop if we've hit the filesystem root (dirname returns same path)
        if (parent === current)
            break;
        // Stop if we'd go above the boundary
        if (!isAtOrBelow(parent, boundaryResolved))
            break;
        current = parent;
        depth++;
    }
    return results;
}
/**
 * Return the single "primary" store for a given cwd — the closest one.
 * Returns undefined when no store exists in the chain.
 */
export function resolvePrimaryStore(cwd = process.cwd(), options = {}) {
    return resolveStoreChain(cwd, options)[0];
}
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
export function resolveTargetStore(cwd = process.cwd(), target = 'local', options = {}) {
    if (target === 'local')
        return cwd;
    const chain = resolveStoreChain(cwd, options);
    if (chain.length === 0)
        return cwd;
    if (target === 'repo') {
        const match = chain.find((s) => s.role === 'repo');
        return match?.cwd ?? chain[0].cwd;
    }
    if (target === 'workspace') {
        // workspace: prefer declared role, otherwise take farthest
        const match = chain.find((s) => s.role === 'workspace');
        return match?.cwd ?? chain[chain.length - 1].cwd;
    }
    // user: prefer declared role, otherwise os.homedir()
    const match = chain.find((s) => s.role === 'user');
    return match?.cwd ?? os.homedir();
}
/**
 * Single source of truth for the effective working directory.
 *
 * Priority:
 * 1. explicitCwd (--cwd flag)
 * 2. BRAINCLAW_PROJECT env var → resolved by name/path from workspace
 * 3. active-project.json in workspace root
 * 4. process.cwd()
 */
export function resolveEffectiveCwd(options = {}) {
    // 1. Explicit --cwd flag
    if (options.explicitCwd) {
        return path.resolve(options.explicitCwd);
    }
    // 2. BRAINCLAW_PROJECT env var
    const envProject = process.env.BRAINCLAW_PROJECT;
    if (envProject) {
        const resolved = resolveProjectRef(envProject, process.cwd(), options.storeChainOptions);
        if (resolved)
            return resolved;
    }
    // 3. active-project.json from workspace root
    const wsRoot = resolveWorkspaceRoot(process.cwd(), options.storeChainOptions);
    if (wsRoot) {
        const active = loadActiveProject(wsRoot);
        if (active && fs.existsSync(path.join(active.path, MEMORY_DIR, 'config.yaml'))) {
            return active.path;
        }
    }
    // 4. Default
    return process.cwd();
}
/**
 * Find the workspace root (farthest store in the chain, or the one with
 * role=workspace). Returns undefined when no store exists.
 */
export function resolveWorkspaceRoot(cwd = process.cwd(), options = {}) {
    const chain = resolveStoreChain(cwd, options);
    if (chain.length === 0)
        return undefined;
    const ws = chain.find((s) => s.role === 'workspace');
    return ws?.cwd ?? chain[chain.length - 1].cwd;
}
/**
 * Resolve a project reference (name or relative path) to an absolute path.
 * Returns undefined when the reference cannot be resolved to a valid brainclaw project.
 */
export function resolveProjectRef(ref, cwd = process.cwd(), storeChainOptions) {
    const wsRoot = resolveWorkspaceRoot(cwd, storeChainOptions);
    if (!wsRoot)
        return undefined;
    // Try as absolute path
    if (path.isAbsolute(ref)) {
        return fs.existsSync(path.join(ref, MEMORY_DIR, 'config.yaml')) ? ref : undefined;
    }
    // Try as relative path from workspace root
    const asPath = path.resolve(wsRoot, ref);
    if (fs.existsSync(path.join(asPath, MEMORY_DIR, 'config.yaml'))) {
        return asPath;
    }
    // Try by project name: scan child stores for matching project_name
    const chain = resolveStoreChain(wsRoot, storeChainOptions);
    for (const store of chain) {
        if (store.cwd === wsRoot)
            continue; // skip workspace itself
        try {
            const config = loadConfig(store.cwd);
            if (config.project_name === ref)
                return store.cwd;
        }
        catch {
            // skip unreadable configs
        }
    }
    // Try discovering child projects by scanning filesystem
    try {
        const wsConfig = loadConfig(wsRoot);
        const summary = summarizeWorkspaceProjects(wsRoot, wsConfig);
        for (const project of summary.discovered_projects) {
            const projectPath = path.resolve(wsRoot, project.path);
            if (project.project_name === ref) {
                if (fs.existsSync(path.join(projectPath, MEMORY_DIR, 'config.yaml'))) {
                    return projectPath;
                }
            }
        }
    }
    catch {
        // fall through
    }
    return undefined;
}
/**
 * Resolve the most specific child store that should answer a context request.
 *
 * This keeps the current cwd by default, but when `target` clearly points inside
 * a nested Brainclaw project (for example from a workspace root in folder mode),
 * it returns that child store cwd instead.
 */
export function resolveContextStoreCwd(cwd = process.cwd(), target) {
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
    }
    catch {
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
function findClosestStoreBelow(target, ceiling) {
    const resolvedCeiling = path.resolve(ceiling);
    // If target is a file, start from its parent directory
    let current;
    try {
        current = fs.statSync(target).isDirectory() ? path.resolve(target) : path.resolve(path.dirname(target));
    }
    catch {
        // Target doesn't exist on disk — try its parent as a directory
        current = path.resolve(path.dirname(target));
    }
    while (current !== resolvedCeiling) {
        const configPath = path.join(current, MEMORY_DIR, 'config.yaml');
        if (fs.existsSync(configPath)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current)
            break; // filesystem root
        current = parent;
    }
    return undefined;
}
/**
 * Return true if `dir` is at or below `ancestor` in the filesystem hierarchy.
 */
function isAtOrBelow(dir, ancestor) {
    const rel = path.relative(ancestor, dir);
    // If relative path starts with '..', dir is above ancestor
    return !rel.startsWith('..');
}
function resolveAbsoluteTargetPath(cwd, target) {
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
function inferRole(storePath, configPath, hasConfig) {
    if (hasConfig) {
        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const match = raw.match(/store_type:\s*(\S+)/);
            if (match) {
                const val = match[1].trim();
                if (val === 'workspace' || val === 'repo' || val === 'service' || val === 'user') {
                    return val;
                }
            }
        }
        catch {
            // non-fatal — fall through to heuristics
        }
    }
    // Heuristic: if a .git directory lives alongside .brainclaw/, treat as repo
    const siblingGit = path.join(path.dirname(storePath), '.git');
    if (fs.existsSync(siblingGit))
        return 'repo';
    return 'unknown';
}
//# sourceMappingURL=store-resolution.js.map