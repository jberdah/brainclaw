import { type PlanOptions } from './plan.js';
import { type UpdatePlanOptions } from './update-plan.js';
interface PlanResourceOptions extends PlanOptions, UpdatePlanOptions {
    json?: boolean;
    all?: boolean;
}
export declare function runPlanResource(subcommand: string, args: string[], options?: PlanResourceOptions): void;
export {};
//# sourceMappingURL=plan-resource.d.ts.map