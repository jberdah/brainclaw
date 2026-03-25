import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from './io.js';
const ACTIVE_PROJECT_FILE = 'active-project.json';
/**
 * Load the active project for a workspace.
 * Returns undefined when no active project is set or the file is unreadable.
 */
export function loadActiveProject(workspaceRoot) {
    const filePath = path.join(workspaceRoot, MEMORY_DIR, ACTIVE_PROJECT_FILE);
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (typeof raw.path !== 'string' || !raw.path) {
            return undefined;
        }
        return {
            path: raw.path,
            name: typeof raw.name === 'string' ? raw.name : undefined,
            switched_at: typeof raw.switched_at === 'string' ? raw.switched_at : new Date().toISOString(),
            switched_by: typeof raw.switched_by === 'string' ? raw.switched_by : undefined,
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Persist the active project for a workspace.
 */
export function saveActiveProject(workspaceRoot, project) {
    const dir = path.join(workspaceRoot, MEMORY_DIR);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, ACTIVE_PROJECT_FILE);
    fs.writeFileSync(filePath, JSON.stringify(project, null, 2) + '\n', 'utf-8');
}
/**
 * Clear the active project (revert to process.cwd() default).
 */
export function clearActiveProject(workspaceRoot) {
    const filePath = path.join(workspaceRoot, MEMORY_DIR, ACTIVE_PROJECT_FILE);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}
//# sourceMappingURL=active-project.js.map