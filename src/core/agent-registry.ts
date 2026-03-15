import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { nowISO } from './ids.js';
import { MEMORY_DIR, memoryDir } from './io.js';
import { JsonStore } from './json-store.js';
import { AgentIdentityDocumentSchema, type AgentIdentityDocument, type AgentKind, type AgentTrustLevel } from './schema.js';
import { logger } from './logger.js';

const AGENTS_DIR = 'agents';

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
  return path.join(memoryDir(cwd, preferredDirName), AGENTS_DIR);
}

function agentIdentityPath(agentId: string, cwd?: string, preferredDirName?: string): string {
  return path.join(agentsDir(cwd, preferredDirName), `${agentId}.json`);
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

function normalizeAgentName(agentName: string): string {
  return agentName.trim().toLowerCase();
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

export function registerAgentIdentity(input: {
  agentName: string;
  kind?: AgentKind;
  cwd?: string;
  preferredDirName?: string;
}): AgentIdentityDocument {
  const existing = findAgentIdentityByName(input.agentName, input.cwd, input.preferredDirName);
  if (existing) {
    if (input.kind && existing.kind !== input.kind) {
      const updated: AgentIdentityDocument = { ...existing, kind: input.kind };
      saveAgentIdentity(updated, input.cwd, input.preferredDirName);
      return updated;
    }
    return existing;
  }

  const created: AgentIdentityDocument = {
    schema_version: 2,
    version: 1,
    agent_id: generateAgentId(),
    agent_name: input.agentName.trim(),
    created_at: nowISO(),
    kind: input.kind ?? 'unknown',
    trust_level: 'contributor',
    capabilities: [],
  };
  saveAgentIdentity(created, input.cwd, input.preferredDirName);
  return created;
}

export function resolveCurrentAgentIdentity(cwd?: string, preferredDirName?: string): AgentIdentityDocument | undefined {
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

export function resolveAgentScope(agentName?: string, cwd?: string, preferredDirName?: string): string | undefined {
  const explicit = agentName?.trim();
  if (explicit) {
    return explicit;
  }

  return loadConfig(cwd, preferredDirName).current_agent?.trim() || undefined;
}

export function requireOperationalAgentIdentity(agentName?: string, cwd?: string, preferredDirName?: string): AgentIdentityDocument {
  const explicit = agentName?.trim();
  if (explicit) {
    return registerAgentIdentity({
      agentName: explicit,
      kind: 'unknown',
      cwd,
      preferredDirName,
    });
  }

  const current = resolveCurrentAgentIdentity(cwd, preferredDirName);
  if (current) {
    return current;
  }

  throw new Error('No current agent configured. Use --agent or run `brainclaw register-agent <name> --set-current`.');
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

export function setAgentTrustLevel(agentName: string, level: AgentTrustLevel, cwd?: string): AgentIdentityDocument {
  const agent = findAgentIdentityByName(agentName, cwd);
  if (!agent) {
    throw new Error(`Agent '${agentName}' not found. Register first with \`brainclaw register-agent\`.`);
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
