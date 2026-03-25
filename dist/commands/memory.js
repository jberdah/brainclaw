import { loadConfig } from '../core/config.js';
import { memoryExists } from '../core/io.js';
import { loadState, persistState } from '../core/state.js';
import { scanText } from '../core/security.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore } from '../core/store-resolution.js';
import { runConstraint } from './constraint.js';
import { runDecision } from './decision.js';
import { runHandoff } from './handoff.js';
import { runTrap } from './trap.js';
export function runMemoryCommand(subcommand, args, options = {}) {
    const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
    const normalized = subcommand.trim().toLowerCase();
    if (normalized === 'create') {
        const kind = args[0];
        const text = args.slice(1).join(' ').trim();
        if (!kind || !isMemoryKind(kind)) {
            console.error('Error: memory create requires <type> where type is decision, constraint, trap, or handoff');
            process.exit(1);
        }
        if (!text) {
            console.error('Error: memory create requires <text>');
            process.exit(1);
        }
        runMemoryCreate(kind, text, { ...options, cwd });
        return;
    }
    if (normalized === 'list') {
        runMemoryList({ ...options, cwd });
        return;
    }
    if (normalized === 'update') {
        const id = args[0];
        if (!id) {
            console.error('Error: memory update requires <id>');
            process.exit(1);
        }
        runMemoryUpdate(id, { ...options, cwd });
        return;
    }
    if (normalized === 'delete') {
        const id = args[0];
        if (!id) {
            console.error('Error: memory delete requires <id>');
            process.exit(1);
        }
        runMemoryDelete(id, cwd);
        return;
    }
    console.error(`Error: unknown memory subcommand '${subcommand}'. Use create, list, update, or delete.`);
    process.exit(1);
}
function runMemoryCreate(kind, text, options) {
    switch (kind) {
        case 'decision':
            runDecision(text, options);
            return;
        case 'constraint':
            runConstraint(text, options);
            return;
        case 'trap':
            runTrap(text, {
                status: options.status,
                severity: options.severity,
                tag: options.tag,
                path: options.path,
                author: options.author,
                visibility: options.visibility,
                host: options.host,
                ttl: options.ttl,
                cwd: options.cwd,
                store: options.store,
                plan: options.plan,
            });
            return;
        case 'handoff': {
            if (!options.from || !options.to) {
                console.error('Error: memory create handoff requires --from <from> and --to <to>');
                process.exit(1);
            }
            runHandoff(text, {
                from: options.from,
                to: options.to,
                tag: options.tag,
                path: options.path,
                project: options.project,
                plan: options.plan,
                author: options.author,
                captureDiff: options.captureDiff,
                cwd: options.cwd,
                store: options.store,
            });
        }
    }
}
function runMemoryList(options) {
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const state = loadState(options.cwd);
    let items = collectMemoryItems(state);
    if (options.type) {
        items = items.filter((entry) => entry.kind === options.type);
    }
    if (options.status) {
        items = items.filter(({ kind, item }) => {
            if (kind === 'constraint' || kind === 'handoff' || kind === 'trap') {
                return 'status' in item && item.status === options.status;
            }
            return false;
        });
    }
    items.sort((a, b) => a.item.created_at.localeCompare(b.item.created_at));
    if (options.json) {
        console.log(JSON.stringify({
            total: items.length,
            items: items.map(({ kind, item }) => ({ type: kind, ...item })),
        }, null, 2));
        return;
    }
    if (items.length === 0) {
        console.log('No memory items found.');
        return;
    }
    console.log(`${items.length} memory item(s):`);
    console.log('');
    for (const { kind, item } of items) {
        const tags = item.tags.length ? ` [${item.tags.join(', ')}]` : '';
        const meta = renderMemoryMeta(kind, item);
        console.log(`  [${item.id}] <${kind}> ${item.text}${meta}${tags}`);
    }
}
function runMemoryUpdate(id, options) {
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const state = loadState(options.cwd);
    const resolved = resolveMemoryItem(state, id);
    if (!resolved) {
        console.error(`Error: Memory item '${id}' not found.`);
        process.exit(1);
    }
    if (options.text !== undefined || options.tag !== undefined) {
        validateCliInput(options.text ?? resolved.item.text, options.tag ?? resolved.item.tags);
        const config = loadConfig(options.cwd);
        const warnings = scanText(options.text ?? resolved.item.text, config);
        for (const warning of warnings) {
            console.warn(`⚠ ${warning.message}`);
            if (warning.level === 'block') {
                console.error('Blocked: strict redaction is enabled. Entry not updated.');
                process.exit(1);
            }
        }
    }
    if (options.text !== undefined) {
        resolved.item.text = options.text;
    }
    if (options.tag !== undefined) {
        resolved.item.tags = options.tag;
    }
    if (options.path !== undefined) {
        resolved.item.related_paths = options.path;
    }
    switch (resolved.kind) {
        case 'decision':
            {
                const item = resolved.item;
                if (options.outcome !== undefined) {
                    item.outcome = options.outcome;
                }
                if (options.plan !== undefined) {
                    item.plan_id = options.plan;
                }
                break;
            }
        case 'constraint':
            {
                const item = resolved.item;
                if (options.status !== undefined) {
                    item.status = options.status;
                }
                if (options.category !== undefined) {
                    item.category = options.category;
                }
                break;
            }
        case 'trap':
            {
                const item = resolved.item;
                if (options.status !== undefined) {
                    item.status = options.status;
                }
                if (options.severity !== undefined) {
                    item.severity = options.severity;
                }
                if (options.plan !== undefined) {
                    item.plan_id = options.plan;
                }
                break;
            }
        case 'handoff':
            {
                const item = resolved.item;
                if (options.status !== undefined) {
                    item.status = options.status;
                }
                if (options.from !== undefined) {
                    item.from = options.from;
                }
                if (options.to !== undefined) {
                    item.to = options.to;
                }
                if (options.project !== undefined) {
                    item.project = options.project;
                }
                if (options.plan !== undefined) {
                    item.plan_id = options.plan;
                }
                break;
            }
    }
    persistState(state, options.cwd);
    console.log(`✔ Memory item updated: [${resolved.item.id}] ${resolved.item.text}`);
}
function runMemoryDelete(id, cwd) {
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const state = loadState(cwd);
    const arrays = [
        state.recent_decisions,
        state.active_constraints,
        state.known_traps,
        state.open_handoffs,
    ];
    let deleted;
    for (const items of arrays) {
        const index = items.findIndex((item) => item.id === id || item.short_label === id);
        if (index >= 0) {
            [deleted] = items.splice(index, 1);
            break;
        }
    }
    if (!deleted) {
        console.error(`Error: Memory item '${id}' not found.`);
        process.exit(1);
    }
    persistState(state, cwd);
    console.log(`✔ Memory item deleted: [${deleted.id}] ${deleted.text}`);
}
function collectMemoryItems(state) {
    return [
        ...state.recent_decisions.map((item) => ({ kind: 'decision', item })),
        ...state.active_constraints.map((item) => ({ kind: 'constraint', item })),
        ...state.known_traps.map((item) => ({ kind: 'trap', item })),
        ...state.open_handoffs.map((item) => ({ kind: 'handoff', item })),
    ];
}
function resolveMemoryItem(state, id) {
    return collectMemoryItems(state).find(({ item }) => item.id === id || item.short_label === id);
}
function renderMemoryMeta(kind, item) {
    switch (kind) {
        case 'decision':
            return item.outcome ? ` (${item.outcome})` : '';
        case 'constraint':
            return ` (${item.status}${item.category ? ` · ${item.category}` : ''})`;
        case 'trap':
            return ` (${item.severity} · ${item.status})`;
        case 'handoff':
            return ` (${item.from} -> ${item.to} · ${item.status})`;
    }
}
function isMemoryKind(value) {
    return value === 'decision' || value === 'constraint' || value === 'trap' || value === 'handoff';
}
//# sourceMappingURL=memory.js.map