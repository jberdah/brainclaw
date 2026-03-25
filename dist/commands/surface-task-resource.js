import { runSurfaceTask } from './surface-task.js';
import { runListSurfaceTasks } from './list-surface-tasks.js';
import { runUpdateSurfaceTask } from './update-surface-task.js';
export function runSurfaceTaskResource(subcommand, args, options = {}) {
    const normalized = subcommand.trim().toLowerCase();
    if (normalized === 'create') {
        const title = args.join(' ').trim();
        if (!title) {
            console.error('Error: surface-task create requires <title>.');
            process.exit(1);
        }
        runSurfaceTask(title, options);
        return;
    }
    if (normalized === 'list' || normalized === 'ls') {
        runListSurfaceTasks(options);
        return;
    }
    if (normalized === 'update') {
        const id = args[0];
        if (!id) {
            console.error('Error: surface-task update requires <id>.');
            process.exit(1);
        }
        runUpdateSurfaceTask(id, options);
        return;
    }
    const legacyTitle = [subcommand, ...args].join(' ').trim();
    if (!legacyTitle) {
        console.error('Error: missing surface-task subcommand or title.');
        process.exit(1);
    }
    runSurfaceTask(legacyTitle, options);
}
//# sourceMappingURL=surface-task-resource.js.map