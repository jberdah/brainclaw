import fs from 'node:fs';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { generateId } from './ids.js';
import { InstructionEntrySchema } from './schema.js';
import { JsonStore } from './json-store.js';
function instructionStore(cwd, mode = 'read') {
    return new JsonStore({
        dirPath: resolveEntityDir('instructions', cwd ?? process.cwd(), mode),
        documentType: 'instruction',
        getId: (entry) => entry.id,
        sort: (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    });
}
export function loadInstructions(cwd) {
    const dir = resolveEntityDir('instructions', cwd ?? process.cwd(), 'read');
    if (!fs.existsSync(dir)) {
        return [];
    }
    return instructionStore(cwd).list();
}
export function saveInstruction(entry, cwd) {
    mutate({ cwd }, () => {
        instructionStore(cwd, 'write').save(InstructionEntrySchema.parse(entry));
    });
}
export function createInstruction(text, options, cwd) {
    const entries = loadInstructions(cwd);
    const timestamp = new Date().toISOString();
    const entry = {
        schema_version: 2,
        id: generateId('instruction_entries'),
        layer: options.layer,
        scope: options.scope,
        text,
        created_at: timestamp,
        updated_at: timestamp,
        author: options.author,
        tags: options.tags ?? [],
        active: true,
        supersedes: options.supersedes,
    };
    saveInstruction(entry, cwd);
    return entry;
}
export function resolveInstructions(entries, options = {}) {
    const superseded = new Set(entries
        .filter((entry) => entry.active && entry.supersedes)
        .map((entry) => entry.supersedes));
    const active = entries.filter((entry) => entry.active && !superseded.has(entry.id));
    const scoped = active.filter((entry) => {
        if (entry.layer === 'global') {
            return true;
        }
        if (entry.layer === 'project') {
            return entry.scope === options.project;
        }
        return entry.scope === options.agent;
    });
    const latestByScope = new Map();
    for (const entry of scoped) {
        const key = `${entry.layer}:${entry.scope ?? '*'}`;
        const current = latestByScope.get(key);
        if (!current || current.updated_at.localeCompare(entry.updated_at) <= 0) {
            latestByScope.set(key, entry);
        }
    }
    return [...latestByScope.values()].sort((a, b) => {
        const rank = layerOrder(a.layer) - layerOrder(b.layer);
        if (rank !== 0)
            return rank;
        return a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id);
    });
}
export function inferProjectFromTarget(target, config) {
    const trimmed = target?.trim();
    if (!trimmed) {
        return undefined;
    }
    const normalized = trimmed.replace(/\\/g, '/');
    const known = config.projects?.known ?? [];
    if (known.includes(normalized)) {
        return normalized;
    }
    return known.find((project) => normalized === project || normalized.startsWith(`${project}/`));
}
export function findInstructionConflicts(entries) {
    const superseded = new Set(entries
        .filter((entry) => entry.active && entry.supersedes)
        .map((entry) => entry.supersedes));
    const groups = new Map();
    for (const entry of entries.filter((item) => item.active && !superseded.has(item.id))) {
        const key = `${entry.layer}:${entry.scope ?? ''}`;
        const bucket = groups.get(key) ?? [];
        bucket.push(entry);
        groups.set(key, bucket);
    }
    const conflicts = [];
    for (const group of groups.values()) {
        if (group.length > 1) {
            conflicts.push({
                layer: group[0].layer,
                scope: group[0].scope,
                ids: group.map((entry) => entry.id),
            });
        }
    }
    return conflicts;
}
function layerOrder(layer) {
    switch (layer) {
        case 'global':
            return 0;
        case 'project':
            return 1;
        case 'agent':
            return 2;
    }
}
//# sourceMappingURL=instructions.js.map