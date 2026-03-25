import { type StoreTarget } from '../core/store-resolution.js';
import type { DecisionOutcome } from '../core/schema.js';
export interface DecisionOptions {
    tag?: string[];
    path?: string[];
    outcome?: DecisionOutcome;
    author?: string;
    plan?: string;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runDecision(text: string, options?: DecisionOptions): void;
//# sourceMappingURL=decision.d.ts.map