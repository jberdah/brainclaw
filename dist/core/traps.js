import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentHostId, sanitizeHostId } from './host.js';
import { generateId, generateIdWithLabel } from './ids.js';
import { resolveEntityDir } from './io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { TrapSchema } from './schema.js';
export function isTrapExpired(trap, nowIso = new Date().toISOString()) {
    return trap.status === 'expired' || (!!trap.expires_at && trap.expires_at < nowIso);
}
export function isTrapActive(trap, nowIso = new Date().toISOString()) {
    return trap.status === 'active' && !isTrapExpired(trap, nowIso);
}
function machineTrapsDir(cwd) {
    return resolveEntityDir('traps-hosts', cwd ?? process.cwd(), 'read');
}
function privateTrapsDir(cwd) {
    return resolveEntityDir('traps-private', cwd ?? process.cwd(), 'read');
}
function hostTrapDir(visibility, hostId, cwd) {
    const baseDir = visibility === 'machine' ? machineTrapsDir(cwd) : privateTrapsDir(cwd);
    return path.join(baseDir, sanitizeHostId(hostId));
}
function ensureHostTrapDir(visibility, hostId, cwd) {
    const dir = hostTrapDir(visibility, hostId, cwd);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function readTrapFiles(dir) {
    if (!fs.existsSync(dir))
        return [];
    const traps = [];
    for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
        try {
            traps.push(loadVersionedJsonFile('trap', path.join(dir, file)).document);
        }
        catch {
            // Ignore malformed files.
        }
    }
    return traps;
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
export function listOperationalTraps(options = {}, cwd) {
    const visibility = options.visibility;
    const traps = [];
    if (!visibility || visibility === 'machine' || visibility === 'all') {
        for (const hostId of resolveHostIds(machineTrapsDir(cwd), options)) {
            traps.push(...readTrapFiles(hostTrapDir('machine', hostId, cwd)));
        }
    }
    if (visibility === 'private' || visibility === 'all') {
        for (const hostId of resolveHostIds(privateTrapsDir(cwd), options)) {
            traps.push(...readTrapFiles(hostTrapDir('private', hostId, cwd)));
        }
    }
    return traps.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export function saveOperationalTrap(trap, cwd) {
    const visibility = trap.visibility === 'private' ? 'private' : 'machine';
    const hostId = sanitizeHostId(trap.host_id ?? resolveCurrentHostId());
    ensureHostTrapDir(visibility, hostId, cwd);
    const persisted = {
        ...trap,
        visibility,
        host_id: hostId,
    };
    saveVersionedJsonFile('trap', path.join(hostTrapDir(visibility, hostId, cwd), `${trap.id}.json`), TrapSchema.parse(persisted));
}
export function generateTrapId() {
    return generateId('known_traps');
}
export function generateTrapIdWithLabel(cwd) {
    return generateIdWithLabel('known_traps', cwd);
}
//# sourceMappingURL=traps.js.map