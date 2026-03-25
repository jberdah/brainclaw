import { type StoreTarget } from '../core/store-resolution.js';
import type { ConstraintCategory } from '../core/schema.js';
export interface ConstraintOptions {
    tag?: string[];
    path?: string[];
    category?: ConstraintCategory;
    author?: string;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runConstraint(text: string, options?: ConstraintOptions): void;
//# sourceMappingURL=constraint.d.ts.map