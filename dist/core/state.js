import fs from 'node:fs';
import path from 'node:path';
import { ConstraintSchema, DecisionSchema, TrapSchema, HandoffSchema, PlanItemSchema } from './schema.js';
import { ensureMemoryDir, resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { commitMemoryChange } from './memory-git.js';
import { appendEvent } from './event-log.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { rebuildProjectMd } from './markdown.js';
export function emptyState() {
    return {
        version: 1,
        write_version: 1,
        active_constraints: [],
        recent_decisions: [],
        known_traps: [],
        open_handoffs: [],
        plan_items: [],
    };
}
function loadDirectoryItems(dirPath, schema, documentType) {
    if (!fs.existsSync(dirPath))
        return [];
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const items = [];
    for (const file of files) {
        try {
            items.push(schema.parse(loadVersionedJsonFile(documentType, path.join(dirPath, file)).document));
        }
        catch {
            // skip invalid files
        }
    }
    return items;
}
export function loadState(cwd) {
    // Load from entity-aligned directories (with legacy fallback)
    const effectiveCwd = cwd ?? process.cwd();
    const state = emptyState();
    state.active_constraints = loadDirectoryItems(resolveEntityDir('constraints', effectiveCwd, 'read'), ConstraintSchema, 'constraint');
    state.recent_decisions = loadDirectoryItems(resolveEntityDir('decisions', effectiveCwd, 'read'), DecisionSchema, 'decision');
    state.known_traps = loadDirectoryItems(resolveEntityDir('traps', effectiveCwd, 'read'), TrapSchema, 'trap');
    state.open_handoffs = loadDirectoryItems(resolveEntityDir('handoffs', effectiveCwd, 'read'), HandoffSchema, 'handoff');
    state.plan_items = loadDirectoryItems(resolveEntityDir('plans', effectiveCwd, 'read'), PlanItemSchema, 'plan');
    // Sort them by creation date for consistency
    state.active_constraints.sort((a, b) => a.created_at.localeCompare(b.created_at));
    state.recent_decisions.sort((a, b) => a.created_at.localeCompare(b.created_at));
    state.known_traps.sort((a, b) => a.created_at.localeCompare(b.created_at));
    state.open_handoffs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    state.plan_items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return state;
}
function syncDirectory(dirPath, items, documentType) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    // Write all current items
    const currentIds = new Set();
    for (const item of items) {
        currentIds.add(item.id);
        const filepath = path.join(dirPath, `${item.id}.json`);
        saveVersionedJsonFile(documentType, filepath, item);
    }
    // Remove files that are no longer in the state (e.g. if deleted/pruned)
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const id = file.replace('.json', '');
        if (!currentIds.has(id)) {
            fs.unlinkSync(path.join(dirPath, file));
        }
    }
}
export function saveState(state, cwd) {
    persistState(state, cwd, { writeProjectMarkdown: false });
}
function persistStateUnlocked(state, cwd, options = {}) {
    writeStateDirectories(state, cwd);
    if (options.writeProjectMarkdown ?? true) {
        rebuildProjectMd(state, cwd);
    }
    appendEvent({
        action: options.eventAction ?? 'update',
        item_type: 'state',
        agent: 'system',
        summary: options.eventSummary,
    }, cwd);
    commitMemoryChange(options.commitMessage ?? 'state update', cwd);
}
function writeStateDirectories(state, cwd) {
    ensureMemoryDir(cwd);
    const effectiveCwd = cwd ?? process.cwd();
    syncDirectory(resolveEntityDir('constraints', effectiveCwd, 'write'), state.active_constraints, 'constraint');
    syncDirectory(resolveEntityDir('decisions', effectiveCwd, 'write'), state.recent_decisions, 'decision');
    syncDirectory(resolveEntityDir('traps', effectiveCwd, 'write'), state.known_traps, 'trap');
    syncDirectory(resolveEntityDir('handoffs', effectiveCwd, 'write'), state.open_handoffs, 'handoff');
    syncDirectory(resolveEntityDir('plans', effectiveCwd, 'write'), state.plan_items, 'plan');
}
export function persistState(state, cwd, options = {}) {
    const effectiveCwd = cwd ?? process.cwd();
    mutate({ cwd: effectiveCwd }, () => {
        persistStateUnlocked(state, effectiveCwd, options);
    });
}
export function mutateState(mutateFn, cwd, options = {}) {
    const effectiveCwd = cwd ?? process.cwd();
    return mutate({ cwd: effectiveCwd }, () => {
        const state = loadState(effectiveCwd);
        const result = mutateFn(state);
        persistStateUnlocked(state, effectiveCwd, options);
        return result;
    });
}
//# sourceMappingURL=state.js.map