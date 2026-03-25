import { readAuditLog } from '../core/audit.js';
import { memoryExists } from '../core/io.js';
export function runHistory(id) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const entries = readAuditLog({ itemId: id });
    if (entries.length === 0) {
        console.log(`No history found for item '${id}'.`);
        return;
    }
    console.log(`History for ${id} — ${entries.length} event(s):`);
    console.log('');
    for (const entry of entries) {
        const parts = [`  ${entry.timestamp}`, `[${entry.actor}]`, entry.action];
        if (entry.reason)
            parts.push(`| ${entry.reason}`);
        console.log(parts.join(' '));
    }
}
//# sourceMappingURL=history.js.map