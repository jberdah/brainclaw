import { type StoreTarget } from '../core/store-resolution.js';
export interface CapabilityOptions {
    tag?: string[];
    author?: string;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runCapability(subcommand: string, args: string[], options?: CapabilityOptions): void;
//# sourceMappingURL=capability.d.ts.map