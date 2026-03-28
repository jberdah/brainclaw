import { requireInitialized } from '../core/guards.js';
import { updatePlan } from '../core/operations/plan.js';
export function runUpdatePlan(id, options = {}) {
    const cwd = options.cwd ?? process.cwd();
    requireInitialized(cwd);
    try {
        const result = updatePlan({
            id,
            status: options.status,
            assignee: options.assignee,
            priority: options.priority,
            actualEffort: options.actualEffort,
        }, cwd);
        console.log(`✔ Plan item updated: [${result.id}] ${result.text}`);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}
//# sourceMappingURL=update-plan.js.map