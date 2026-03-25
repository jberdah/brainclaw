import { type SurfaceTaskOptions } from './surface-task.js';
import { type ListSurfaceTasksOptions } from './list-surface-tasks.js';
import { type UpdateSurfaceTaskOptions } from './update-surface-task.js';
interface SurfaceTaskResourceOptions extends SurfaceTaskOptions, ListSurfaceTasksOptions, UpdateSurfaceTaskOptions {
}
export declare function runSurfaceTaskResource(subcommand: string, args: string[], options?: SurfaceTaskResourceOptions): void;
export {};
//# sourceMappingURL=surface-task-resource.d.ts.map