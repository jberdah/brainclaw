import type { AiSurfaceTaskStatus } from '../core/schema.js';
export interface UpdateSurfaceTaskOptions {
    status?: AiSurfaceTaskStatus;
    result?: string;
    output?: string[];
    cwd?: string;
}
export declare function runUpdateSurfaceTask(id: string, options?: UpdateSurfaceTaskOptions): void;
//# sourceMappingURL=update-surface-task.d.ts.map