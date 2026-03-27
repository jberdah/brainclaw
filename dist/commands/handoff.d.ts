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
    files?: string[];
    preCondition?: string[];
    postCondition?: string[];
    test?: string[];
    linkedPlan?: string[];
}
export declare function runHandoff(text: string, options: HandoffOptions): void;
export declare function extractFilesFromDiff(diff: string): string[];
//# sourceMappingURL=handoff.d.ts.map