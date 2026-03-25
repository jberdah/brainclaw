import path from 'node:path';
import { loadConfig } from './config.js';
import { loadState } from './state.js';
import { saveRuntimeNote } from './runtime.js';
import { memoryExists } from './io.js';
/**
 * Resolves cross_project_links from config, converting relative paths to absolute.
 */
export function resolveCrossProjectLinks(cwd) {
    const baseCwd = cwd ?? process.cwd();
    let config;
    try {
        config = loadConfig(cwd);
    }
    catch {
        return [];
    }
    return (config.cross_project_links ?? []).map((link) => {
        const absolutePath = path.isAbsolute(link.path)
            ? link.path
            : path.resolve(baseCwd, link.path);
        const available = memoryExists(absolutePath);
        let projectName = link.name ?? path.basename(absolutePath);
        if (available) {
            try {
                const linkedConfig = loadConfig(absolutePath);
                projectName = link.name ?? linkedConfig.project_name ?? projectName;
            }
            catch { /* use basename fallback */ }
        }
        return { ...link, absolutePath, projectName, available };
    });
}
/**
 * Detects cycles in cross_project_links (A → B → A).
 * Returns the paths involved in any cycle found.
 */
export function detectCrossProjectCycles(cwd) {
    const baseCwd = path.resolve(cwd ?? process.cwd());
    const cycles = [];
    function walk(currentCwd, visited) {
        let links = [];
        try {
            links = resolveCrossProjectLinks(currentCwd);
        }
        catch {
            return;
        }
        for (const link of links) {
            const normalized = path.resolve(link.absolutePath);
            if (visited.includes(normalized)) {
                cycles.push([...visited, normalized]);
                return;
            }
            walk(normalized, [...visited, normalized]);
        }
    }
    walk(baseCwd, [baseCwd]);
    return cycles;
}
/**
 * Loads state from a linked project (read-only).
 */
export function loadCrossProjectState(absolutePath) {
    return loadState(absolutePath);
}
/**
 * Writes a runtime note into a target (publisher-linked) project's runtime dir.
 * Used by bclaw_write_note --cross-project.
 */
export function writeCrossProjectNote(targetAbsolutePath, note, sourceCwd) {
    const links = resolveCrossProjectLinks(sourceCwd);
    const link = links.find((l) => path.resolve(l.absolutePath) === path.resolve(targetAbsolutePath));
    if (!link) {
        throw new Error(`No cross_project_link configured for path: ${targetAbsolutePath}`);
    }
    if (link.role !== 'publisher') {
        throw new Error(`Cross-project link to '${link.projectName}' is role=subscriber — cannot write notes. Set role: publisher to enable push.`);
    }
    if (!link.available) {
        throw new Error(`Target project not found or not initialized: ${targetAbsolutePath}`);
    }
    saveRuntimeNote({ ...note, note_type: 'cross_project' }, targetAbsolutePath);
}
/**
 * Returns the absolute path of a cross-project link by name or path fragment.
 */
export function resolveCrossProjectTarget(nameOrPath, cwd) {
    const links = resolveCrossProjectLinks(cwd);
    const match = links.find((l) => l.projectName === nameOrPath ||
        l.path === nameOrPath ||
        l.absolutePath === nameOrPath ||
        path.basename(l.absolutePath) === nameOrPath);
    if (!match) {
        throw new Error(`No cross_project_link found matching: '${nameOrPath}'. Check your config.yaml cross_project_links.`);
    }
    return match;
}
//# sourceMappingURL=cross-project.js.map