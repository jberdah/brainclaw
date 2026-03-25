import type { AiSurfaceTaskStatus } from '../core/schema.js';
export interface ListSurfaceTasksOptions {
    json?: boolean;
    all?: boolean;
    status?: AiSurfaceTaskStatus;
    target?: string;
    cwd?: string;
}
export declare function runListSurfaceTasks(options?: ListSurfaceTasksOptions): void;
//# sourceMappingURL=list-surface-tasks.d.ts.map