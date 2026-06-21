import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isKnownAgent, getCapabilityProfile, resolveAgentAlias } from './agent-capability.js';
import { isAgentInstalledPerInventory } from './agent-inventory.js';
import { detectAiAgent } from './ai-agent-detection.js';
import { loadConfig, saveConfig } from './config.js';
import { nowISO } from './ids.js';
import { MEMORY_DIR, memoryExists, resolveEntityDir } from './io.js';
import { JsonStore } from './json-store.js';
import {
  AgentIdentityDocumentSchema,
  type AgentIdentityDocument,
  type AgentKind,
  type AgentTrustLevel,
} from './schema.js';
import { logger } from './logger.js';
import { isObserverMode } from './observer-mode.js';

// agents/ stays at top level in entity model (already entity-aligned)
const TRUST_ORDER: AgentTrustLevel[] = ['observer', 'contributor', 'trusted', 'curator'];

export class AgentIdentityResolutionError extends Error {
  readonly kind = 'identity_error';
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

export class AgentTrustError extends Error {
  readonly kind = 'trust_error';
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

export interface RegisterAgentIdentityInput {
  agentName: string;
  kind?: AgentKind;
  trustLevel?: AgentTrustLevel;
  contextProfile?: string;
  capabilities?: string[];
  replaceCapabilities?: boolean;
  generateFingerprint?: boolean;
  cwd?: string;
  preferredDirName?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RegisteredAgentIdentityOptions {
  agentName?: string;
  agentId?: string;
  cwd?: string;
  preferredDirName?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  allowCurrent?: boolean;
  allowEnv?: boolean;
}

export function generateAgentId(): string {
  return `agt_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function resolveDefaultAgentName(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRAINCLAW_AGENT?.trim()
    || env.OPENCLAW_AGENT?.trim()
    || env.USERNAME?.trim()
    || env.USER?.trim()
    || 'unknown-agent';
}

function agentsDir(cwd?: string, preferredDirName?: string): string {
  return resolveEntityDir('agents', cwd ?? process.cwd(), 'read', preferredDirName);
}

function ensureAgentsDir(cwd?: string, preferredDirName?: string): void {
  const dir = agentsDir(cwd, preferredDirName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function agentStore(cwd?: string, preferredDirName?: string): JsonStore<AgentIdentityDocument> {
  return new JsonStore<AgentIdentityDocument>({
    dirPath: agentsDir(cwd, preferredDirName),
    documentType: 'agent_identity',
    getId: (agent) => agent.agent_id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at) || a.agent_name.localeCompare(b.agent_name),
  });
}

/**
 * Canonical agent name: lowercased, trimmed, and alias-resolved at the
 * registry level (pln#562 step 2) — 'copilot' and 'github-copilot' are ONE
 * identity, not two. All registry lookups and writes go through this.
 */
export function normalizeAgentName(agentName: string): string {
  return resolveAgentAlias(agentName.trim().toLowerCase());
}

function normalizeCapability(capability: string): string | undefined {
  const normalized = capability.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeCapabilities(capabilities: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
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

function mergeCapabilities(existing: string[], next: string[]): string[] {
  return normalizeCapabilities([...existing, ...next]);
}

function resolveEnvAgentName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.BRAINCLAW_AGENT?.trim() || env.OPENCLAW_AGENT?.trim();
  return value && value.length > 0 ? value : undefined;
}

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CODEX_HOME?.trim();
  return explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), '.codex');
}

/**
 * ed25519 identity keys (pln#562 step 5).
 *
 * RESERVED for the federated identity model — these keys are not consumed by
 * any verification path today; the identity proposal (origin signing)
 * activates them. Do NOT delete them as debris.
 *
 * Private keys live under the NEUTRAL brainclaw home (~/.brainclaw/keys/),
 * not under ~/.codex/: agent identity belongs to brainclaw, and parking
 * private key material inside another vendor's config directory both
 * misattributes it and exposes it to that vendor's tooling/sync.
 */
function agentKeyPath(agentId: string): string {
  return path.join(os.homedir(), MEMORY_DIR, 'keys', `${agentId}.ed25519.pem`);
}

/** Pre-step-5 location (inside CODEX_HOME) — read for one-time migration. */
function legacyAgentKeyPath(agentId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codexHome(env), 'brainclaw', 'keys', `${agentId}.ed25519.pem`);
}

/**
 * Move a key file from the legacy ~/.codex location to the neutral path.
 * Best-effort: a failed unlink leaves a duplicate, never a missing key.
 */
function migrateLegacyAgentKey(agentId: string, env: NodeJS.ProcessEnv = process.env): void {
  const legacy = legacyAgentKeyPath(agentId, env);
  const target = agentKeyPath(agentId);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    ensureParentDir(target);
    fs.copyFileSync(legacy, target);
    try { fs.unlinkSync(legacy); } catch { /* duplicate is safe */ }
    logger.debug(`Migrated agent identity key ${agentId} from ${legacy} to ${target}`);
  } catch (err) {
    logger.debug('Failed to migrate legacy agent key:', err);
  }
}

function ensureParentDir(filepath: string): void {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function fingerprintPublicKey(publicKey: string): string {
  return crypto.createHash('sha256').update(publicKey).digest('hex');
}

function buildIdentityKey(agentId: string, env: NodeJS.ProcessEnv = process.env, forceRegenerate: boolean = false): AgentIdentityDocument['identity_key'] {
  migrateLegacyAgentKey(agentId, env);
  const filepath = agentKeyPath(agentId);
  const createdAt = nowISO();

  let publicKeyPem: string;
  if (!forceRegenerate && fs.existsSync(filepath)) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(filepath, 'utf-8'));
    publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  } else {
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

function withIdentityKey(
  agent: AgentIdentityDocument,
  env: NodeJS.ProcessEnv = process.env,
  forceRegenerate: boolean = false,
): AgentIdentityDocument {
  return {
    ...agent,
    identity_key: buildIdentityKey(agent.agent_id, env, forceRegenerate),
  };
}

export function loadAgentIdentity(agentId: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument {
  return agentStore(cwd, preferredDirName).load(agentId);
}

export function saveAgentIdentity(agent: AgentIdentityDocument, cwd?: string, preferredDirName?: string): void {
  ensureAgentsDir(cwd, preferredDirName);
  agentStore(cwd, preferredDirName).save(AgentIdentityDocumentSchema.parse(agent));
}

export function listAgentIdentities(cwd?: string, preferredDirName?: string): AgentIdentityDocument[] {
  return agentStore(cwd, preferredDirName).list();
}

export function findAgentIdentityByName(agentName: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument | undefined {
  const normalized = normalizeAgentName(agentName);
  return listAgentIdentities(cwd, preferredDirName).find((agent) => normalizeAgentName(agent.agent_name) === normalized);
}

export function findAgentIdentityById(agentId: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument | undefined {
  try {
    return loadAgentIdentity(agentId, cwd, preferredDirName);
  } catch (err) {
    logger.debug('Failed to find agent identity by ID:', agentId, err);
    return undefined;
  }
}

export function registerAgentIdentity(input: RegisterAgentIdentityInput): AgentIdentityDocument {
  const normalizedCapabilities = normalizeCapabilities(input.capabilities);
  const existing = findAgentIdentityByName(input.agentName, input.cwd, input.preferredDirName);

  // Observer mode (BRAINCLAW_OBSERVER=1) refuses to mint or mutate identity
  // on the disk. A dashboard is not an agent — it must never auto-register
  // (the 2026-06-10 leak where the VS Code extension impersonated whichever
  // shell-parent agent VS Code was launched from). Return existing read-only,
  // or a transient synthetic identity that callers can use without persisting.
  if (isObserverMode()) {
    if (existing) return existing;
    const normalizedNewName = normalizeAgentName(input.agentName);
    return {
      schema_version: 2,
      version: 1,
      agent_id: generateAgentId(),
      agent_name: normalizedNewName,
      created_at: nowISO(),
      kind: input.kind ?? 'unknown',
      trust_level: input.trustLevel ?? 'observer',
      capabilities: normalizedCapabilities,
      ...(input.contextProfile ? { context_profile: input.contextProfile as AgentIdentityDocument['context_profile'] } : {}),
    };
  }

  if (existing) {
    let updated: AgentIdentityDocument = existing;
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
    } else if (normalizedCapabilities.length > 0) {
      updated = { ...updated, capabilities: mergeCapabilities(existing.capabilities ?? [], normalizedCapabilities) };
    }
    if (input.contextProfile && existing.context_profile !== input.contextProfile) {
      updated = { ...updated, context_profile: input.contextProfile as AgentIdentityDocument['context_profile'] };
    }
    if (input.generateFingerprint) {
      updated = withIdentityKey(updated, input.env, true);
    }
    if (JSON.stringify(updated) !== JSON.stringify(existing)) {
      saveAgentIdentity(updated, input.cwd, input.preferredDirName);
    }
    return updated;
  }

  // Identity hardening (pln#562 step 1): a NEW identity claiming the name of
  // an agent the inventory knows is NOT installed on this machine is suspect.
  // Warn (the inventory is consultative) — it never blocks or mints identity.
  const normalizedNewName = normalizeAgentName(input.agentName);
  try {
    if (isAgentInstalledPerInventory(normalizedNewName) === false) {
      logger.warn(
        `Registering identity '${normalizedNewName}' but the agent inventory reports it is not installed on this machine. `
        + 'Verify the claimed identity or refresh the inventory.',
      );
    }
  } catch { /* inventory consultation is best-effort */ }

  let created: AgentIdentityDocument = {
    schema_version: 2,
    version: 1,
    agent_id: generateAgentId(),
    agent_name: normalizedNewName,
    created_at: nowISO(),
    kind: input.kind ?? 'unknown',
    trust_level: input.trustLevel ?? 'contributor',
    capabilities: normalizedCapabilities,
    ...(input.contextProfile ? { context_profile: input.contextProfile as AgentIdentityDocument['context_profile'] } : {}),
  };
  if (input.generateFingerprint) {
    created = withIdentityKey(created, input.env, true);
  }
  saveAgentIdentity(created, input.cwd, input.preferredDirName);
  return created;
}

export function resolveCurrentAgentIdentity(cwd?: string, preferredDirName?: string, _homeDir?: string): AgentIdentityDocument | undefined {
  // env var takes priority over config — allows AI agent to self-identify
  const envAgentId = (process.env.BRAINCLAW_AGENT_ID ?? '').trim();
  const envAgentName = (process.env.BRAINCLAW_AGENT_NAME ?? process.env.BRAINCLAW_AGENT ?? '').trim();
  if (envAgentId) {
    const byEnvId = findAgentIdentityById(envAgentId, cwd, preferredDirName);
    if (byEnvId) return byEnvId;
  }
  if (envAgentName) {
    const byEnvName = findAgentIdentityByName(envAgentName, cwd, preferredDirName);
    if (byEnvName) return byEnvName;
  }

  // Auto-detect from native agent env vars (e.g. CLAUDECODE, CURSOR_TRACE_ID, CODEX_THREAD_ID).
  // This is the primary identification path for MCP servers and CLI hooks.
  //
  // pln#562 step 2 — registration is an EXPLICIT act (setup selection, session
  // start, dispatcher spawn). Resolution is a read path and must never mint an
  // identity as a side effect; a detected-but-unregistered agent resolves to
  // undefined and the caller decides whether to register explicitly.
  const detected = detectAiAgent(process.env);
  if (detected) {
    // If the detected name matches an explicit env var that was already tried
    // and not found, the caller expects a "not registered" error.
    if (normalizeAgentName(detected.name) === normalizeAgentName(envAgentName)) {
      return undefined;
    }

    const byDetected = findAgentIdentityByName(detected.name, cwd, preferredDirName);
    if (byDetected) return byDetected;

    logger.debug(
      `Detected agent '${detected.name}' is not registered; read-path resolution does not auto-register `
      + '(register via setup, session start, or dispatch).',
    );
  }

  // config.current_agent is NOT used for identity resolution — it's a singleton global
  // that gets overwritten by whichever agent last ran register-agent --set-current.
  // In multi-agent setups this always resolves to the wrong agent.
  // The field remains in config for display (status, doctor) and for resolveExistingCurrentAgent
  // which is used during setup/init only.

  return undefined;
}

export function resolveRegisteredAgentIdentity(options: RegisteredAgentIdentityOptions = {}): AgentIdentityDocument | undefined {
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
      throw new AgentIdentityResolutionError(
        `Agent '${agentName}' does not match registered id '${agentId}'.`,
        { agent_id: agentId, agent_name: agentName },
      );
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

export function requireRegisteredAgentIdentity(options: RegisteredAgentIdentityOptions = {}): AgentIdentityDocument {
  const agentId = options.agentId?.trim();
  const agentName = options.agentName?.trim();
  const cwd = options.cwd;
  const preferredDirName = options.preferredDirName;
  const env = options.env ?? process.env;

  if (agentId && agentName) {
    const resolved = resolveRegisteredAgentIdentity(options);
    if (!resolved) {
      throw new AgentIdentityResolutionError(
        `Registered agent '${agentName}' [${agentId}] not found.`,
        { agent_id: agentId, agent_name: agentName },
      );
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
    if (resolved) return resolved;

    // Auto-register if the agent is a known brainclaw-supported agent or declared in agent_integrations
    const normalizedName = normalizeAgentName(agentName);
    if (isKnownAgent(normalizedName) || isAgentDeclaredInIntegrations(normalizedName, cwd)) {
      const autoRegistered = registerAgentIdentity({
        agentName: normalizedName,
        kind: 'agent',
        trustLevel: 'contributor',
        cwd,
        preferredDirName,
      });
      return autoRegistered;
    }

    throw new AgentIdentityResolutionError(
      `Agent '${normalizedName}' is not registered. Run \`brainclaw register-agent ${normalizedName}\`.`,
      { agent_name: normalizedName },
    );
  }

