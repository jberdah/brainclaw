import type { MemoryVisibility } from '../core/schema.js';
export interface RuntimeStatusOptions {
    agent?: string;
    plan?: string;
    json?: boolean;
    visibility?: MemoryVisibility | 'all';
    host?: string;
    allHosts?: boolean;
    cwd?: string;
}
export declare function runRuntimeStatus(options?: RuntimeStatusOptions): void;
//# sourceMappingURL=runtime-status.d.ts.map