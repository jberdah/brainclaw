import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
export function runUpdateHandoff(id, options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const state = loadState();
    const handoff = state.open_handoffs.find((item) => item.id === id);
    if (!handoff) {
        console.error(`Error: Handoff '${id}' not found.`);
        process.exit(1);
    }
    if (options.status)
        handoff.status = options.status;
    if (options.to !== undefined)
        handoff.to = options.to;
    persistState(state);
    console.log(`✔ Handoff updated: [${handoff.id}] ${handoff.from} → ${handoff.to} (${handoff.status})`);
}
//# sourceMappingURL=update-handoff.js.map