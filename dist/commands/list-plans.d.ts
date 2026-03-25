import type { PlanStatus, PlanType } from '../core/schema.js';
export interface ListPlansOptions {
    json?: boolean;
    status?: PlanStatus;
    type?: PlanType;
    assignee?: string;
    project?: string;
    all?: boolean;
    cwd?: string;
}
export declare function runListPlans(options?: ListPlansOptions): void;
//# sourceMappingURL=list-plans.d.ts.map