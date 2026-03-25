import fs from 'node:fs';
import { memoryExists } from '../core/io.js';
import { runReflect } from './reflect.js';
import { RuntimeEventSchema } from '../core/schema.js';
import { listRuntimeEventsBySession } from '../core/events.js';
import { logger } from '../core/logger.js';
export function runAdapterOpenclawImport(file, options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    if (!file && !options.session) {
        console.error('Error: provide either <file> or --session <id>.');
        process.exit(1);
    }
    if (options.dryRun) {
        const events = options.session
            ? listRuntimeEventsBySession(options.session)
            : listRuntimeEventsFromFile(file);
        printDryRunSummary(events, options.session);
        return;
    }
    runReflect(undefined, {
        batch: file,
        session: options.session,
        source: options.source ?? 'openclaw',
        author: options.author,
    });
}
function listRuntimeEventsFromFile(file) {
    if (!fs.existsSync(file)) {
        throw new Error(`batch file not found: ${file}`);
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const rawEvents = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray(parsed.events)
            ? parsed.events
            : [parsed];
    const events = [];
    for (const raw of rawEvents) {
        try {
            events.push(RuntimeEventSchema.parse(raw));
        }
        catch (err) {
            logger.debug('Ignoring malformed OpenClaw event record:', err);
        }
    }
    return events;
}
function printDryRunSummary(events, session) {
    const byType = new Map();
    for (const event of events) {
        byType.set(event.event_type, (byType.get(event.event_type) ?? 0) + 1);
    }
    if (session) {
        console.log(`Dry-run for OpenClaw session '${session}':`);
    }
    else {
        console.log('Dry-run for OpenClaw file import:');
    }
    console.log(`  events: ${events.length}`);
    for (const [type, count] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`  - ${type}: ${count}`);
    }
    if (events.length > 0) {
        console.log('  sample:');
        for (const event of events.slice(0, 3)) {
            console.log(`    [${event.id}] ${event.event_type} :: ${event.text}`);
        }
    }
    console.log('  note: actual import enforces strict mode — sensitive content blocks candidate creation.');
    console.log('No candidates were created (dry-run).');
}
//# sourceMappingURL=adapter-openclaw-import.js.map