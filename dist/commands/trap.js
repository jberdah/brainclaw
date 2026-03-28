import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { resolveCurrentHostId } from '../core/host.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { requireInitialized } from '../core/guards.js';
import { validateCliInput, validateCliTtl } from '../core/input-validation.js';
import { resolveTargetStore } from '../core/store-resolution.js';
import { createTrap } from '../core/operations/memory-write.js';
export function runTrap(text, options = {}) {
    const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
    requireInitialized(cwd);
    validateCliInput(text, options.tag);
    if (options.ttl) {
        validateCliTtl(options.ttl);
    }
    const config = loadConfig(cwd);
    const warnings = scanText(text, config);
    for (const w of warnings) {
        console.warn(`⚠ ${w.message}`);
        if (w.level === 'block') {
            console.error('Blocked: strict redaction is enabled. Entry not added.');
            process.exit(1);
        }
    }
    const visibility = options.visibility ?? 'shared';
    const hostId = visibility === 'shared' ? undefined : resolveCurrentHostId(options.host);
    const result = createTrap({
        text,
        author: options.author ?? resolveCurrentAgentName(cwd),
        status: options.status,
        severity: options.severity,
        tags: options.tag,
        relatedPaths: options.path,
        planId: options.plan,
        visibility,
        hostId,
        expiresAt: options.ttl ? parseTtl(options.ttl) : undefined,
    }, cwd);
    const scopeInfo = result.visibility === 'shared' ? 'shared' : `${result.visibility}:${result.hostId}`;
    const storeLabel = options.store && options.store !== 'local' ? ` [store:${options.store}]` : '';
    console.log(`✔ Trap added: [${result.id}] (${scopeInfo}) ${text}${storeLabel}`);
}
/** Parse a TTL string like "30m", "2h", "7d" and return an ISO expiry timestamp. */
function parseTtl(ttl) {
    const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
    if (!match)
        return undefined;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === 'm' ? value * 60_000
        : unit === 'h' ? value * 3_600_000
            : value * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
}
//# sourceMappingURL=trap.js.map