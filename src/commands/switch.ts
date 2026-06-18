import fs from 'node:fs';
import path from 'node:path';
import { loadActiveProject, saveActiveProject, clearActiveProject } from '../core/active-project.js';
import { buildOperationalIdentity, loadCurrentSession, loadSessionById, saveCurrentSession } from '../core/identity.js';
import { MEMORY_DIR, memoryExists } from '../core/io.js';
import { resolveProjectRef, resolveWorkspaceRoot } from '../core/store-resolution.js';
import { resolveCrossProjectLinks, resolveProjectCwd } from '../core/cross-project.js';
import { scanNestedBrainclawProjects } from '../core/workspace-projects.js';
import { loadConfig } from '../core/config.js';

export interface SwitchOptions {
  list?: boolean;
  clear?: boolean;
  /** Scope switch to session only (default: true when a session is active). */
  session?: boolean;
  json?: boolean;
  cwd?: string;
}

export interface SwitchProjectOptions {
  cwd?: string;
  /** Force session-scoped switch (never write to global active-project.json). */
  sessionOnly?: boolean;
  /** Explicit MCP connection/session id. */
  sessionId?: string;
}

export interface SwitchProjectResult {
  switched: boolean;
  path: string;
  name?: string;
  scope: 'session' | 'global';
  workspace_root: string;
}

/**
 * Switch to a project programmatically.
 * When sessionOnly=true (default for MCP), ONLY writes to the session state.
 * This prevents agents from cross-contaminating each other's active project.
 */
export function switchProject(projectRef: string, options: SwitchProjectOptions = {}): SwitchProjectResult {
  const cwd = options.cwd ?? process.cwd();
  const wsRoot = findOutermostWorkspaceRoot(cwd);
  if (!wsRoot) {
    throw new Error('No brainclaw workspace found. Run `brainclaw init` first.');
  }

  // pln#515 step 4 — resolution priority:
  // 1. resolveProjectRef: workspace store-chain children (existing path)
  // 2. resolveProjectCwd: cross_project_links (added so bclaw_switch can
  //    target externally-linked projects, not just store-chain children).
  // resolveProjectCwd returns the original cwd on no-match, so we check
  // for a real change before treating it as a resolution.
  let resolved = resolveProjectRef(projectRef, cwd);
  if (!resolved) {
    try {
      const linkResolved = resolveProjectCwd(projectRef, cwd);
      if (linkResolved !== cwd) {
        resolved = linkResolved;
      }
    } catch { /* link resolution failure surfaces as the same error below */ }
  }
  if (!resolved) {
    throw new Error(`Cannot resolve project "${projectRef}". Use bclaw_switch with list=true to see available projects.`);
  }

  let projectName: string | undefined;
  try {
    const config = loadConfig(resolved);
    projectName = config.project_name;
  } catch { /* name is optional */ }

  const now = new Date().toISOString();
  const sessionOnly = options.sessionOnly ?? true;
  let session = options.sessionId ? loadSessionById(options.sessionId, cwd) : loadCurrentSession(cwd);
  if (!session && sessionOnly) {
    if (options.sessionId) {
      const identity = buildOperationalIdentity(undefined, cwd, {
        sessionId: options.sessionId,
        persistImplicitSession: false,
      });
      saveCurrentSession({
        session_id: options.sessionId,
        started_at: now,
        last_seen_at: now,
        agent: identity.agent,
        agent_id: identity.agent_id,
        host_id: identity.host_id,
        user: process.env.USER || process.env.USERNAME || undefined,
        pid: process.pid,
      }, cwd);
    } else {
      buildOperationalIdentity(undefined, cwd, { persistImplicitSession: true });
    }
    session = options.sessionId ? loadSessionById(options.sessionId, cwd) : loadCurrentSession(cwd);
  }

  if (session && sessionOnly) {
    saveCurrentSession({
      ...session,
      active_project: { path: resolved, name: projectName, switched_at: now },
    }, cwd);
    return { switched: true, path: resolved, name: projectName, scope: 'session', workspace_root: wsRoot };
  }

  if (sessionOnly) {
    throw new Error('Cannot switch project without an active agent session. Start with bclaw_work or bclaw_session_start first.');
  }

  if (session) {
    // Also write to session even when not sessionOnly
    saveCurrentSession({
      ...session,
      active_project: { path: resolved, name: projectName, switched_at: now },
    }, cwd);
  }

  saveActiveProject(wsRoot, {
    path: resolved,
    name: projectName,
    switched_at: now,
    switched_by: process.env.BRAINCLAW_AGENT_NAME ?? process.env.USER ?? 'unknown',
  });
  return { switched: true, path: resolved, name: projectName, scope: 'global', workspace_root: wsRoot };
}

