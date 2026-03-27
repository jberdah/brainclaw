import { mutateState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { nowISO } from '../core/ids.js';
export function runCompleteStep(planId, stepId) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    try {
        const result = mutateState((state) => {
            const plan = state.plan_items.find((p) => p.id === planId || p.short_label === planId);
            if (!plan) {
                throw new Error(`Plan '${planId}' not found.`);
            }
            const step = (plan.steps ?? []).find((s) => s.id === stepId);
            if (!step) {
                throw new Error(`Step '${stepId}' not found in plan '${planId}'.`);
            }
            step.status = 'done';
            step.updated_at = nowISO();
            plan.updated_at = nowISO();
            const total = plan.steps.length;
            const done = plan.steps.filter((s) => s.status === 'done').length;
            return {
                stepId: step.id,
                stepText: step.text,
                planId: plan.id,
                total,
                done,
            };
        });
        console.log(`✔ Step completed: [${result.stepId}] ${result.stepText}`);
        console.log(`  Plan [${result.planId}] progress: ${result.done}/${result.total} steps done`);
        if (result.done === result.total) {
            console.log(`  All steps done — consider: brainclaw update-plan ${result.planId} --status done`);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}
//# sourceMappingURL=complete-step.js.map