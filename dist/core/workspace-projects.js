import fs from 'node:fs';
import path from 'node:path';
import { loadGlobalRegistry, scanProject } from './global-registry.js';
const SKIP_DIRS = new Set([
    '.brainclaw',
    '.git',
    'node_modules',
    'dist',
    'dist-test',
    'build',
    'coverage',
    '.venv',
    'venv',
    '__pycache__',
    'target',
    'vendor',
    '.next',
    '.nuxt',
]);
export function summarizeWorkspaceProjects(cwd, config) {
    const configuredProjects = config.projects?.known ?? [];
    const usesFolderResolution = config.project_mode === 'multi-project' && (config.projects?.strategy ?? 'manual') === 'folder';
    const discovered = new Map();
    for (const name of configuredProjects) {
        const key = `config:${name}`;
        discovered.set(key, {
            path: name,
            relative_path: name,
            project_name: name,
            source: 'config',
        });
    }
    if (usesFolderResolution) {
        for (const project of collectRegistryProjectsUnder(cwd)) {
            const normalized = path.resolve(project.path);
            if (normalized === path.resolve(cwd)) {
                continue;
            }
            discovered.set(`path:${normalized}`, {
                path: normalized,
                relative_path: path.relative(cwd, normalized) || '.',
                project_id: project.project_id,
                project_name: project.project_name,
                source: 'registry',
            });
        }
        for (const project of scanNestedBrainclawProjects(cwd)) {
            const normalized = path.resolve(project.path);
            if (normalized === path.resolve(cwd)) {
                continue;
            }
            if (!discovered.has(`path:${normalized}`)) {
                discovered.set(`path:${normalized}`, {
                    path: normalized,
                    relative_path: path.relative(cwd, normalized) || '.',
                    project_id: project.project_id,
                    project_name: project.project_name,
                    source: 'filesystem',
                });
            }
        }
    }
    return {
        strategy: config.projects?.strategy ?? 'manual',
        configured_projects: configuredProjects,
        discovered_projects: [...discovered.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path)),
        effective_project_count: discovered.size,
        uses_folder_resolution: usesFolderResolution,
    };
}
export function scanNestedBrainclawProjects(rootDir, maxDepth = 6) {
    const resolvedRoot = path.resolve(rootDir);
    const results = new Map();
    function walk(dir, depth) {
        if (depth > maxDepth) {
            return;
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (SKIP_DIRS.has(entry.name))
                continue;
            if (entry.name.startsWith('.') && entry.name !== '.brainclaw')
                continue;
            const childDir = path.join(dir, entry.name);
            const maybeProject = scanProject(childDir);
            if (maybeProject) {
                results.set(path.resolve(maybeProject.path), maybeProject);
            }
            walk(childDir, depth + 1);
        }
    }
    walk(resolvedRoot, 1);
    return [...results.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function collectRegistryProjectsUnder(rootDir) {
    const registry = loadGlobalRegistry();
    if (!registry) {
        return [];
    }
    const resolvedRoot = path.resolve(rootDir);
    return registry.projects.filter((project) => isWithinRoot(project.path, resolvedRoot));
}
function isWithinRoot(candidatePath, rootDir) {
    const relative = path.relative(rootDir, path.resolve(candidatePath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
//# sourceMappingURL=workspace-projects.js.map