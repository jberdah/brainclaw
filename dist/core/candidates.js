import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CandidateSchema } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO, getNextShortLabel } from './ids.js';
import { JsonStore } from './json-store.js';
function inboxDir(cwd, mode = 'read') {
    return resolveEntityDir('inbox', cwd ?? process.cwd(), mode);
}
function acceptedDir(cwd, mode = 'read') {
    return resolveEntityDir('inbox/accepted', cwd ?? process.cwd(), mode);
}
function rejectedDir(cwd, mode = 'read') {
    return resolveEntityDir('inbox/rejected', cwd ?? process.cwd(), mode);
}
export function ensureInboxDirs(cwd) {
    for (const dir of [inboxDir(cwd, 'write'), acceptedDir(cwd, 'write'), rejectedDir(cwd, 'write')]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}
function candidateStore(dest = 'pending', cwd) {
    const dir = dest === 'accepted'
        ? acceptedDir(cwd)
        : dest === 'rejected'
            ? rejectedDir(cwd)
            : inboxDir(cwd);
    return new JsonStore({
        dirPath: dir,
        documentType: 'candidate',
        getId: (candidate) => candidate.id,
        sort: (a, b) => a.created_at.localeCompare(b.created_at),
    });
}
export function saveCandidate(candidate, cwd) {
    mutate({ cwd }, () => {
        ensureInboxDirs(cwd);
        candidateStore('pending', cwd).save(CandidateSchema.parse(candidate));
    });
}
export function loadCandidate(id, cwd) {
    return candidateStore('pending', cwd).load(id);
}
export function updateCandidate(candidate, cwd) {
    saveCandidate(candidate, cwd);
}
export function listCandidates(status, cwd) {
    const candidates = candidateStore('pending', cwd).list();
    return status ? candidates.filter((candidate) => candidate.status === status) : candidates;
}
export function archiveCandidate(candidate, dest, cwd) {
    mutate({ cwd }, () => {
        ensureInboxDirs(cwd);
        candidateStore(dest, cwd).save(CandidateSchema.parse(candidate));
        candidateStore('pending', cwd).delete(candidate.id);
    });
}
export function listArchivedCandidates(dest, cwd) {
    return candidateStore(dest, cwd).list();
}
export function deleteArchivedCandidate(id, dest, cwd) {
    const dir = dest === 'accepted' ? acceptedDir(cwd) : rejectedDir(cwd);
    const filepath = path.join(dir, `${id}.json`);
    if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        return true;
    }
    return false;
}
export function addCandidateStar(id, by, cwd) {
    const candidate = loadCandidate(id, cwd);
    if (candidate.status !== 'pending') {
        throw new Error(`Candidate '${id}' is already ${candidate.status}.`);
    }
    const actor = by.trim();
    if (!actor) {
        throw new Error('Star actor must not be empty.');
    }
    if (candidate.starred_by.includes(actor)) {
        return { candidate, added: false };
    }
    candidate.starred_by = [...candidate.starred_by, actor].sort((a, b) => a.localeCompare(b));
    candidate.star_count = candidate.starred_by.length;
    candidate.last_starred_at = nowISO();
    updateCandidate(candidate, cwd);
    return { candidate, added: true };
}
export function addCandidateUse(id, by, context, cwd) {
    const candidate = loadCandidate(id, cwd);
    if (candidate.status !== 'pending') {
        throw new Error(`Candidate '${id}' is already ${candidate.status}.`);
    }
    const actor = by.trim();
    const usageContext = context.trim();
    if (!actor) {
        throw new Error('Usage actor must not be empty.');
    }
    if (!usageContext) {
        throw new Error('Usage context must not be empty.');
    }
    const exists = candidate.usage_events.some((event) => event.by === actor && event.context === usageContext);
    if (exists) {
        return { candidate, added: false };
    }
    candidate.usage_events = [
        ...candidate.usage_events,
        { by: actor, context: usageContext, created_at: nowISO() },
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    candidate.usage_count = candidate.usage_events.length;
    candidate.last_used_at = nowISO();
    updateCandidate(candidate, cwd);
    return { candidate, added: true };
}
export function generateCandidateId() {
    const rand = crypto.randomBytes(4).toString('hex');
    return `cnd_${rand}`;
}
/** Generate both a hash candidate ID and a short label (e.g. `cnd#47`). */
export function generateCandidateIdWithLabel(cwd) {
    const rand = crypto.randomBytes(4).toString('hex');
    const id = `cnd_${rand}`;
    const short_label = getNextShortLabel('cnd', cwd);
    return { id, short_label };
}
/**
 * Resolve a candidate alias (`cnd#47`) or hash ID to the canonical hash ID.
 * Searches pending inbox only — use `resolveArchivedIdOrAlias` for historical items.
 */
export function resolveIdOrAlias(input, cwd) {
    if (!/^[a-z]+#\d+$/.test(input))
        return input;
    const candidates = listCandidates(undefined, cwd);
    const found = candidates.find(c => c.short_label === input);
    if (!found) {
        throw new Error(`No pending candidate found with alias '${input}'.`);
    }
    return found.id;
}
//# sourceMappingURL=candidates.js.map