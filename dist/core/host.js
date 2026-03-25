import os from 'node:os';
const HOST_ID_PATTERN = /[^a-z0-9._-]+/g;
export function sanitizeHostId(value) {
    const normalized = value.trim().toLowerCase().replace(HOST_ID_PATTERN, '-').replace(/-+/g, '-');
    return normalized.replace(/^-|-$/g, '') || 'unknown-host';
}
export function resolveCurrentHostId(explicitHostId) {
    return sanitizeHostId(explicitHostId ?? process.env.BRAINCLAW_HOST_ID ?? os.hostname());
}
//# sourceMappingURL=host.js.map