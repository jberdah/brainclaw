import { type StoreTarget } from '../core/store-resolution.js';
export interface HandoffOptions {
    from: string;
    to: string;
    tag?: string[];
    path?: string[];
    project?: string;
    plan?: string;
    author?: string;
    captureDiff?: boolean;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runHandoff(text: string, options: HandoffOptions): void;
//# sourceMappingURL=handoff.d.ts.map