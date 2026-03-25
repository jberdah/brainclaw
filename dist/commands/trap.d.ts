import { type StoreTarget } from '../core/store-resolution.js';
import type { Severity, MemoryVisibility, TrapStatus } from '../core/schema.js';
export interface TrapOptions {
    status?: TrapStatus;
    severity?: Severity;
    tag?: string[];
    path?: string[];
    author?: string;
    visibility?: MemoryVisibility;
    host?: string;
    ttl?: string;
    cwd?: string;
    store?: StoreTarget;
    plan?: string;
}
export declare function runTrap(text: string, options?: TrapOptions): void;
//# sourceMappingURL=trap.d.ts.map