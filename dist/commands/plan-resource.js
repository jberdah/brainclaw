import { runPlan } from './plan.js';
import { runListPlans } from './list-plans.js';
import { runUpdatePlan } from './update-plan.js';
import { runDeletePlan } from './delete-plan.js';
export function runPlanResource(subcommand, args, options = {}) {
    const normalized = subcommand.trim().toLowerCase();
    if (normalized === 'create') {
        const text = args.join(' ').trim();
        if (!text) {
            console.error('Error: plan create requires <text>');
            process.exit(1);
        }
        runPlan(text, options);
        return;
    }
    if (normalized === 'list' || normalized === 'ls') {
        runListPlans({
            json: options.json,
            status: options.status,
            type: options.type,
            assignee: options.assignee,
            project: options.project,
            all: options.all,
        });
        return;
    }
    if (normalized === 'update') {
        const id = args[0];
        if (!id) {
            console.error('Error: plan update requires <id>.');
            console.error('  Usage: brainclaw plan update <id> --status <status>');
            process.exit(1);
        }
        runUpdatePlan(id, {
            status: options.status,
            assignee: options.assignee,
            project: options.project,
            priority: options.priority,
            actualEffort: options.actualEffort,
            cwd: options.cwd,
        });
        return;
    }
    if (normalized === 'delete') {
        const id = args[0];
        if (!id) {
            console.error('Error: plan delete requires <id>.');
            console.error('  Usage: brainclaw plan delete <id>');
            process.exit(1);
        }
        runDeletePlan(id, { cwd: options.cwd });
        return;
    }
    // Compatibility path: `brainclaw plan "text"` still creates a plan.
    const legacyText = [subcommand, ...args].join(' ').trim();
    if (!legacyText) {
        console.error('Error: missing plan subcommand or description.');
        process.exit(1);
    }
    runPlan(legacyText, options);
}
//# sourceMappingURL=plan-resource.js.map