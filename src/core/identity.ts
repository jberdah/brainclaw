import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAiAgent } from './ai-agent-detection.js';
import { requireRegisteredAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { memoryDir, entityRecordDirs, entityRecordPaths, ENTITY_DIR_MAP } from './io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { CurrentSessionStateSchema, type CurrentSessionState } from './schema.js';

export interface OperationalIdentity {
  agent: string;
  agent_id: string;
  project_id?: string;
  host_id: string;
  session_id?: string;
}

export interface SessionResolutionOptions {
  agentName?: string;
  agentId?: string;
  hostId?: string;
  preferredSessionId?: string;
  persistImplicit?: boolean;
}

export interface OperationalIdentityOptions {
  agentId?: string;
  sessionId?: string;
  persistImplicitSession?: boolean;
}

const SESSIONS_DIR = 'sessions';
const LEGACY_SESSION_FILE = '.current-session';

// --- Public API ---

export function resolveCurrentSessionId(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  options: SessionResolutionOptions = {},
): string | undefined {
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

export function buildOperationalIdentity(
  agentName?: string,
  cwd?: string,
  options: OperationalIdentityOptions = {},
): OperationalIdentity {
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

export function resolveEventSessionId(event: { session_id?: string; metadata?: Record<string, unknown> | undefined }): string | undefined {
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
export function loadCurrentSession(cwd?: string): CurrentSessionState | undefined {
  const dirs = sessionsReadDirs(cwd);
  const currentUser = resolveCurrentUser();
  const currentAgent = resolveCurrentAgentName();
  const explicitSessionId = resolveExplicitSessionId();
  const ttlMs = parseDurationToMs(loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
  const now = Date.now();

  if (explicitSessionId) {
    const explicit = loadSessionById(explicitSessionId, cwd);
    return explicit && isSessionAlive(explicit, ttlMs, now) ? explicit : undefined;
  }

  // 1. Look in sessions/ directory for the session owned by this process.
  // Multiple parallel agents can have the same agent name/user in one repo;
  // a live different PID is a different agent instance, not our session.
  if (currentAgent) {
    // Les DEUX dispositions, canonique d'abord : un record ecrit avant la migration
    // etait invisible a son propre chargeur, et c'est ce qui rendait un `active_project`
    // introuvable alors qu'il existait sur disque.
    const files = dirs
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)));
    const legacyPidlessCandidates: CurrentSessionState[] = [];

    for (const filepath of files) {
      try {
        const session = loadSessionFile(filepath);
        // Strict match: agent name must match, user must match (when both are known)
        if (session.agent !== currentAgent) continue;
        const userMatch = !session.user || !currentUser || session.user === currentUser;
        if (!userMatch || !isSessionAlive(session, ttlMs, now)) continue;

        if (session.pid === process.pid) {
          return session;
        }

        if (session.pid === undefined) {
          legacyPidlessCandidates.push(session);
        }
      } catch {
        // skip invalid session files
      }
    }

    if (legacyPidlessCandidates.length === 1) {
      return legacyPidlessCandidates[0];
    }
  }

  // 2. Legacy fallback: .current-session
  const legacyPath = path.join(memoryDir(cwd), LEGACY_SESSION_FILE);
  if (fs.existsSync(legacyPath)) {
    try {
      const migration = loadVersionedJsonFile<CurrentSessionState>('current_session', legacyPath);
      return {
        ...CurrentSessionStateSchema.parse(migration.document),
        schema_version: migration.metadata.currentVersion,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Load a specific session by ID.
 */
export function loadSessionById(sessionId: string, cwd?: string): CurrentSessionState | undefined {
  const filepath = findSessionFile(sessionId, cwd);
  if (!filepath) return undefined;
  try {
    const migration = loadVersionedJsonFile<CurrentSessionState>('current_session', filepath);
    return {
      ...CurrentSessionStateSchema.parse(migration.document),
      schema_version: migration.metadata.currentVersion,
    };
  } catch {
    return undefined;
  }
}

/**
 * Load ALL sessions (active + stale) from the sessions/ directory.
 */
export function loadAllSessions(cwd?: string): CurrentSessionState[] {
  // DEDUPLIQUE PAR ID, canonique d'abord : un store a mi-migration peut porter le meme
  // record des deux cotes, et le compter deux fois ferait apparaitre des agents fantomes
  // dans `brainclaw who`.
  const byId = new Map<string, CurrentSessionState>();
  for (const dir of sessionsReadDirs(cwd)) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const migration = loadVersionedJsonFile<CurrentSessionState>('current_session', path.join(dir, file));
        const parsed = {
          ...CurrentSessionStateSchema.parse(migration.document),
          schema_version: migration.metadata.currentVersion,
        };
        if (!byId.has(parsed.session_id)) byId.set(parsed.session_id, parsed);
      } catch {
        // skip invalid
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
}

/**
 * Save a session to the sessions/ directory.
 */
export function saveCurrentSession(session: CurrentSessionState, cwd?: string): void {
  const dir = sessionsWriteDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filepath = sessionFilePath(session.session_id, cwd);
  saveVersionedJsonFile('current_session', filepath, CurrentSessionStateSchema.parse(session));

  // SAVE-CONVERGE : une copie du meme record dans l'ancienne disposition est SUPPRIMEE.
  // La laisser signifierait deux verites pour un seul id, dont la plus ancienne peut
  // encore etre lue par un chemin qu'on aurait oublie de migrer — le motif deja retenu
  // pour les assignments et les sequences en 1.21.0.
  for (const stale of entityRecordPaths('sessions', session.session_id, cwd ?? process.cwd())) {
    if (path.resolve(stale) === path.resolve(filepath)) continue;
    try { fs.unlinkSync(stale); } catch { /* absent : rien a converger */ }
  }
}

/**
 * Clear a session. If sessionId is provided, only clear that specific session.
 */
export function clearCurrentSession(cwd?: string, sessionId?: string): void {
  if (sessionId) {
    // Remove specific session file
    // Effacer dans les DEUX dispositions : n'en nettoyer qu'une laisserait une session
    // « fermee » encore chargeable depuis l'autre.
    for (const filepath of entityRecordPaths('sessions', sessionId, cwd ?? process.cwd())) {
      try { fs.unlinkSync(filepath); } catch { /* ignore */ }
    }
    return;
  }

  // Clear the session for the current agent+user
  const session = loadCurrentSession(cwd);
  if (session) {
    const filepath = sessionFilePath(session.session_id, cwd);
    try { fs.unlinkSync(filepath); } catch { /* ignore */ }
  }

  // Also clean legacy file
  const legacyPath = path.join(memoryDir(cwd), LEGACY_SESSION_FILE);
  try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }
}

/**
 * Remove stale sessions that have exceeded the TTL.
 * Returns the number of sessions removed.
 */
export function gcStaleSessions(cwd?: string, ttlOverride?: string): number {
  const ttlMs = parseDurationToMs(ttlOverride ?? loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
  const now = Date.now();
  let removed = 0;

  // Le GC doit balayer les DEUX dispositions, sinon les records legacy s'accumulent
  // indefiniment : personne ne les lit plus, et personne ne les efface non plus.
  const files = sessionsReadDirs(cwd)
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)));

  for (const filepath of files) {
    try {
      const migration = loadVersionedJsonFile<CurrentSessionState>('current_session', filepath);
      const session = {
        ...CurrentSessionStateSchema.parse(migration.document),
        schema_version: migration.metadata.currentVersion,
      };
      if (now - Date.parse(session.last_seen_at) > ttlMs) {
        fs.unlinkSync(filepath);
        removed++;
      }
    } catch {
      // Remove unparseable files too
      try { fs.unlinkSync(filepath); removed++; } catch { /* ignore */ }
    }
  }
  return removed;
}

// --- Internal helpers ---

/**
 * Repertoire d'ECRITURE des records de session : le CANONIQUE, toujours.
 *
 * POURQUOI CE CHANGEMENT (pln#648 SUITE a). Ce module ecrivait dans la disposition
 * LEGACY (`.brainclaw/sessions/`) tandis que le reste du produit avait migre vers
 * `coordination/sessions/`. Mesure sur le store de l'auteur au moment du correctif :
 * 182 records d'un cote, 1030 de l'autre. `session-start.ts` definissait en plus SA
 * PROPRE version via `resolveEntityDir(..., 'read')`, une heuristique qui repond a la
 * question « ou vivent generalement ces records » — donc DEUX ecrivains pour un meme
 * record, et un `active_project` qui pouvait atterrir dans l'une ou l'autre.
 *
 * C'est le second vecteur de divergence de pln#648 : le premier faisait deplacer la
 * verite a chaque switch, celui-ci la dedoublait.
 */
function sessionsWriteDir(cwd?: string): string {
  return path.join(memoryDir(cwd), ENTITY_DIR_MAP['sessions'] ?? SESSIONS_DIR);
}

/**
 * Repertoires de LECTURE — les deux dispositions, canonique d'abord.
 *
 * Un store a mi-migration porte des records des deux cotes ; ne lire qu'un seul rendait
 * l'autre INVISIBLE a son propre chargeur. C'est exactement le defaut que pln#649 a
 * ferme pour les assignments, agent_runs, claims et sequences — la meme primitive est
 * reutilisee ici plutot qu'une troisieme heuristique locale.
 */
function sessionsReadDirs(cwd?: string): string[] {
  return entityRecordDirs('sessions', cwd ?? process.cwd());
}

/** Chemin d'ECRITURE d'un record. */
function sessionFilePath(sessionId: string, cwd?: string): string {
  return path.join(sessionsWriteDir(cwd), `${sessionId}.json`);
}

/** Premier chemin EXISTANT pour un id, toutes dispositions confondues. */
function findSessionFile(sessionId: string, cwd?: string): string | undefined {
  for (const candidate of entityRecordPaths('sessions', sessionId, cwd ?? process.cwd())) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveCurrentUser(): string | undefined {
  return process.env.USER || process.env.USERNAME || os.userInfo().username || undefined;
}

function resolveCurrentAgentName(): string | undefined {
  if (process.env.BRAINCLAW_AGENT_NAME) return process.env.BRAINCLAW_AGENT_NAME;
  return detectAiAgent()?.name;
}

/**
 * The session id the CALLER named, via argument or env. Exported (pln#648 review
 * P1) because store-resolution must tell a STRONGLY identified session (exact id,
 * or a record whose pid is this process) from a WEAKLY adopted one (the pidless
 * candidate at line ~145, or the legacy `.current-session` fallback, which is
 * returned with no agent/user/pid/TTL check at all). Only the former may steer
 * resolution from a store the agent never named.
 */
export function resolveExplicitSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BRAINCLAW_SESSION_ID?.trim()
    || env.OPENCLAW_SESSION_ID?.trim()
    || env.CLAUDE_SESSION_ID?.trim()
    || env.COPILOT_SESSION_ID?.trim()
    || undefined;
}

function loadSessionFile(filepath: string): CurrentSessionState {
  const migration = loadVersionedJsonFile<CurrentSessionState>('current_session', filepath);
  return {
    ...CurrentSessionStateSchema.parse(migration.document),
    schema_version: migration.metadata.currentVersion,
  };
}

function isSessionAlive(session: CurrentSessionState, ttlMs: number, now: number): boolean {
  return now - Date.parse(session.last_seen_at) <= ttlMs;
}

function loadConfigSafe(cwd?: string): { implicit_session_ttl?: string } | undefined {
  try { return loadConfig(cwd); } catch { return undefined; }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
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
function resolveImplicitSession(
  cwd: string | undefined,
  options: Required<Pick<SessionResolutionOptions, 'agentName' | 'agentId' | 'hostId'>> & SessionResolutionOptions,
): CurrentSessionState {
  const persistImplicit = options.persistImplicit ?? true;
  const ttlMs = parseDurationToMs(loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
  const now = new Date();
  const currentUser = resolveCurrentUser();
  const currentPid = process.pid;

  // 1. If a preferred session ID is given, try exact match first
  if (options.preferredSessionId) {
    const exact = loadSessionById(options.preferredSessionId, cwd);
    if (exact && now.getTime() - Date.parse(exact.last_seen_at) <= ttlMs) {
      const refreshed: CurrentSessionState = {
        ...exact,
        last_seen_at: now.toISOString(),
        user: exact.user || currentUser,
        pid: currentPid,
      };
      if (persistImplicit) saveCurrentSession(refreshed, cwd);
      return refreshed;
    }
  }

  // 2. Scan all sessions for PID-aware matching
  const allSessions = loadAllSessions(cwd);
  let samePidSession: CurrentSessionState | undefined;
  let deadPidSession: CurrentSessionState | undefined;

  for (const session of allSessions) {
    if (session.agent !== options.agentName) continue;
    if (session.agent_id !== options.agentId) continue;
    if (session.host_id !== options.hostId) continue;
    if (currentUser && session.user && session.user !== currentUser) continue;
    if (now.getTime() - Date.parse(session.last_seen_at) > ttlMs) continue;

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
    const refreshed: CurrentSessionState = {
      ...toRefresh,
      last_seen_at: now.toISOString(),
      user: toRefresh.user || currentUser,
      pid: currentPid,
    };
    if (persistImplicit) saveCurrentSession(refreshed, cwd);
    return refreshed;
  }

  // 3. No match — create new session
  const created: CurrentSessionState = {
    session_id: options.preferredSessionId ?? generateImplicitSessionId(),
    started_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    agent: options.agentName,
    agent_id: options.agentId,
    host_id: options.hostId,
    user: currentUser,
    pid: currentPid,
  };
  if (persistImplicit) saveCurrentSession(created, cwd);
  return created;
}

function parseDurationToMs(value: string): number {
  const match = /^(\d+)([mhd])$/i.exec(value.trim());
  if (!match) {
    return 4 * 60 * 60 * 1000;
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 3_600_000;
  return amount * 86_400_000;
}

function generateImplicitSessionId(): string {
  return `sess_${crypto.randomBytes(4).toString('hex')}`;
}
