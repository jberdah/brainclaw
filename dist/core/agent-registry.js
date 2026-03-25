import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAiAgent } from './ai-agent-detection.js';
import { loadConfig, saveConfig } from './config.js';
import { nowISO } from './ids.js';
import { MEMORY_DIR, resolveEntityDir } from './io.js';
import { JsonStore } from './json-store.js';
import { AgentIdentityDocumentSchema, } from './schema.js';
import { logger } from './logger.js';
// agents/ stays at top level in entity model (already entity-aligned)
const TRUST_ORDER = ['observer', 'contributor', 'trusted', 'curator'];
export class AgentIdentityResolutionError extends Error {
    kind = 'identity_error';
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
    }
}
export class AgentTrustError extends Error {
    kind = 'trust_error';
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
    }
}
export function generateAgentId() {
    return `agt_${crypto.randomUUID().replace(/-/g, '')}`;
}
export function resolveDefaultAgentName(env = process.env) {
    return env.BRAINCLAW_AGENT?.trim()
        || env.OPENCLAW_AGENT?.trim()
        || env.USERNAME?.trim()
        || env.USER?.trim()
        || 'unknown-agent';
}
function agentsDir(cwd, preferredDirName) {
    return resolveEntityDir('agents', cwd ?? process.cwd(), 'read', preferredDirName);
}
function ensureAgentsDir(cwd, preferredDirName) {
    const dir = agentsDir(cwd, preferredDirName);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function agentStore(cwd, preferredDirName) {
    return new JsonStore({
        dirPath: agentsDir(cwd, preferredDirName),
        documentType: 'agent_identity',
        getId: (agent) => agent.agent_id,
        sort: (a, b) => a.created_at.localeCompare(b.created_at) || a.agent_name.localeCompare(b.agent_name),
    });
}
function normalizeAgentName(agentName) {
    return agentName.trim().toLowerCase();
}
function normalizeCapability(capability) {
    const normalized = capability.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeCapabilities(capabilities) {
    const seen = new Set();
    const normalized = [];
    for (const capability of capabilities ?? []) {
        const next = normalizeCapability(capability);
        if (!next || seen.has(next)) {
            continue;
        }
        seen.add(next);
        normalized.push(next);
    }
    return normalized;
}
function mergeCapabilities(existing, next) {
    return normalizeCapabilities([...existing, ...next]);
}
function resolveEnvAgentName(env = process.env) {
    const value = env.BRAINCLAW_AGENT?.trim() || env.OPENCLAW_AGENT?.trim();
    return value && value.length > 0 ? value : undefined;
}
function codexHome(env = process.env) {
    const explicit = env.CODEX_HOME?.trim();
    return explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), '.codex');
}
function agentKeyPath(agentId, env = process.env) {
    return path.join(codexHome(env), 'brainclaw', 'keys', `${agentId}.ed25519.pem`);
}
function ensureParentDir(filepath) {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function fingerprintPublicKey(publicKey) {
    return crypto.createHash('sha256').update(publicKey).digest('hex');
}
function buildIdentityKey(agentId, env = process.env, forceRegenerate = false) {
    const filepath = agentKeyPath(agentId, env);
    const createdAt = nowISO();
    let publicKeyPem;
    if (!forceRegenerate && fs.existsSync(filepath)) {
        const privateKey = crypto.createPrivateKey(fs.readFileSync(filepath, 'utf-8'));
        publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    }
    else {
        const generated = crypto.generateKeyPairSync('ed25519');
        const privateKeyPem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        publicKeyPem = generated.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        ensureParentDir(filepath);
        fs.writeFileSync(filepath, privateKeyPem, 'utf-8');
    }
    return {
        algorithm: 'ed25519',
        public_key: publicKeyPem,
        fingerprint: fingerprintPublicKey(publicKeyPem),
        created_at: createdAt,
    };
}
function withIdentityKey(agent, env = process.env, forceRegenerate = false) {
    return {
        ...agent,
        identity_key: buildIdentityKey(agent.agent_id, env, forceRegenerate),
    };
}
export function loadAgentIdentity(agentId, cwd, preferredDirName) {
    return agentStore(cwd, preferredDirName).load(agentId);
}
export function saveAgentIdentity(agent, cwd, preferredDirName) {
    ensureAgentsDir(cwd, preferredDirName);
    agentStore(cwd, preferredDirName).save(AgentIdentityDocumentSchema.parse(agent));
}
export function listAgentIdentities(cwd, preferredDirName) {
    return agentStore(cwd, preferredDirName).list();
}
export function findAgentIdentityByName(agentName, cwd, preferredDirName) {
    const normalized = normalizeAgentName(agentName);
    return listAgentIdentities(cwd, preferredDirName).find((agent) => normalizeAgentName(agent.agent_name) === normalized);
}
export function findAgentIdentityById(agentId, cwd, preferredDirName) {
    try {
        return loadAgentIdentity(agentId, cwd, preferredDirName);
    }
    catch (err) {
        logger.debug('Failed to find agent identity by ID:', agentId, err);
        return undefined;
    }
}
export function registerAgentIdentity(input) {
    const normalizedCapabilities = normalizeCapabilities(input.capabilities);
    const existing = findAgentIdentityByName(input.agentName, input.cwd, input.preferredDirName);
    if (existing) {
        let updated = existing;
        if (input.kind && existing.kind !== input.kind) {
            updated = { ...updated, kind: input.kind };
        }
        if (input.trustLevel && existing.trust_level !== input.trustLevel) {
            // Never downgrade trust — only upgrade
            if (hasMinimumTrustLevel(input.trustLevel, existing.trust_level ?? 'contributor')) {
                updated = { ...updated, trust_level: input.trustLevel };
            }
        }
        if (input.replaceCapabilities) {
            updated = { ...updated, capabilities: normalizedCapabilities };
        }
        else if (normalizedCapabilities.length > 0) {
            updated = { ...updated, capabilities: mergeCapabilities(existing.capabilities ?? [], normalizedCapabilities) };
        }
        if (input.generateFingerprint) {
            updated = withIdentityKey(updated, input.env, true);
        }
        if (JSON.stringify(updated) !== JSON.stringify(existing)) {
            saveAgentIdentity(updated, input.cwd, input.preferredDirName);
        }
        return updated;
    }
    let created = {
        schema_version: 2,
        version: 1,
        agent_id: generateAgentId(),
        agent_name: input.agentName.trim(),
        created_at: nowISO(),
        kind: input.kind ?? 'unknown',
        trust_level: input.trustLevel ?? 'contributor',
        capabilities: normalizedCapabilities,
    };
    if (input.generateFingerprint) {
        created = withIdentityKey(created, input.env, true);
    }
    saveAgentIdentity(created, input.cwd, input.preferredDirName);
    return created;
}
export function resolveCurrentAgentIdentity(cwd, preferredDirName) {
    // env var takes priority over config — allows AI agent to self-identify
    const envAgentId = (process.env.BRAINCLAW_AGENT_ID ?? '').trim();
    const envAgentName = (process.env.BRAINCLAW_AGENT_NAME ?? process.env.BRAINCLAW_AGENT ?? '').trim();
    if (envAgentId) {
        const byEnvId = findAgentIdentityById(envAgentId, cwd, preferredDirName);
        if (byEnvId)
            return byEnvId;
    }
    if (envAgentName) {
        const byEnvName = findAgentIdentityByName(envAgentName, cwd, preferredDirName);
        if (byEnvName)
            return byEnvName;
    }
    // Auto-detect from native agent env vars (e.g. CLAUDECODE, CURSOR_TRACE_ID).
    // Falls through to config if the detected agent is not registered.
    const detected = detectAiAgent();
    if (detected) {
        const byDetected = findAgentIdentityByName(detected.name, cwd, preferredDirName);
        if (byDetected)
            return byDetected;
    }
    // Config fallback (last resort — may not reflect the actual calling agent)
    const config = loadConfig(cwd, preferredDirName);
    if (config.current_agent_id) {
        const byId = findAgentIdentityById(config.current_agent_id, cwd, preferredDirName);
        if (byId) {
            return byId;
        }
    }
    if (config.current_agent) {
        return findAgentIdentityByName(config.current_agent, cwd, preferredDirName);
    }
    return undefined;
}
export function resolveRegisteredAgentIdentity(options = {}) {
    const agentId = options.agentId?.trim();
    const agentName = options.agentName?.trim();
    const cwd = options.cwd;
    const preferredDirName = options.preferredDirName;
    const env = options.env ?? process.env;
    if (agentId && agentName) {
        const byId = findAgentIdentityById(agentId, cwd, preferredDirName);
        if (!byId) {
            return undefined;
        }
        if (normalizeAgentName(byId.agent_name) !== normalizeAgentName(agentName)) {
            throw new AgentIdentityResolutionError(`Agent '${agentName}' does not match registered id '${agentId}'.`, { agent_id: agentId, agent_name: agentName });
        }
        return byId;
    }
    if (agentId) {
        return findAgentIdentityById(agentId, cwd, preferredDirName);
    }
    if (agentName) {
        return findAgentIdentityByName(agentName, cwd, preferredDirName);
    }
    if (options.allowCurrent !== false) {
        const current = resolveCurrentAgentIdentity(cwd, preferredDirName);
        if (current) {
            return current;
        }
    }
    if (options.allowEnv !== false) {
        const envAgent = resolveEnvAgentName(env);
        if (envAgent) {
            return findAgentIdentityByName(envAgent, cwd, preferredDirName);
        }
    }
    return undefined;
}
export function requireRegisteredAgentIdentity(options = {}) {
    const agentId = options.agentId?.trim();
    const agentName = options.agentName?.trim();
    const cwd = options.cwd;
    const preferredDirName = options.preferredDirName;
    const env = options.env ?? process.env;
    if (agentId && agentName) {
        const resolved = resolveRegisteredAgentIdentity(options);
        if (!resolved) {
            throw new AgentIdentityResolutionError(`Registered agent '${agentName}' [${agentId}] not found.`, { agent_id: agentId, agent_name: agentName });
        }
        return resolved;
    }
    if (agentId) {
        const resolved = findAgentIdentityById(agentId, cwd, preferredDirName);
        if (!resolved) {
            throw new AgentIdentityResolutionError(`Registered agent id '${agentId}' not found.`, { agent_id: agentId });
        }
        return resolved;
    }
    if (agentName) {
        const resolved = findAgentIdentityByName(agentName, cwd, preferredDirName);
        if (!resolved) {
            throw new AgentIdentityResolutionError(`Agent '${agentName}' is not registered. Run \`brainclaw register-agent ${agentName}\`.`, { agent_name: agentName });
        }
        return resolved;
    }
    const current = options.allowCurrent !== false
        ? resolveCurrentAgentIdentity(cwd, preferredDirName)
        : undefined;
    if (current) {
        return current;
    }
    if (options.allowEnv !== false) {
        const envAgent = resolveEnvAgentName(env);
        if (envAgent) {
            const resolved = findAgentIdentityByName(envAgent, cwd, preferredDirName);
            if (!resolved) {
                throw new AgentIdentityResolutionError(`Environment agent '${envAgent}' is not registered.`, { agent_name: envAgent });
            }
            return resolved;
        }
    }
    throw new AgentIdentityResolutionError('No registered agent identity resolved. Use --agent/--agent-id or configure a current agent with `brainclaw register-agent <name> --set-current`.');
}
export function resolveAgentScope(agentName, cwd, preferredDirName) {
    const explicit = agentName?.trim();
    if (explicit) {
        return explicit;
    }
    return loadConfig(cwd, preferredDirName).current_agent?.trim() || undefined;
}
/**
 * Returns the current model identifier if declared, from:
 *  1. $BRAINCLAW_MODEL env var  (explicit per-session declaration)
 *  2. registered agent document model field
 *  3. undefined (not tracked)
 */
export function resolveCurrentModel(cwd) {
    const fromEnv = process.env.BRAINCLAW_MODEL?.trim();
    if (fromEnv)
        return fromEnv;
    const identity = resolveCurrentAgentIdentity(cwd);
    return identity?.model;
}
/**
 * Returns the name of the current agent, with priority:
 *  1. $BRAINCLAW_AGENT_NAME env var  (AI agent self-declaration)
 *  2. $BRAINCLAW_AGENT      env var  (legacy alias)
 *  3. config.current_agent           (project owner / human default)
 *  4. OS user                        (last-resort fallback)
 */
export function resolveCurrentAgentName(cwd) {
    const fromEnv = (process.env.BRAINCLAW_AGENT_NAME ?? process.env.BRAINCLAW_AGENT)?.trim();
    if (fromEnv)
        return fromEnv;
    const fromConfig = loadConfig(cwd).current_agent?.trim();
    if (fromConfig)
        return fromConfig;
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}
export function requireOperationalAgentIdentity(agentName, cwd, preferredDirName) {
    return requireRegisteredAgentIdentity({
        agentName,
        cwd,
        preferredDirName,
        allowCurrent: true,
        allowEnv: true,
    });
}
export function resolveExistingCurrentAgent(cwd) {
    for (const dirName of [MEMORY_DIR]) {
        try {
            const config = loadConfig(cwd, dirName);
            if (config.current_agent_id) {
                const byId = findAgentIdentityById(config.current_agent_id, cwd, dirName);
                if (byId) {
                    return byId;
                }
            }
            if (config.current_agent) {
                const byName = findAgentIdentityByName(config.current_agent, cwd, dirName);
                if (byName) {
                    return byName;
                }
            }
        }
        catch (err) {
            logger.debug('Ignoring missing or malformed config while searching for current agent:', err);
        }
    }
    return undefined;
}
export function setCurrentAgentIdentity(agent, cwd, preferredDirName) {
    const config = loadConfig(cwd, preferredDirName);
    config.current_agent = agent.agent_name;
    config.current_agent_id = agent.agent_id;
    saveConfig(config, cwd, preferredDirName);
}
export function hasElevatedAgent(cwd) {
    return listAgentIdentities(cwd).some((agent) => agent.trust_level === 'trusted' || agent.trust_level === 'curator');
}
export function hasMinimumTrustLevel(level, required) {
    return TRUST_ORDER.indexOf(level) >= TRUST_ORDER.indexOf(required);
}
export function requireMinimumTrustLevel(identity, required) {
    const current = identity.trust_level ?? 'contributor';
    if (!hasMinimumTrustLevel(current, required)) {
        throw new AgentTrustError(`Insufficient trust: agent '${identity.agent_name}' has level '${current}', '${required}' required.`, {
            agent_id: identity.agent_id,
            agent_name: identity.agent_name,
            current_level: current,
            required_level: required,
        });
    }
}
export function setAgentTrustLevel(agentNameOrId, level, cwd) {
    const agent = findAgentIdentityByName(agentNameOrId, cwd) ?? findAgentIdentityById(agentNameOrId, cwd);
    if (!agent) {
        throw new Error(`Agent '${agentNameOrId}' not found. Register first with \`brainclaw register-agent\`.`);
    }
    const updated = { ...agent, trust_level: level };
    saveAgentIdentity(updated, cwd);
    return updated;
}
export function getAgentTrustLevel(agentNameOrId, cwd) {
    const byName = findAgentIdentityByName(agentNameOrId, cwd);
    if (byName)
        return byName.trust_level ?? 'contributor';
    const byId = findAgentIdentityById(agentNameOrId, cwd);
    return byId?.trust_level ?? 'contributor';
}
export function agentCanWriteDirect(agentNameOrId, cwd) {
    if (!agentNameOrId)
        return false;
    const level = getAgentTrustLevel(agentNameOrId, cwd);
    return level === 'trusted' || level === 'curator';
}
export function agentCanCurate(agentNameOrId, cwd) {
    if (!agentNameOrId)
        return false;
    const level = getAgentTrustLevel(agentNameOrId, cwd);
    return level === 'curator';
}
//# sourceMappingURL=agent-registry.js.map