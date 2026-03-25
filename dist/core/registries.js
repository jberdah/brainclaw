/**
 * Dedicated registries for project capabilities and tools.
 *
 * Replaces the legacy hack of storing capabilities/tools as decisions
 * with 'capability'/'tool' tags. Items are now persisted as individual
 * JSON files under discovery/capabilities/ and discovery/tools/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveEntityDir } from './io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { ProjectCapabilitySchema, ProjectToolSchema } from './schema.js';
import { generateIdWithLabel, nowISO } from './ids.js';
import { appendEvent } from './event-log.js';
// --- Capabilities ---
export function listCapabilities(cwd) {
    const dir = resolveEntityDir('capabilities', cwd, 'read');
    if (!dir || !fs.existsSync(dir))
        return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const items = [];
    for (const file of files) {
        try {
            const result = loadVersionedJsonFile('capability', path.join(dir, file));
            items.push(ProjectCapabilitySchema.parse(result.document));
        }
        catch {
            // skip invalid
        }
    }
    return items;
}
export function saveCapability(cap, cwd) {
    const dir = resolveEntityDir('capabilities', cwd, 'write');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    saveVersionedJsonFile('capability', path.join(dir, `${cap.id}.json`), cap);
}
export function deleteCapability(id, cwd) {
    const dir = resolveEntityDir('capabilities', cwd, 'read');
    if (!dir)
        return false;
    const fp = path.join(dir, `${id}.json`);
    if (!fs.existsSync(fp))
        return false;
    fs.unlinkSync(fp);
    return true;
}
export function createCapability(opts, cwd) {
    const idObj = generateIdWithLabel('cap');
    const cap = {
        id: idObj.id,
        name: opts.name,
        description: opts.description,
        category: opts.category ?? 'general',
        tags: opts.tags ?? [],
        status: 'stable',
        created_at: nowISO(),
        author: opts.author,
        author_id: opts.authorId,
        model: opts.model,
    };
    saveCapability(cap, cwd);
    appendEvent({ action: 'create', item_type: 'decision', item_id: cap.id, agent: opts.author, agent_id: opts.authorId, summary: `capability: ${opts.name}` }, cwd);
    return cap;
}
// --- Tools ---
export function listTools(cwd) {
    const dir = resolveEntityDir('tools', cwd, 'read');
    if (!dir || !fs.existsSync(dir))
        return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const items = [];
    for (const file of files) {
        try {
            const result = loadVersionedJsonFile('tool', path.join(dir, file));
            items.push(ProjectToolSchema.parse(result.document));
        }
        catch {
            // skip invalid
        }
    }
    return items;
}
export function saveTool(tool, cwd) {
    const dir = resolveEntityDir('tools', cwd, 'write');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    saveVersionedJsonFile('tool', path.join(dir, `${tool.id}.json`), tool);
}
export function deleteTool(id, cwd) {
    const dir = resolveEntityDir('tools', cwd, 'read');
    if (!dir)
        return false;
    const fp = path.join(dir, `${id}.json`);
    if (!fs.existsSync(fp))
        return false;
    fs.unlinkSync(fp);
    return true;
}
export function createTool(opts, cwd) {
    const idObj = generateIdWithLabel('tol');
    const tool = {
        id: idObj.id,
        name: opts.name,
        description: opts.description,
        type: (opts.type ?? 'utility'),
        implementation: opts.implementation ?? '',
        tags: opts.tags ?? [],
        status: 'stable',
        created_at: nowISO(),
        author: opts.author,
        author_id: opts.authorId,
        model: opts.model,
    };
    saveTool(tool, cwd);
    appendEvent({ action: 'create', item_type: 'decision', item_id: tool.id, agent: opts.author, agent_id: opts.authorId, summary: `tool: ${opts.name}` }, cwd);
    return tool;
}
//# sourceMappingURL=registries.js.map