import { type AiSurfaceTaskRequest } from './schema.js';
export declare function ensureAiSurfaceTasksDir(cwd?: string): void;
export declare function saveAiSurfaceTask(task: AiSurfaceTaskRequest, cwd?: string): void;
export declare function loadAiSurfaceTask(id: string, cwd?: string): AiSurfaceTaskRequest;
export declare function listAiSurfaceTasks(cwd?: string): AiSurfaceTaskRequest[];
//# sourceMappingURL=ai-surface-tasks.d.ts.map