import { memoryExists } from '../core/io.js';
import { loadAiSurfaceTask, saveAiSurfaceTask } from '../core/ai-surface-tasks.js';
import { nowISO } from '../core/ids.js';
export function runUpdateSurfaceTask(id, options = {}) {
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const task = loadAiSurfaceTask(id, options.cwd);
    const timestamp = nowISO();
    if (options.status) {
        task.status = options.status;
        if (options.status === 'in_progress' && !task.claimed_at) {
            task.claimed_at = timestamp;
        }
        if ((options.status === 'completed' || options.status === 'failed' || options.status === 'cancelled') && !task.completed_at) {
            task.completed_at = timestamp;
        }
    }
    if (options.result !== undefined) {
        task.result_note = options.result;
    }
    if (options.output && options.output.length > 0) {
        task.requested_outputs = options.output;
    }
    task.updated_at = timestamp;
    saveAiSurfaceTask(task, options.cwd);
    console.log(`✔ Surface task updated: [${task.id}] ${task.title}`);
}
//# sourceMappingURL=update-surface-task.js.map