export interface ListProjectsResult {
  workspace_root: string;
  active_source: 'session' | 'global' | 'none';
  projects: Array<{ name?: string; path: string; relative_path: string; active: boolean }>;
}

/**
 * List available projects in the workspace.
 */
export function listAvailableProjects(cwd?: string): ListProjectsResult {
  return listAvailableProjectsForSession(cwd);
}

export function listAvailableProjectsForSession(cwd?: string, sessionId?: string): ListProjectsResult {
  const wsRoot = findOutermostWorkspaceRoot(cwd ?? process.cwd());
  if (!wsRoot) {
    throw new Error('No brainclaw workspace found.');
  }

  const sessionActive = (sessionId ? loadSessionById(sessionId, cwd) : loadCurrentSession(cwd))?.active_project;
  const globalActive = loadActiveProject(wsRoot);
  const active = sessionActive ?? globalActive;
  const activeSource: ListProjectsResult['active_source'] = sessionActive ? 'session' : globalActive ? 'global' : 'none';
  const projects: ListProjectsResult['projects'] = [];
  const seen = new Set<string>();

  const addProject = (project: { name?: string; path: string; relative_path: string }): void => {
    const projectPath = path.resolve(project.path);
    if (seen.has(projectPath)) return;
    seen.add(projectPath);
    projects.push({
      ...project,
      path: projectPath,
      active: active?.path ? path.resolve(active.path) === projectPath : false,
    });
  };

  if (memoryExists(wsRoot)) {
    try {
      const config = loadConfig(wsRoot);
      addProject({ name: config.project_name, path: wsRoot, relative_path: '.' });
    } catch {
      addProject({ path: wsRoot, relative_path: '.' });
    }
  }

  const children = scanNestedBrainclawProjects(wsRoot, 7);
  for (const child of children) {
    const childPath = path.resolve(child.path);
    if (childPath === wsRoot) continue;
    const rel = path.relative(wsRoot, childPath) || '.';
    addProject({ name: child.project_name, path: childPath, relative_path: rel });
  }

  for (const link of resolveCrossProjectLinks(wsRoot)) {
    if (!link.available) continue;
    const linkPath = path.resolve(link.absolutePath);
    addProject({
      name: link.projectName,
      path: linkPath,
      relative_path: path.relative(wsRoot, linkPath) || '.',
    });
  }

  return { workspace_root: wsRoot, active_source: activeSource, projects };
}

export function runSwitch(projectRef: string | undefined, options: SwitchOptions = {}): void {
  // Use real cwd, not effective cwd — switch must see the full workspace
  const cwd = options.cwd ?? process.cwd();
  // Walk up from real cwd to find the outermost .brainclaw/ (workspace root)
  const wsRoot = findOutermostWorkspaceRoot(cwd);

  if (!wsRoot) {
    console.error('Error: no brainclaw workspace found. Run `brainclaw init` first.');
    process.exit(1);
  }

  // --list: show available projects
  if (options.list) {
    listProjects(wsRoot, options.json ?? false);
    return;
  }

  // --clear: remove active project
  if (options.clear) {
    const session = loadCurrentSession(cwd);
    if (session?.active_project) {
      const { active_project: _removed, ...rest } = session;
      saveCurrentSession(rest, cwd);
    }
    clearActiveProject(wsRoot);
    if (options.json) {
      console.log(JSON.stringify({ cleared: true }));
    } else {
      console.log('✔ Active project cleared. Commands will use current directory.');
    }
    return;
  }

  // No argument: show current active project
  if (!projectRef) {
    showCurrent(wsRoot, options.json ?? false);
    return;
  }

  // Switch to project
  const resolved = resolveProjectRef(projectRef, cwd);
  if (!resolved) {
    console.error(`Error: cannot resolve project "${projectRef}".`);
    console.error('Use `brainclaw switch --list` to see available projects.');
    process.exit(1);
  }

  let projectName: string | undefined;
  try {
    const config = loadConfig(resolved);
    projectName = config.project_name;
  } catch {
    // name is optional
  }

  const now = new Date().toISOString();
  const session = loadCurrentSession(cwd);
  const scopedToSession = options.session ?? !!session;
  let scope: 'session' | 'global';

  if (scopedToSession && session) {
    // Write to session state — only this agent sees this switch
    saveCurrentSession({
      ...session,
      active_project: { path: resolved, name: projectName, switched_at: now },
    }, cwd);
    scope = 'session';
  } else {
    // Fall back to global active-project.json
    saveActiveProject(wsRoot, {
      path: resolved,
      name: projectName,
      switched_at: now,
      switched_by: process.env.BRAINCLAW_AGENT_NAME ?? process.env.USER ?? 'unknown',
    });
    scope = 'global';
  }

  if (options.json) {
    console.log(JSON.stringify({ switched: true, path: resolved, name: projectName, scope }));
  } else {
    const rel = path.relative(wsRoot, resolved) || '.';
    const scopeHint = scope === 'session' ? ' (session-scoped)' : '';
    console.log(`✔ Switched to ${projectName ? `"${projectName}" (${rel})` : rel}${scopeHint}`);
  }
}

