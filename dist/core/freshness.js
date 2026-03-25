import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentHostId } from './host.js';
import { memoryPath, readFileSync, writeFileAtomic, resolveEntityDir } from './io.js';
import { logger } from './logger.js';
const SHARED_PATHS = [
    'config.yaml',
    'project.md',
    'constraints',
    'decisions',
    'traps',
    'handoffs',
    'plans',
    'instructions',
    'claims',
    'runtime',
    'inbox',
];
export function getVisibleMemoryVersion(options = {}) {
    const entries = [];
    const cwd = options.cwd ?? process.cwd();
    // Scan entity-aligned paths (with legacy fallback via resolveEntityDir)
    for (const relativePath of SHARED_PATHS) {
        const resolved = relativePath.includes('.') ? memoryPath(relativePath, cwd) : resolveEntityDir(relativePath, cwd, 'read');
        collectFileStats(resolved, relativePath, entries);
    }
    if (options.allHosts) {
        collectFileStats(resolveEntityDir('runtime-hosts', cwd, 'read'), 'runtime-hosts', entries);
        collectFileStats(resolveEntityDir('runtime-private', cwd, 'read'), 'runtime-private', entries);
        collectFileStats(resolveEntityDir('traps-hosts', cwd, 'read'), 'traps-hosts', entries);
        collectFileStats(resolveEntityDir('traps-private', cwd, 'read'), 'traps-private', entries);
    }
    else {
        const hostId = options.hostId ?? resolveCurrentHostId();
        collectFileStats(path.join(resolveEntityDir('runtime-hosts', cwd, 'read'), hostId), path.join('runtime-hosts', hostId), entries);
        collectFileStats(path.join(resolveEntityDir('runtime-private', cwd, 'read'), hostId), path.join('runtime-private', hostId), entries);
        collectFileStats(path.join(resolveEntityDir('traps-hosts', cwd, 'read'), hostId), path.join('traps-hosts', hostId), entries);
        collectFileStats(path.join(resolveEntityDir('traps-private', cwd, 'read'), hostId), path.join('traps-private', hostId), entries);
    }
    const hash = crypto.createHash('sha1');
    for (const entry of entries.sort()) {
        hash.update(entry);
        hash.update('\n');
    }
    return hash.digest('hex');
}
export function readContextMarker(cwd) {
    const markerPath = memoryPath('.last-context', cwd);
    if (!fs.existsSync(markerPath)) {
        return undefined;
    }
    const raw = readFileSync(markerPath).trim();
    if (!raw) {
        return undefined;
    }
    if (raw.startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.read_at === 'string') {
                return parsed;
            }
        }
        catch (err) {
            logger.debug('Failed to parse context marker:', err);
            return undefined;
        }
    }
    return { read_at: raw };
}
export function writeContextMarker(marker, cwd) {
    writeFileAtomic(memoryPath('.last-context', cwd), JSON.stringify(marker, null, 2) + '\n');
}
function collectFileStats(absolutePath, relativePath, entries) {
    if (!fs.existsSync(absolutePath)) {
        return;
    }
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
        for (const child of fs.readdirSync(absolutePath).sort()) {
            collectFileStats(path.join(absolutePath, child), `${relativePath}/${child}`, entries);
        }
        return;
    }
    entries.push(`${relativePath}:${stat.size}:${stat.mtimeMs}`);
}
//# sourceMappingURL=freshness.js.map