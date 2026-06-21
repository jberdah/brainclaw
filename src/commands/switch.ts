import path from 'node:path';
import { loadActiveProject, saveActiveProject, clearActiveProject } from '../core/active-project.js';
import { buildOperationalIdentity, loadCurrentSession, loadSessionById, resolveCurrentSessionId, saveCurrentSession } from '../core/identity.js';
import { memoryExists } from '../core/io.js';
import { resolveProjectRef } from '../core/store-resolution.js';
import { resolveCrossProjectLinks, resolveProjectCwd } from '../core/cross-project.js';
import { scanNestedBrainclawProjects } from '../core/workspace-projects.js';
import { loadConfig } from '../core/config.js';

export interface SwitchOptions {
  list?: boolean;
  clear?: boolean;
  /**
   * Force session-scoped switch. This is now the DEFAULT for the CLI (F3): a
   * switch never touches the shared global pointer unless `global` is set.
   * Retained for back-compat / explicitness.
   */
  session?: boolean;
  /**
   * Opt-in: write/clear the SHARED workspace default (active-project.json) that
   * every agent on the host sees. This is the ONLY CLI path that mutates the
   * global pointer; it bypasses the session. Intended for a human/operator
   * setting a workspace-wide default, not for per-agent work.
   */
  global?: boolean;
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
    listProjects(wsRoot, cwd, options.json ?? false);
    return;
  }

  // --clear: remove active project. Session-scoped by default (F3) — clearing
  // the SHARED global pointer is an opt-in (--global) so one agent's clear no
  // longer wipes every other agent's resolution.
  if (options.clear) {
    let scope: 'session' | 'global';
    if (options.global) {
      clearActiveProject(wsRoot);
      scope = 'global';
    } else {
      const session = loadCurrentSession(cwd);
      if (session?.active_project) {
        const { active_project: _removed, ...rest } = session;
        saveCurrentSession(rest, cwd);
      }
      scope = 'session';
    }
    if (options.json) {
      console.log(JSON.stringify({ cleared: true, scope }));
    } else {
      const hint = scope === 'session' ? ' (session-scoped)' : ' (global)';
      console.log(`✔ Active project cleared${hint}. Commands will use current directory.`);
    }
    return;
  }

  // No argument: show current active project
  if (!projectRef) {
    showCurrent(wsRoot, cwd, options.json ?? false);
    return;
  }

  // Switch to project
  const now = new Date().toISOString();
  let scope: 'session' | 'global';
  let switchedPath: string;
  let switchedName: string | undefined;

  if (options.global) {
    // Opt-in, audited: set the SHARED workspace default for every agent on the
    // host. Bypasses the session entirely (an operator setting a default).
    // Resolve store-chain children AND cross-project links (mirror switchProject)
    // so `switch <linked> --global` matches what --list shows and what the
    // session path can target (Codex final review F3-F5 finding).
    let resolved = resolveProjectRef(projectRef, cwd);
    if (!resolved) {
      try {
        const linkResolved = resolveProjectCwd(projectRef, cwd);
        if (linkResolved !== cwd) resolved = linkResolved;
      } catch { /* falls through to the error below */ }
    }
    if (!resolved) {
      console.error(`Error: cannot resolve project "${projectRef}".`);
      console.error('Use `brainclaw switch --list` to see available projects.');
      process.exit(1);
    }
    let projectName: string | undefined;
    try {
      projectName = loadConfig(resolved).project_name;
    } catch { /* name is optional */ }
    saveActiveProject(wsRoot, {
      path: resolved,
      name: projectName,
      switched_at: now,
      switched_by: process.env.BRAINCLAW_AGENT_NAME ?? process.env.USER ?? 'unknown',
    });
    scope = 'global';
    switchedPath = resolved;
    switchedName = projectName;
  } else {
    // F3 default: session-scoped + isolated. Delegate to switchProject — the
    // safe model that auto-creates the session, honours an explicit
    // BRAINCLAW_SESSION_ID (resolveCurrentSessionId returns it WITHOUT
    // persisting, so the session file must be created), resolves cross-project
    // links, and never touches the shared global pointer.
    try {
      const explicitSessionId = resolveCurrentSessionId(process.env, cwd) || undefined;
      const result = switchProject(projectRef, { cwd, sessionOnly: true, sessionId: explicitSessionId });
      scope = 'session';
      switchedPath = result.path;
      switchedName = result.name;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      console.error('Use `brainclaw switch --list` to see available projects.');
      process.exit(1);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ switched: true, path: switchedPath, name: switchedName, scope }));
  } else {
    const rel = path.relative(wsRoot, switchedPath) || '.';
    const scopeHint = scope === 'session' ? ' (session-scoped)' : ' (global — all agents)';
    console.log(`✔ Switched to ${switchedName ? `"${switchedName}" (${rel})` : rel}${scopeHint}`);
  }
}

function showCurrent(wsRoot: string, cwd: string, json: boolean): void {
  // F5: prefer the session's own active project so an agent sees its own
  // session-scoped switch, not just the shared global pointer.
  const sessionActive = loadCurrentSession(cwd)?.active_project;
  const globalActive = loadActiveProject(wsRoot);
  const active = sessionActive ?? globalActive;
  const source: 'session' | 'global' | 'none' = sessionActive ? 'session' : globalActive ? 'global' : 'none';

  if (!active) {
    if (json) {
      console.log(JSON.stringify({ active: false, scope: 'none' }));
    } else {
      console.log('No active project. Commands use current directory.');
      console.log('Use `brainclaw switch <project>` to set one.');
    }
    return;
  }

  const rel = path.relative(wsRoot, active.path) || '.';
  const switchedBy = 'switched_by' in active ? active.switched_by : undefined;
  if (json) {
    console.log(JSON.stringify({ active: true, ...active, relative_path: rel, scope: source }));
  } else {
    const scopeHint = source === 'session' ? ' (session-scoped)' : ' (global — all agents)';
    console.log(`Active project: ${active.name ? `"${active.name}" (${rel})` : rel}${scopeHint}`);
    console.log(`  switched at: ${active.switched_at}`);
    if (switchedBy) console.log(`  switched by: ${switchedBy}`);
  }
}

function listProjects(wsRoot: string, cwd: string, json: boolean): void {
  // F5: delegate to the session-aware lister so the active marker reflects the
  // agent's own session active project, falling back to the global pointer.
  const result = listAvailableProjectsForSession(cwd);

  if (json) {
    console.log(JSON.stringify({
      workspace: result.workspace_root,
      active_source: result.active_source,
      projects: result.projects,
    }, null, 2));
    return;
  }

  if (result.projects.length === 0) {
    console.log('No brainclaw projects found in this workspace.');
    return;
  }

  console.log(`Projects in ${result.workspace_root}:\n`);
  for (const p of result.projects) {
    const marker = p.active ? '→ ' : '  ';
    const name = p.name ? `${p.name} (${p.relative_path})` : p.relative_path;
    console.log(`${marker}${name}`);
  }

  if (result.active_source === 'none') {
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
