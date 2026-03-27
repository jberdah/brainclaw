import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireRegisteredAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { memoryDir } from './io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { CurrentSessionStateSchema } from './schema.js';
const SESSIONS_DIR = 'sessions';
const LEGACY_SESSION_FILE = '.current-session';
// --- Public API ---
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
/**
 * Load the current session for this agent+user combo.
 * Checks sessions/ directory first, falls back to legacy .current-session.
 */
export function loadCurrentSession(cwd) {
    const dir = sessionsDir(cwd);
    const currentUser = resolveCurrentUser();
    const currentAgent = resolveCurrentAgentName();
    // 1. Look in sessions/ directory for a matching session
    if (fs.existsSync(dir) && currentAgent) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const ttlMs = parseDurationToMs(loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
        const now = Date.now();
        for (const file of files) {
            try {
                const migration = loadVersionedJsonFile('current_session', path.join(dir, file));
                const session = {
                    ...CurrentSessionStateSchema.parse(migration.document),
                    schema_version: migration.metadata.currentVersion,
                };
                // Strict match: agent name must match, user must match (when both are known)
                if (session.agent !== currentAgent)
                    continue;
                const userMatch = !session.user || !currentUser || session.user === currentUser;
                const alive = (now - Date.parse(session.last_seen_at)) <= ttlMs;
                if (userMatch && alive) {
                    return session;
                }
            }
            catch {
                // skip invalid session files
            }
        }
    }
    // 2. Legacy fallback: .current-session
    const legacyPath = path.join(memoryDir(cwd), LEGACY_SESSION_FILE);
    if (fs.existsSync(legacyPath)) {
        try {
            const migration = loadVersionedJsonFile('current_session', legacyPath);
            return {
                ...CurrentSessionStateSchema.parse(migration.document),
                schema_version: migration.metadata.currentVersion,
            };
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
/**
 * Load a specific session by ID.
 */
export function loadSessionById(sessionId, cwd) {
    const filepath = sessionFilePath(sessionId, cwd);
    if (!fs.existsSync(filepath))
        return undefined;
    try {
        const migration = loadVersionedJsonFile('current_session', filepath);
        return {
            ...CurrentSessionStateSchema.parse(migration.document),
            schema_version: migration.metadata.currentVersion,
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Load ALL sessions (active + stale) from the sessions/ directory.
 */
export function loadAllSessions(cwd) {
    const dir = sessionsDir(cwd);
    if (!fs.existsSync(dir))
        return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const file of files) {
        try {
            const migration = loadVersionedJsonFile('current_session', path.join(dir, file));
            sessions.push({
                ...CurrentSessionStateSchema.parse(migration.document),
                schema_version: migration.metadata.currentVersion,
            });
        }
        catch {
            // skip invalid
        }
    }
    return sessions.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
}
/**
 * Save a session to the sessions/ directory.
 */
export function saveCurrentSession(session, cwd) {
    const dir = sessionsDir(cwd);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filepath = sessionFilePath(session.session_id, cwd);
    saveVersionedJsonFile('current_session', filepath, CurrentSessionStateSchema.parse(session));
}
/**
 * Clear a session. If sessionId is provided, only clear that specific session.
 */
export function clearCurrentSession(cwd, sessionId) {
    if (sessionId) {
        // Remove specific session file
        const filepath = sessionFilePath(sessionId, cwd);
        try {
            fs.unlinkSync(filepath);
        }
        catch { /* ignore */ }
        return;
    }
    // Clear the session for the current agent+user
    const session = loadCurrentSession(cwd);
    if (session) {
        const filepath = sessionFilePath(session.session_id, cwd);
        try {
            fs.unlinkSync(filepath);
        }
        catch { /* ignore */ }
    }
    // Also clean legacy file
    const legacyPath = path.join(memoryDir(cwd), LEGACY_SESSION_FILE);
    try {
        fs.unlinkSync(legacyPath);
    }
    catch { /* ignore */ }
}
/**
 * Remove stale sessions that have exceeded the TTL.
 * Returns the number of sessions removed.
 */
export function gcStaleSessions(cwd, ttlOverride) {
    const dir = sessionsDir(cwd);
    if (!fs.existsSync(dir))
        return 0;
    const ttlMs = parseDurationToMs(ttlOverride ?? loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
    const now = Date.now();
    let removed = 0;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        try {
            const migration = loadVersionedJsonFile('current_session', path.join(dir, file));
            const session = {
                ...CurrentSessionStateSchema.parse(migration.document),
                schema_version: migration.metadata.currentVersion,
            };
            if (now - Date.parse(session.last_seen_at) > ttlMs) {
                fs.unlinkSync(path.join(dir, file));
                removed++;
            }
        }
        catch {
            // Remove unparseable files too
            try {
                fs.unlinkSync(path.join(dir, file));
                removed++;
            }
            catch { /* ignore */ }
        }
    }
    return removed;
}
// --- Internal helpers ---
function sessionsDir(cwd) {
    return path.join(memoryDir(cwd), SESSIONS_DIR);
}
function sessionFilePath(sessionId, cwd) {
    return path.join(sessionsDir(cwd), `${sessionId}.json`);
}
function resolveCurrentUser() {
    return process.env.USER || process.env.USERNAME || os.userInfo().username || undefined;
}
function resolveCurrentAgentName() {
    if (process.env.BRAINCLAW_AGENT_NAME)
        return process.env.BRAINCLAW_AGENT_NAME;
    if (process.env.CLAUDE_CODE_VERSION)
        return 'claude-code';
    return undefined;
}
function loadConfigSafe(cwd) {
    try {
        return loadConfig(cwd);
    }
    catch {
        return undefined;
    }
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Find the session matching the current process among all active sessions.
 *
 * Resolution order:
 *  1. Preferred session ID (explicit env var / parameter) → exact match
 *  2. Same agent + user + host + same PID → refresh (same process reconnecting)
 *  3. Same agent + user + host + dead PID → reclaim stale session
 *  4. No match → create new session
 *
 * Crucially, if another session exists for the same agent+user+host but with
 * a LIVE different PID, it is left untouched — that's a parallel instance.
 */
function resolveImplicitSession(cwd, options) {
    const persistImplicit = options.persistImplicit ?? true;
    const ttlMs = parseDurationToMs(loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
    const now = new Date();
    const currentUser = resolveCurrentUser();
    const currentPid = process.pid;
    // 1. If a preferred session ID is given, try exact match first
    if (options.preferredSessionId) {
        const exact = loadSessionById(options.preferredSessionId, cwd);
        if (exact && now.getTime() - Date.parse(exact.last_seen_at) <= ttlMs) {
            const refreshed = {
                ...exact,
                last_seen_at: now.toISOString(),
                user: exact.user || currentUser,
                pid: currentPid,
            };
            if (persistImplicit)
                saveCurrentSession(refreshed, cwd);
            return refreshed;
        }
    }
    // 2. Scan all sessions for PID-aware matching
    const allSessions = loadAllSessions(cwd);
    let samePidSession;
    let deadPidSession;
    for (const session of allSessions) {
        if (session.agent !== options.agentName)
            continue;
        if (session.agent_id !== options.agentId)
            continue;
        if (session.host_id !== options.hostId)
            continue;
        if (currentUser && session.user && session.user !== currentUser)
            continue;
        if (now.getTime() - Date.parse(session.last_seen_at) > ttlMs)
            continue;
        // Same PID = same process reconnecting (e.g. MCP server refreshing)
        if (session.pid === currentPid) {
            samePidSession = session;
            break;
        }
        // Different PID but alive = parallel instance, do NOT reclaim
        if (session.pid && isPidAlive(session.pid)) {
            continue;
        }
        // Dead PID = stale session, candidate for reclaim
        if (!deadPidSession) {
            deadPidSession = session;
        }
    }
    const toRefresh = samePidSession ?? deadPidSession;
    if (toRefresh) {
        const refreshed = {
            ...toRefresh,
            last_seen_at: now.toISOString(),
            user: toRefresh.user || currentUser,
            pid: currentPid,
        };
        if (persistImplicit)
            saveCurrentSession(refreshed, cwd);
        return refreshed;
    }
    // 3. No match — create new session
    const created = {
        session_id: options.preferredSessionId ?? generateImplicitSessionId(),
        started_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        agent: options.agentName,
        agent_id: options.agentId,
        host_id: options.hostId,
        user: currentUser,
        pid: currentPid,
    };
    if (persistImplicit)
        saveCurrentSession(created, cwd);
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