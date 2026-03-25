import { type StoreTarget } from '../core/store-resolution.js';
import type { PlanType, Priority } from '../core/schema.js';
export interface PlanOptions {
    type?: PlanType;
    priority?: Priority;
    assignee?: string;
    project?: string;
    tag?: string[];
    path?: string[];
    author?: string;
    dependsOn?: string[];
    estimate?: string | number;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runPlan(text: string, options?: PlanOptions): void;
//# sourceMappingURL=plan.d.ts.map