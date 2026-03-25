import { memoryExists } from '../core/io.js';
import { pullRemoteMemory } from '../core/sync-remote.js';
export function runPull(options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const result = pullRemoteMemory({ remote: options.remote });
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.success)
            process.exit(1);
        return;
    }
    if (result.success) {
        console.log(`✔ ${result.message}`);
        if (result.details)
            console.log(result.details);
    }
    else {
        console.error(`✗ ${result.message}`);
        process.exit(1);
    }
}
//# sourceMappingURL=pull.js.map