import { memoryExists } from '../core/io.js';
import { listAiSurfaceTasks } from '../core/ai-surface-tasks.js';
export function runListSurfaceTasks(options = {}) {
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    let tasks = listAiSurfaceTasks(options.cwd);
    if (!options.all) {
        tasks = tasks.filter((task) => task.status === 'queued' || task.status === 'in_progress');
    }
    if (options.status) {
        tasks = tasks.filter((task) => task.status === options.status);
    }
    if (options.target) {
        const target = options.target.toLowerCase();
        tasks = tasks.filter((task) => task.target_surface.toLowerCase() === target);
    }
    if (options.json) {
        console.log(JSON.stringify(tasks, null, 2));
        return;
    }
    if (tasks.length === 0) {
        console.log('No surface tasks.');
        return;
    }
    console.log(`${tasks.length} surface task(s):`);
    console.log('');
    for (const task of tasks) {
        console.log(`  [${task.id}] ${task.title} (${task.status}, target ${task.target_surface}, kind ${task.kind})`);
        if (task.requested_outputs.length > 0) {
            console.log(`    outputs: ${task.requested_outputs.join(', ')}`);
        }
        if (task.result_note) {
            console.log(`    result: ${task.result_note}`);
        }
    }
}
//# sourceMappingURL=list-surface-tasks.js.map