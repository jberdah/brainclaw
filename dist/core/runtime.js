import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentHostId, sanitizeHostId } from './host.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { RuntimeNoteSchema } from './schema.js';
import { commitMemoryChange } from './memory-git.js';
import { appendEvent } from './event-log.js';
function sharedRuntimeDir(cwd, mode = 'read') {
    return resolveEntityDir('runtime', cwd ?? process.cwd(), mode);
}
function machineRuntimeDir(cwd, mode = 'read') {
    return resolveEntityDir('runtime-hosts', cwd ?? process.cwd(), mode);
}
function privateRuntimeDir(cwd, mode = 'read') {
    return resolveEntityDir('runtime-private', cwd ?? process.cwd(), mode);
}
function sharedAgentDir(agent, cwd, mode = 'read') {
    return path.join(sharedRuntimeDir(cwd, mode), agent);
}
function hostRootDir(visibility, hostId, cwd, mode = 'read') {
    const baseDir = visibility === 'machine' ? machineRuntimeDir(cwd, mode) : privateRuntimeDir(cwd, mode);
    return path.join(baseDir, sanitizeHostId(hostId));
}
function hostAgentDir(visibility, hostId, agent, cwd, mode = 'read') {
    return path.join(hostRootDir(visibility, hostId, cwd, mode), agent);
}
export function ensureRuntimeDir(agent, cwd, visibility = 'shared', hostId) {
    const dir = visibility === 'shared'
        ? sharedAgentDir(agent, cwd, 'write')
        : hostAgentDir(visibility, hostId ?? resolveCurrentHostId(), agent, cwd, 'write');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
export function saveRuntimeNote(note, cwd) {
    const visibility = note.visibility ?? 'shared';
    const hostId = sanitizeHostId(note.host_id ?? resolveCurrentHostId());
    const persistedNote = visibility === 'shared'
        ? { ...note, visibility, host_id: hostId }
        : { ...note, visibility, host_id: hostId };
    mutate({ cwd }, () => {
        ensureRuntimeDir(note.agent, cwd, visibility, hostId);
        const filepath = visibility === 'shared'
            ? path.join(sharedAgentDir(note.agent, cwd, 'write'), `${note.id}.json`)
            : path.join(hostAgentDir(visibility, hostId, note.agent, cwd, 'write'), `${note.id}.json`);
        saveVersionedJsonFile('runtime_note', filepath, RuntimeNoteSchema.parse(persistedNote));
        appendEvent({ action: 'create', item_type: 'runtime_note', item_id: note.id, agent: note.agent, agent_id: note.agent_id }, cwd);
        commitMemoryChange(`runtime note: ${note.note_type ?? 'note'} (${note.agent})`, cwd);
    });
}
export function runtimeNotePath(note, cwd) {
    const visibility = note.visibility ?? 'shared';
    const hostId = sanitizeHostId(note.host_id ?? resolveCurrentHostId());
    return visibility === 'shared'
        ? path.join(sharedAgentDir(note.agent, cwd), `${note.id}.json`)
        : path.join(hostAgentDir(visibility, hostId, note.agent, cwd), `${note.id}.json`);
}
export function deleteRuntimeNote(note, cwd) {
    return mutate({ cwd }, () => {
        const filepath = runtimeNotePath(note, cwd);
        if (!fs.existsSync(filepath)) {
            return false;
        }
        fs.unlinkSync(filepath);
        return true;
    });
}
function readAgentNotes(dir, agent) {
    if (!fs.existsSync(dir))
        return [];
    const agents = agent
        ? [agent]
        : fs.readdirSync(dir).filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory());
    const notes = [];
    for (const a of agents) {
        const agentDirectory = path.join(dir, a);
        if (!fs.existsSync(agentDirectory))
            continue;
        const files = fs.readdirSync(agentDirectory).filter((file) => file.endsWith('.json'));
        for (const file of files) {
            try {
                notes.push(loadVersionedJsonFile('runtime_note', path.join(agentDirectory, file)).document);
            }
            catch { /* skip */ }
        }
    }
    return notes;
}
function resolveHostIds(rootDir, options) {
    if (!fs.existsSync(rootDir))
        return [];
    if (options.includeAllHosts) {
        return fs.readdirSync(rootDir)
            .filter((entry) => fs.statSync(path.join(rootDir, entry)).isDirectory())
            .map((entry) => sanitizeHostId(entry));
    }
    return [sanitizeHostId(options.hostId ?? resolveCurrentHostId())];
}
function readHostScopedNotes(visibility, options, cwd) {
    const rootDir = visibility === 'machine' ? machineRuntimeDir(cwd) : privateRuntimeDir(cwd);
    const hostIds = resolveHostIds(rootDir, options);
    const notes = [];
    for (const hostId of hostIds) {
        notes.push(...readAgentNotes(hostRootDir(visibility, hostId, cwd), options.agent));
    }
    return notes;
}
function normalizeRuntimeListOptions(agentOrOptions) {
    if (typeof agentOrOptions === 'string') {
        return { agent: agentOrOptions };
    }
    return agentOrOptions ?? {};
}
export function listRuntimeNotes(agentOrOptions, cwd) {
    const options = normalizeRuntimeListOptions(agentOrOptions);
    const visibility = options.visibility;
    const notes = [];
    if (!visibility || visibility === 'shared' || visibility === 'all') {
        notes.push(...readAgentNotes(sharedRuntimeDir(cwd), options.agent));
    }
    if (!visibility || visibility === 'machine' || visibility === 'all') {
        notes.push(...readHostScopedNotes('machine', options, cwd));
    }
    if (visibility === 'private' || visibility === 'all') {
        notes.push(...readHostScopedNotes('private', options, cwd));
    }
    return notes.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export function findRuntimeNoteById(id, options = {}, cwd) {
    return listRuntimeNotes({ ...options, visibility: options.visibility ?? 'all' }, cwd).find((note) => note.id === id);
}
export function generateRuntimeNoteId() {
    const rand = crypto.randomBytes(4).toString('hex');
    return `rtn_${rand}`;
}
//# sourceMappingURL=runtime.js.map