  const current = options.allowCurrent !== false
    ? resolveCurrentAgentIdentity(cwd, preferredDirName, options.homeDir)
    : undefined;
  if (current) {
    return current;
  }

  if (options.allowEnv !== false) {
    const envAgent = resolveEnvAgentName(env);
    if (envAgent) {
      const resolved = findAgentIdentityByName(envAgent, cwd, preferredDirName);
      if (resolved) return resolved;

      // Auto-register env-declared agent if known or declared in agent_integrations
      const normalizedEnv = normalizeAgentName(envAgent);
      if (isKnownAgent(normalizedEnv) || isAgentDeclaredInIntegrations(normalizedEnv, cwd)) {
        return registerAgentIdentity({
          agentName: normalizedEnv,
          kind: 'agent',
          trustLevel: 'contributor',
          cwd,
          preferredDirName,
        });
      }

      throw new AgentIdentityResolutionError(
        `Environment agent '${normalizedEnv}' is not registered.`,
        { agent_name: normalizedEnv },
      );
    }
  }

  throw new AgentIdentityResolutionError(
    'No registered agent identity resolved. Use --agent/--agent-id or configure a current agent with `brainclaw register-agent <name> --set-current`.',
  );
}

/**
 * Resolve agent identity for session start, returning both the resolved identity and whether
 * it was auto-registered (did not exist before this call).
 *
 * Unlike `requireRegisteredAgentIdentity`, this never throws for unknown agents — it will
 * auto-register any resolvable name (from args or env) with contributor trust level.
 * This implements the "separate known agent from current agent" principle: starting a session
 * never requires prior registration.
 *
 * Throws only when no agent name can be derived at all.
 */
export function resolveOrAutoRegisterAgentIdentity(
  options: RegisteredAgentIdentityOptions = {},
): { identity: AgentIdentityDocument; auto_registered: boolean } {
  const existingBefore = resolveRegisteredAgentIdentity(options);

  try {
    const identity = requireRegisteredAgentIdentity(options);
    return { identity, auto_registered: !existingBefore };
  } catch (err) {
    if (!(err instanceof AgentIdentityResolutionError)) throw err;

    // Last-resort: derive a name from explicit arg, env, or runtime detection
    // and auto-register. Session start is an EXPLICIT act (pln#562 step 2), so
    // it is allowed to register — unlike read-path resolution, which is not.
    const candidateName = options.agentName?.trim()
      || (options.allowEnv !== false ? resolveEnvAgentName(options.env ?? process.env) : undefined)
      || detectAiAgent(options.env ?? process.env)?.name;
    if (!candidateName) throw err;

    const normalizedName = normalizeAgentName(candidateName);
    const registered = registerAgentIdentity({
      agentName: normalizedName,
      kind: 'agent',
      trustLevel: 'contributor',
      cwd: options.cwd,
      preferredDirName: options.preferredDirName,
    });
    return { identity: registered, auto_registered: true };
  }
}

/**
 * Ensure that a target agent is registered in the current project before dispatch.
 *
 * If the agent is already registered, returns the existing identity.
 * If not registered but has a known capability profile with canBeSpawnedCli=true,
 * auto-registers it as a contributor agent with source='dispatch-auto-register'.
 *
 * Returns the identity, or undefined if the agent is unknown/not spawnable.
 */
export function ensureAgentRegisteredForDispatch(
  agentName: string,
  cwd?: string,
): AgentIdentityDocument | undefined {
  const normalized = normalizeAgentName(agentName);

  // Already registered? Return as-is.
  const existing = findAgentIdentityByName(normalized, cwd);
  if (existing) return existing;

  // Check capability profile — only auto-register agents we know about
  const profile = getCapabilityProfile(normalized);
  if (!profile || !profile.runtime.canBeSpawnedCli) return undefined;

  // Auto-register with contributor trust
  try {
    const registered = registerAgentIdentity({
      agentName: normalized,
      kind: 'agent',
      trustLevel: 'contributor',
      capabilities: profile.role_capabilities ?? [],
      cwd,
    });
    logger.debug(`Auto-registered agent for dispatch: ${normalized} (${registered.agent_id})`);
    return registered;
  } catch {
    // Non-fatal: store may be read-only
    return undefined;
  }
}

/**
 * Check whether an agent name is declared in the project's agent_integrations config.
 */
function isAgentDeclaredInIntegrations(normalizedName: string, cwd?: string): boolean {
  if (!memoryExists(cwd)) return false;
  try {
    const cfg = loadConfig(cwd);
    return (cfg.agent_integrations?.declarations ?? []).some(
      (d) => normalizeAgentName(d.agent_name) === normalizedName,
    );
  } catch {
    return false;
  }
}

export function resolveAgentScope(agentName?: string, cwd?: string, preferredDirName?: string): string | undefined {
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
export function resolveCurrentModel(cwd?: string): string | undefined {
  const fromEnv = process.env.BRAINCLAW_MODEL?.trim();
  if (fromEnv) return fromEnv;
  const identity = resolveCurrentAgentIdentity(cwd);
  return identity?.model;
}

/**
 * Returns the name of the current agent, with priority:
 *  1. $BRAINCLAW_AGENT_NAME env var  (AI agent self-declaration)
 *  2. $BRAINCLAW_AGENT      env var  (legacy alias / relay model)
 *  3. detectAiAgent()                (auto-detection from process env vars)
 *  4. OS user                        (last-resort fallback)
 *
 * Note: config.current_agent is intentionally NOT used here — it's a singleton
 * global that causes cross-agent confusion in multi-agent setups.
 */
export function resolveCurrentAgentName(_cwd?: string, _homeDir?: string): string {
  const fromEnv = (process.env.BRAINCLAW_AGENT_NAME ?? process.env.BRAINCLAW_AGENT)?.trim();
  if (fromEnv) return fromEnv;
  const detected = detectAiAgent(process.env);
  if (detected) return detected.name;
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}

export function requireOperationalAgentIdentity(agentName?: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument {
  return requireRegisteredAgentIdentity({
    agentName,
    cwd,
    preferredDirName,
    allowCurrent: true,
    allowEnv: true,
  });
}

export function resolveExistingCurrentAgent(cwd?: string): AgentIdentityDocument | undefined {
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
    } catch (err) {
      logger.debug('Ignoring missing or malformed config while searching for current agent:', err);
    }
  }

  return undefined;
}

export function setCurrentAgentIdentity(agent: AgentIdentityDocument, cwd?: string, preferredDirName?: string): void {
  const config = loadConfig(cwd, preferredDirName);
  config.current_agent = agent.agent_name;
  config.current_agent_id = agent.agent_id;
  saveConfig(config, cwd, preferredDirName);
}

export function hasElevatedAgent(cwd?: string): boolean {
  return listAgentIdentities(cwd).some((agent) => agent.trust_level === 'trusted' || agent.trust_level === 'curator');
}

export function hasMinimumTrustLevel(level: AgentTrustLevel, required: AgentTrustLevel): boolean {
  return TRUST_ORDER.indexOf(level) >= TRUST_ORDER.indexOf(required);
}

export function requireMinimumTrustLevel(identity: AgentIdentityDocument, required: AgentTrustLevel): void {
  const current = identity.trust_level ?? 'contributor';
  if (!hasMinimumTrustLevel(current, required)) {
    throw new AgentTrustError(
      `Insufficient trust: agent '${identity.agent_name}' has level '${current}', '${required}' required.`,
      {
        agent_id: identity.agent_id,
        agent_name: identity.agent_name,
        current_level: current,
        required_level: required,
      },
    );
  }
}

export function setAgentTrustLevel(agentNameOrId: string, level: AgentTrustLevel, cwd?: string): AgentIdentityDocument {
  const agent = findAgentIdentityByName(agentNameOrId, cwd) ?? findAgentIdentityById(agentNameOrId, cwd);
  if (!agent) {
    throw new Error(`Agent '${agentNameOrId}' not found. Register first with \`brainclaw register-agent\`.`);
  }
  const updated: AgentIdentityDocument = { ...agent, trust_level: level };
  saveAgentIdentity(updated, cwd);
  return updated;
}

export function getAgentTrustLevel(agentNameOrId: string, cwd?: string): AgentTrustLevel {
  const byName = findAgentIdentityByName(agentNameOrId, cwd);
  if (byName) return byName.trust_level ?? 'contributor';
  const byId = findAgentIdentityById(agentNameOrId, cwd);
  return byId?.trust_level ?? 'contributor';
}

export function agentCanWriteDirect(agentNameOrId?: string, cwd?: string): boolean {
  if (!agentNameOrId) return false;
  const level = getAgentTrustLevel(agentNameOrId, cwd);
  return level === 'trusted' || level === 'curator';
}

export function agentCanCurate(agentNameOrId?: string, cwd?: string): boolean {
  if (!agentNameOrId) return false;
  const level = getAgentTrustLevel(agentNameOrId, cwd);
  return level === 'curator';
}

// ── Debris identity cleanup (pln#562 step 2) ────────────────────────────────

/**
 * Identity names known to be registration debris: test fixtures and
 * model-as-identity artifacts that leaked into real stores through the old
 * permissive auto-registration paths.
 */
export const DEBRIS_AGENT_NAMES: readonly string[] = ['testuser', 'contributor-bot', 'claude-sonnet'];

export interface DebrisAgentIdentity {
  identity: AgentIdentityDocument;
  reason: string;
}

/**
 * List identities that look like registration debris:
 *  - names on the known-debris list (test fixtures, model-as-identity)
 *  - identities stored under an alias of a canonical agent name (e.g. a
 *    'copilot' document now shadowed by the registry-level alias merge)
 *
 * Read-only — cleanup is a separate, guarded act (removeAgentIdentity).
 */
export function listDebrisAgentIdentities(cwd?: string, preferredDirName?: string): DebrisAgentIdentity[] {
  const debris: DebrisAgentIdentity[] = [];
  for (const identity of listAgentIdentities(cwd, preferredDirName)) {
    const stored = identity.agent_name.trim().toLowerCase();
    if (DEBRIS_AGENT_NAMES.includes(stored)) {
      debris.push({ identity, reason: `'${stored}' is a known debris identity name` });
      continue;
    }
    const canonical = resolveAgentAlias(stored);
    if (canonical !== stored) {
      debris.push({
        identity,
        reason: `'${stored}' is an alias of '${canonical}' — superseded by the registry-level alias merge`,
      });
    }
  }
  return debris;
}

/**
 * Remove a registered agent identity — guarded, never silent.
 *
 * Refuses unless the identity is flagged as debris (listDebrisAgentIdentities)
 * or the caller passes force:true. Curator identities are never removed
 * without force. Returns the removed document so callers can report exactly
 * what was deleted.
 */
export function removeAgentIdentity(
  agentNameOrId: string,
  options: { cwd?: string; preferredDirName?: string; force?: boolean } = {},
): AgentIdentityDocument {
  const { cwd, preferredDirName, force } = options;
  const identity = findAgentIdentityById(agentNameOrId, cwd, preferredDirName)
    ?? findAgentIdentityByName(agentNameOrId, cwd, preferredDirName)
    // Alias-debris docs are unreachable via normalized name lookup — match the raw stored name.
    ?? listAgentIdentities(cwd, preferredDirName).find(
      (a) => a.agent_name.trim().toLowerCase() === agentNameOrId.trim().toLowerCase(),
    );
  if (!identity) {
    throw new AgentIdentityResolutionError(`Agent '${agentNameOrId}' not found.`, { agent_name: agentNameOrId });
  }

  if (!force) {
    if (identity.trust_level === 'curator') {
      throw new AgentTrustError(
        `Refusing to remove curator identity '${identity.agent_name}' without force.`,
        { agent_id: identity.agent_id, agent_name: identity.agent_name },
      );
    }
    const isDebris = listDebrisAgentIdentities(cwd, preferredDirName)
      .some((d) => d.identity.agent_id === identity.agent_id);
    if (!isDebris) {
      throw new AgentIdentityResolutionError(
        `Refusing to remove '${identity.agent_name}': not a known debris identity. Pass force to override.`,
        { agent_id: identity.agent_id, agent_name: identity.agent_name },
      );
    }
  }

  agentStore(cwd, preferredDirName).delete(identity.agent_id);
  logger.debug(`Removed agent identity ${identity.agent_name} (${identity.agent_id})`);
  return identity;
}
