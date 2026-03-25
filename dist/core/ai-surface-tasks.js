import fs from 'node:fs';
import { JsonStore } from './json-store.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { AiSurfaceTaskRequestSchema } from './schema.js';
function surfaceTasksDir(cwd, mode = 'read') {
    return resolveEntityDir('surface-tasks', cwd ?? process.cwd(), mode);
}
function surfaceTaskStore(cwd) {
    return new JsonStore({
        dirPath: surfaceTasksDir(cwd, 'read'),
        documentType: 'ai_surface_task',
        getId: (task) => task.id,
        sort: (a, b) => a.created_at.localeCompare(b.created_at),
    });
}
export function ensureAiSurfaceTasksDir(cwd) {
    const dir = surfaceTasksDir(cwd, 'write');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
export function saveAiSurfaceTask(task, cwd) {
    mutate({ cwd }, () => {
        ensureAiSurfaceTasksDir(cwd);
        const writeStore = new JsonStore({
            dirPath: surfaceTasksDir(cwd, 'write'),
            documentType: 'ai_surface_task',
            getId: (entry) => entry.id,
            sort: (a, b) => a.created_at.localeCompare(b.created_at),
        });
        writeStore.save(AiSurfaceTaskRequestSchema.parse(task));
    });
}
export function loadAiSurfaceTask(id, cwd) {
    return surfaceTaskStore(cwd).load(id);
}
export function listAiSurfaceTasks(cwd) {
    return surfaceTaskStore(cwd).list();
}
//# sourceMappingURL=ai-surface-tasks.js.map