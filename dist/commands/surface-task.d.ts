import type { AiSurfaceTaskKind } from '../core/schema.js';
export interface SurfaceTaskOptions {
    target?: string;
    instructions?: string;
    kind?: AiSurfaceTaskKind;
    output?: string[];
    tag?: string[];
    path?: string[];
    agent?: string;
    agentId?: string;
    cwd?: string;
}
export declare function runSurfaceTask(title: string, options?: SurfaceTaskOptions): void;
//# sourceMappingURL=surface-task.d.ts.map