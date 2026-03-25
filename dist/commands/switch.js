import path from 'node:path';
import { loadActiveProject, saveActiveProject, clearActiveProject } from '../core/active-project.js';
import { loadCurrentSession, saveCurrentSession } from '../core/identity.js';
import { memoryExists } from '../core/io.js';
import { resolveProjectRef } from '../core/store-resolution.js';
import { scanNestedBrainclawProjects } from '../core/workspace-projects.js';
import { loadConfig } from '../core/config.js';
export function runSwitch(projectRef, options = {}) {
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
        }
        else {
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
    let projectName;
    try {
        const config = loadConfig(resolved);
        projectName = config.project_name;
    }
    catch {
        // name is optional
    }
    const now = new Date().toISOString();
    const session = loadCurrentSession(cwd);
    const scopedToSession = options.session ?? !!session;
    let scope;
    if (scopedToSession && session) {
        // Write to session state — only this agent sees this switch
        saveCurrentSession({
            ...session,
            active_project: { path: resolved, name: projectName, switched_at: now },
        }, cwd);
        scope = 'session';
    }
    else {
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
    }
    else {
        const rel = path.relative(wsRoot, resolved) || '.';
        const scopeHint = scope === 'session' ? ' (session-scoped)' : '';
        console.log(`✔ Switched to ${projectName ? `"${projectName}" (${rel})` : rel}${scopeHint}`);
    }
}
function showCurrent(wsRoot, json) {
    const active = loadActiveProject(wsRoot);
    if (!active) {
        if (json) {
            console.log(JSON.stringify({ active: false }));
        }
        else {
            console.log('No active project. Commands use current directory.');
            console.log('Use `brainclaw switch <project>` to set one.');
        }
        return;
    }
    const rel = path.relative(wsRoot, active.path) || '.';
    if (json) {
        console.log(JSON.stringify({ active: true, ...active, relative_path: rel }));
    }
    else {
        console.log(`Active project: ${active.name ? `"${active.name}" (${rel})` : rel}`);
        console.log(`  switched at: ${active.switched_at}`);
        if (active.switched_by)
            console.log(`  switched by: ${active.switched_by}`);
    }
}
function listProjects(wsRoot, json) {
    const active = loadActiveProject(wsRoot);
    const projects = [];
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
        }
        catch {
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
        if (childPath === wsRoot)
            continue;
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
function findOutermostWorkspaceRoot(startDir) {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    const home = process.env.HOME || process.env.USERPROFILE || root;
    let outermost;
    while (dir !== root && dir !== home) {
        if (memoryExists(dir)) {
            outermost = dir; // keep going — we want the outermost
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return outermost;
}
//# sourceMappingURL=switch.js.map