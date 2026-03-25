import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { generateId, nowISO } from '../core/ids.js';
import { validateCliInput } from '../core/input-validation.js';
export function runAddStep(planId, text, options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    validateCliInput(text);
    const state = loadState();
    const plan = state.plan_items.find((p) => p.id === planId || p.short_label === planId);
    if (!plan) {
        console.error(`Error: Plan '${planId}' not found.`);
        process.exit(1);
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
    persistState(state);
    const total = plan.steps.length;
    const done = plan.steps.filter((s) => s.status === 'done').length;
    console.log(`✔ Step added: [${step.id}] ${text}`);
    console.log(`  Plan [${plan.id}] progress: ${done}/${total} steps done`);
}
//# sourceMappingURL=add-step.js.map