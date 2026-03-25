import type { PlanStatus, Priority } from '../core/schema.js';
export interface UpdatePlanOptions {
    status?: PlanStatus;
    assignee?: string;
    project?: string;
    priority?: Priority;
    actualEffort?: string;
    cwd?: string;
}
export declare function runUpdatePlan(id: string, options?: UpdatePlanOptions): void;
//# sourceMappingURL=update-plan.d.ts.map