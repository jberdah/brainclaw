import fs from 'node:fs';
import { JsonStore } from './json-store.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { AiSurfaceTaskRequestSchema, type AiSurfaceTaskRequest } from './schema.js';

function surfaceTasksDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('surface-tasks', cwd ?? process.cwd(), mode);
}

function surfaceTaskStore(cwd?: string): JsonStore<AiSurfaceTaskRequest> {
  return new JsonStore<AiSurfaceTaskRequest>({
    dirPath: surfaceTasksDir(cwd, 'read'),
    documentType: 'ai_surface_task',
    getId: (task) => task.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

export function ensureAiSurfaceTasksDir(cwd?: string): void {
  const dir = surfaceTasksDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function saveAiSurfaceTask(task: AiSurfaceTaskRequest, cwd?: string): void {
  mutate({ cwd }, () => {
    ensureAiSurfaceTasksDir(cwd);
    const writeStore = new JsonStore<AiSurfaceTaskRequest>({
      dirPath: surfaceTasksDir(cwd, 'write'),
      documentType: 'ai_surface_task',
      getId: (entry) => entry.id,
      sort: (a, b) => a.created_at.localeCompare(b.created_at),
    });
    writeStore.save(AiSurfaceTaskRequestSchema.parse(task));
  });
}

export function loadAiSurfaceTask(id: string, cwd?: string): AiSurfaceTaskRequest {
  return surfaceTaskStore(cwd).load(id);
}

export function listAiSurfaceTasks(cwd?: string): AiSurfaceTaskRequest[] {
  return surfaceTaskStore(cwd).list();
}
