import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
export function runListPlans(options = {}) {
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    let plans = loadState(options.cwd).plan_items;
    if (!options.all) {
        plans = plans.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
    }
    if (options.status) {
        plans = plans.filter((plan) => plan.status === options.status);
    }
    if (options.type) {
        plans = plans.filter((plan) => plan.type === options.type);
    }
    if (options.assignee) {
        const target = options.assignee.toLowerCase();
        plans = plans.filter((plan) => plan.assignee?.toLowerCase() === target);
    }
    if (options.project) {
        const project = options.project.toLowerCase();
        plans = plans.filter((plan) => plan.project?.toLowerCase() === project);
    }
    if (options.json) {
        console.log(JSON.stringify(plans, null, 2));
        return;
    }
    if (plans.length === 0) {
        console.log('No plan items found.');
        return;
    }
    console.log(`${plans.length} plan item(s):`);
    console.log('');
    for (const plan of plans) {
        const meta = [plan.type ?? 'feat', plan.status, plan.priority];
        if (plan.assignee)
            meta.push(`assignee ${plan.assignee}`);
        if (plan.project)
            meta.push(`project ${plan.project}`);
        if (plan.depends_on.length > 0)
            meta.push(`depends_on ${plan.depends_on.join(',')}`);
        const tags = plan.tags.length ? ` [${plan.tags.join(', ')}]` : '';
        console.log(`  [${plan.id}] ${plan.text} (${meta.join(' · ')})${tags}`);
    }
}
//# sourceMappingURL=list-plans.js.map