function showCurrent(wsRoot: string, json: boolean): void {
  const active = loadActiveProject(wsRoot);
  if (!active) {
    if (json) {
      console.log(JSON.stringify({ active: false }));
    } else {
      console.log('No active project. Commands use current directory.');
      console.log('Use `brainclaw switch <project>` to set one.');
    }
    return;
  }

  const rel = path.relative(wsRoot, active.path) || '.';
  if (json) {
    console.log(JSON.stringify({ active: true, ...active, relative_path: rel }));
  } else {
    console.log(`Active project: ${active.name ? `"${active.name}" (${rel})` : rel}`);
    console.log(`  switched at: ${active.switched_at}`);
    if (active.switched_by) console.log(`  switched by: ${active.switched_by}`);
  }
}

function listProjects(wsRoot: string, json: boolean): void {
  const active = loadActiveProject(wsRoot);
  const projects: Array<{
    name?: string;
    path: string;
    relative_path: string;
    active: boolean;
  }> = [];

  // Add workspace root itself
  if (memoryExists(wsRoot)) {
    try {
      const config = loadConfig(wsRoot);
      projects.push({
        name: config.project_name,
        path: wsRoot,
        relative_path: '.',
        active: active?.path === wsRoot,
      });
    } catch {
      projects.push({
        path: wsRoot,
        relative_path: '.',
        active: active?.path === wsRoot,
      });
    }
  }

  // Discover child projects (depth 7 covers deep workspace layouts like /srv/dev/repos/global/applications/*/...)
  const children = scanNestedBrainclawProjects(wsRoot, 7);
  for (const child of children) {
    const childPath = path.resolve(child.path);
    if (childPath === wsRoot) continue;
    const rel = path.relative(wsRoot, childPath) || '.';
    projects.push({
      name: child.project_name,
      path: childPath,
      relative_path: rel,
      active: active?.path === childPath,
    });
  }

  if (json) {
    console.log(JSON.stringify({ workspace: wsRoot, projects }, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log('No brainclaw projects found in this workspace.');
    return;
  }

  console.log(`Projects in ${wsRoot}:\n`);
  for (const p of projects) {
    const marker = p.active ? '→ ' : '  ';
    const name = p.name ? `${p.name} (${p.relative_path})` : p.relative_path;
    console.log(`${marker}${name}`);
  }

  if (!active) {
    console.log('\nNo active project. Use `brainclaw switch <project>` to set one.');
  }
}

/**
 * Find the outermost .brainclaw/ workspace root by walking UP from cwd.
 * Unlike resolveWorkspaceRoot which may return the closest store,
 * this returns the farthest one — the true multi-project workspace root.
 */
function findOutermostWorkspaceRoot(startDir: string): string | undefined {
  const envWorkspace = process.env.BRAINCLAW_CWD?.trim();
  if (envWorkspace && memoryExists(path.resolve(envWorkspace))) {
    return path.resolve(envWorkspace);
  }

  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  const home = process.env.HOME || process.env.USERPROFILE || root;
  let outermost: string | undefined;

  while (dir !== root && dir !== home) {
    if (memoryExists(dir)) {
      outermost = dir; // keep going — we want the outermost
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return outermost;
}
