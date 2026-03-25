import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { nowISO } from '../core/ids.js';
export function runUpdatePlan(id, options = {}) {
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const state = loadState(options.cwd);
    const plan = state.plan_items.find((item) => item.id === id);
    if (!plan) {
        console.error(`Error: Plan item '${id}' not found.`);
        process.exit(1);
    }
    const timestamp = nowISO();
    if (options.status) {
        plan.status = options.status;
        if (options.status === 'in_progress' && !plan.started_at)
            plan.started_at = timestamp;
        if (options.status === 'done' && !plan.completed_at)
            plan.completed_at = timestamp;
    }
    if (options.assignee !== undefined)
        plan.assignee = options.assignee;
    if (options.project !== undefined)
        plan.project = options.project;
    if (options.priority)
        plan.priority = options.priority;
    if (options.actualEffort)
        plan.actual_effort = options.actualEffort;
    plan.updated_at = timestamp;
    persistState(state, options.cwd);
    console.log(`✔ Plan item updated: [${plan.id}] ${plan.text}`);
}
//# sourceMappingURL=update-plan.js.map