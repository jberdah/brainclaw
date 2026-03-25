import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MEMORY_DIR } from './io.js';
const MULTI_PROJECT_MARKERS = [
    'pnpm-workspace.yaml',
    'turbo.json',
    'nx.json',
    'lerna.json',
    'rush.json',
];
const MULTI_PROJECT_DIRS = ['apps', 'packages', 'services'];
export function analyzeRepository(cwd) {
    const reasons = [];
    // ── Signal 1: Existing brainclaw config already declares multi-project ──
    const configPath = path.join(cwd, MEMORY_DIR, 'config.yaml');
    if (fs.existsSync(configPath)) {
        try {
            const raw = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
            if (raw) {
                const mode = raw.project_mode;
                const projects = raw.projects;
                const strategy = projects?.strategy ?? 'manual';
                const knownCount = Array.isArray(projects?.known) ? projects.known.length : 0;
                if (mode === 'multi-project' || strategy === 'folder' || knownCount > 0) {
                    reasons.push(`Existing brainclaw config: project_mode=${mode ?? 'auto'}, strategy=${strategy}` +
                        (knownCount > 0 ? `, ${knownCount} known project(s)` : ''));
                }
            }
        }
        catch {
            // Config unreadable — fall through to heuristic detection.
        }
    }
    // ── Signal 2: Child brainclaw stores (subdirectories with .brainclaw/) ──
    const scan = scanChildStoresShallow(cwd);
    if (scan.length > 0) {
        reasons.push(`Found ${scan.length} child brainclaw store(s): ${scan.join(', ')}`);
    }
    // ── Signal 3: Classic monorepo / workspace markers ──
    for (const marker of MULTI_PROJECT_MARKERS) {
        if (fs.existsSync(path.join(cwd, marker))) {
            reasons.push(`Found workspace marker: ${marker}`);
        }
    }
    const matchedDirs = MULTI_PROJECT_DIRS.filter((dirName) => {
        const dirPath = path.join(cwd, dirName);
        return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    });
    if (matchedDirs.length > 0) {
        reasons.push(`Found top-level project folders: ${matchedDirs.join(', ')}`);
    }
    // ── Signal 4: Multiple AGENTS.md files in the tree ──
    const agentsFiles = findNestedAgentsFiles(cwd, 8);
    if (agentsFiles.length > 1) {
        reasons.push(`Found ${agentsFiles.length} AGENTS.md files: ${agentsFiles.slice(0, 5).join(', ')}${agentsFiles.length > 5 ? ` (+${agentsFiles.length - 5} more)` : ''}`);
    }
    // ── Signal 5: Multiple Dockerfiles or docker-compose files (service-oriented workspace) ──
    const dockerComposeFiles = findFilesShallow(cwd, ['docker-compose.yml', 'docker-compose.yaml'], 6);
    if (dockerComposeFiles.length > 1) {
        reasons.push(`Found ${dockerComposeFiles.length} docker-compose files`);
    }
    const packageJsonPath = path.join(cwd, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            if (packageJson.workspaces) {
                reasons.push('Found workspace configuration in package.json');
            }
        }
        catch {
            // Ignore package.json parse errors during advisory analysis.
        }
    }
    if (reasons.length > 0) {
        return {
            recommendedMode: 'multi-project',
            reasons,
        };
    }
    return {
        recommendedMode: 'single-project',
        reasons: ['No monorepo or multi-project markers detected'],
    };
}
/**
 * Quick depth-1 scan for subdirectories that contain a .brainclaw/ store.
 * Returns relative paths of child stores found.
 */
function scanChildStoresShallow(cwd) {
    const childStores = [];
    let entries;
    try {
        entries = fs.readdirSync(cwd, { withFileTypes: true });
    }
    catch {
        return childStores;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (SKIP_DIRS.has(entry.name))
            continue;
        if (entry.name.startsWith('.'))
            continue;
        const childBrainclaw = path.join(cwd, entry.name, MEMORY_DIR);
        if (fs.existsSync(childBrainclaw)) {
            childStores.push(entry.name);
        }
    }
    return childStores;
}
/** Markers whose presence indicates a service/project boundary worth initialising. */
const SERVICE_MARKERS = [
    'package.json',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'go.mod',
    'requirements.txt',
    'pyproject.toml',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
];
/** Directories to skip when scanning for service boundaries. */
const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'dist-test',
    'build',
    '.brainclaw',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    'vendor',
    '.next',
    '.nuxt',
    'coverage',
]);
/**
 * Walk up to `maxDepth` levels below `rootDir`, find subdirectories that
 * contain service markers but no `.brainclaw/` yet.
 *
 * `rootDir` itself is excluded (the caller is presumably about to `init` it).
 */
export function scanWorkspaceBoundaries(rootDir, maxDepth = 3) {
    const suggestions = [];
    const alreadyInitialised = [];
    function walk(dir, depth) {
        if (depth > maxDepth)
            return;
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
            const childEntries = (() => {
                try {
                    return fs.readdirSync(childDir).map((n) => n);
                }
                catch {
                    return [];
                }
            })();
            const hasMemory = childEntries.includes(MEMORY_DIR);
            const foundMarkers = SERVICE_MARKERS.filter((m) => childEntries.includes(m));
            const relPath = path.relative(rootDir, childDir);
            if (hasMemory) {
                alreadyInitialised.push({ dir: childDir, relativePath: relPath });
            }
            else if (foundMarkers.length > 0) {
                suggestions.push({ dir: childDir, relativePath: relPath, markers: foundMarkers });
            }
            // Only recurse into dirs that didn't already match a boundary
            if (!hasMemory && foundMarkers.length === 0) {
                walk(childDir, depth + 1);
            }
        }
    }
    walk(rootDir, 1);
    return { suggestions, alreadyInitialised };
}
/**
 * Find AGENTS.md files up to maxDepth levels deep.
 * Returns relative paths from cwd.
 */
export function findNestedAgentsFiles(cwd, maxDepth) {
    const results = [];
    function walk(dir, depth) {
        if (depth > maxDepth || results.length > 10)
            return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isFile() && entry.name === 'AGENTS.md') {
                results.push(path.relative(cwd, path.join(dir, entry.name)));
            }
            if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                walk(path.join(dir, entry.name), depth + 1);
            }
        }
    }
    walk(cwd, 0);
    return results;
}
/**
 * Find specific filenames up to maxDepth levels deep.
 * Returns relative paths from cwd.
 */
function findFilesShallow(cwd, filenames, maxDepth) {
    const nameSet = new Set(filenames);
    const results = [];
    function walk(dir, depth) {
        if (depth > maxDepth || results.length > 10)
            return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isFile() && nameSet.has(entry.name)) {
                results.push(path.relative(cwd, path.join(dir, entry.name)));
            }
            if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                walk(path.join(dir, entry.name), depth + 1);
            }
        }
    }
    walk(cwd, 0);
    return results;
}
//# sourceMappingURL=repo-analysis.js.map