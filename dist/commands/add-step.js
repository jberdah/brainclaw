import { mutateState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { generateId, nowISO } from '../core/ids.js';
import { validateCliInput } from '../core/input-validation.js';
export function runAddStep(planId, text, options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    validateCliInput(text);
    try {
        const result = mutateState((state) => {
            const plan = state.plan_items.find((p) => p.id === planId || p.short_label === planId);
            if (!plan) {
                throw new Error(`Plan '${planId}' not found.`);
            }
            const step = {
                id: generateId('plan_steps'),
                text,
                status: 'todo',
                assignee: options.assignee,
                created_at: nowISO(),
                updated_at: nowISO(),
            };
            plan.steps = [...(plan.steps ?? []), step];
            plan.updated_at = nowISO();
            return {
                stepId: step.id,
                planId: plan.id,
                total: plan.steps.length,
                done: plan.steps.filter((s) => s.status === 'done').length,
            };
        });
        console.log(`✔ Step added: [${result.stepId}] ${text}`);
        console.log(`  Plan [${result.planId}] progress: ${result.done}/${result.total} steps done`);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}
//# sourceMappingURL=add-step.js.map