import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requireRegisteredAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { memoryDir } from './io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { CurrentSessionStateSchema } from './schema.js';
const CURRENT_SESSION_FILE = '.current-session';
export function resolveCurrentSessionId(env = process.env, cwd, options = {}) {
    const value = env.BRAINCLAW_SESSION_ID?.trim()
        || env.OPENCLAW_SESSION_ID?.trim()
        || env.CLAUDE_SESSION_ID?.trim()
        || env.COPILOT_SESSION_ID?.trim();
    if (value && value.length > 0) {
        return value;
    }
    const agentName = options.agentName?.trim();
    const agentId = options.agentId?.trim();
    const hostId = options.hostId?.trim();
    if (!agentName || !agentId || !hostId) {
        return undefined;
    }
    const implicit = resolveImplicitSession(cwd, {
        agentName,
        agentId,
        hostId,
        preferredSessionId: options.preferredSessionId,
        persistImplicit: options.persistImplicit,
    });
    return implicit?.session_id;
}
export function buildOperationalIdentity(agentName, cwd, options = {}) {
    const actor = requireRegisteredAgentIdentity({
        agentName,
        agentId: options.agentId,
        cwd,
        allowCurrent: true,
        allowEnv: true,
    });
    const config = loadConfig(cwd);
    const hostId = resolveCurrentHostId();
    return {
        agent: actor.agent_name,
        agent_id: actor.agent_id,
        project_id: config.project_id,
        host_id: hostId,
        session_id: resolveCurrentSessionId(process.env, cwd, {
            agentName: actor.agent_name,
            agentId: actor.agent_id,
            hostId,
            preferredSessionId: options.sessionId,
            persistImplicit: options.persistImplicitSession,
        }),
    };
}
export function resolveEventSessionId(event) {
    if (typeof event.session_id === 'string' && event.session_id.trim().length > 0) {
        return event.session_id;
    }
    const metadataSession = event.metadata?.session;
    return typeof metadataSession === 'string' && metadataSession.trim().length > 0
        ? metadataSession
        : undefined;
}
export function loadCurrentSession(cwd) {
    const filepath = currentSessionPath(cwd);
    if (!fs.existsSync(filepath)) {
        return undefined;
    }
    try {
        return CurrentSessionStateSchema.parse(loadVersionedJsonFile('current_session', filepath).document);
    }
    catch {
        return undefined;
    }
}
export function saveCurrentSession(session, cwd) {
    saveVersionedJsonFile('current_session', currentSessionPath(cwd), CurrentSessionStateSchema.parse(session));
}
export function clearCurrentSession(cwd, sessionId) {
    const filepath = currentSessionPath(cwd);
    if (!fs.existsSync(filepath)) {
        return;
    }
    if (sessionId) {
        const current = loadCurrentSession(cwd);
        if (!current || current.session_id !== sessionId) {
            return;
        }
    }
    try {
        fs.unlinkSync(filepath);
    }
    catch {
        // Ignore cleanup races.
    }
}
function currentSessionPath(cwd) {
    return path.join(memoryDir(cwd), CURRENT_SESSION_FILE);
}
function resolveImplicitSession(cwd, options) {
    const current = loadCurrentSession(cwd);
    const persistImplicit = options.persistImplicit ?? true;
    const ttlMs = parseDurationToMs(loadConfig(cwd).implicit_session_ttl ?? '4h');
    const now = new Date();
    if (current
        && current.agent === options.agentName
        && current.agent_id === options.agentId
        && current.host_id === options.hostId
        && now.getTime() - Date.parse(current.last_seen_at) <= ttlMs) {
        const refreshed = {
            ...current,
            last_seen_at: now.toISOString(),
        };
        if (persistImplicit) {
            saveCurrentSession(refreshed, cwd);
        }
        return refreshed;
    }
    const created = {
        session_id: options.preferredSessionId ?? generateImplicitSessionId(),
        started_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        agent: options.agentName,
        agent_id: options.agentId,
        host_id: options.hostId,
    };
    if (persistImplicit) {
        saveCurrentSession(created, cwd);
    }
    return created;
}
function parseDurationToMs(value) {
    const match = /^(\d+)([mhd])$/i.exec(value.trim());
    if (!match) {
        return 4 * 60 * 60 * 1000;
    }
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 'm')
        return amount * 60_000;
    if (unit === 'h')
        return amount * 3_600_000;
    return amount * 86_400_000;
}
function generateImplicitSessionId() {
    return `sess_${crypto.randomBytes(4).toString('hex')}`;
}
//# sourceMappingURL=identity.js.map