import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireRegisteredAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { memoryDir, writeFileAtomic } from './io.js';
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
  const dir = sessionsDir(cwd);
  const currentUser = resolveCurrentUser();
  const currentAgent = resolveCurrentAgentName();

  // 1. Look in sessions/ directory for a matching session
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const ttlMs = parseDurationToMs(loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
    const now = Date.now();

    for (const file of files) {
      try {
        const session = CurrentSessionStateSchema.parse(
          loadVersionedJsonFile<CurrentSessionState>('current_session', path.join(dir, file)).document
        );
        // Match by agent+user (or agent only if user not set in old sessions)
        const userMatch = !session.user || !currentUser || session.user === currentUser;
        const agentMatch = !currentAgent || session.agent === currentAgent;
        const alive = (now - Date.parse(session.last_seen_at)) <= ttlMs;
        if (userMatch && agentMatch && alive) {
          return session;
        }
      } catch {
        // skip invalid session files
      }
    }
  }

  // 2. Legacy fallback: .current-session
  const legacyPath = path.join(memoryDir(cwd), LEGACY_SESSION_FILE);
  if (fs.existsSync(legacyPath)) {
    try {
      return CurrentSessionStateSchema.parse(
        loadVersionedJsonFile<CurrentSessionState>('current_session', legacyPath).document
      );
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
  const filepath = sessionFilePath(sessionId, cwd);
  if (!fs.existsSync(filepath)) return undefined;
  try {
    return CurrentSessionStateSchema.parse(
      loadVersionedJsonFile<CurrentSessionState>('current_session', filepath).document
    );
  } catch {
    return undefined;
  }
}

/**
 * Load ALL sessions (active + stale) from the sessions/ directory.
 */
export function loadAllSessions(cwd?: string): CurrentSessionState[] {
  const dir = sessionsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const sessions: CurrentSessionState[] = [];
  for (const file of files) {
    try {
      sessions.push(CurrentSessionStateSchema.parse(
        loadVersionedJsonFile<CurrentSessionState>('current_session', path.join(dir, file)).document
      ));
    } catch {
      // skip invalid
    }
  }
  return sessions.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
}

/**
 * Save a session to the sessions/ directory.
 */
export function saveCurrentSession(session: CurrentSessionState, cwd?: string): void {
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
export function clearCurrentSession(cwd?: string, sessionId?: string): void {
  if (sessionId) {
    // Remove specific session file
    const filepath = sessionFilePath(sessionId, cwd);
    try { fs.unlinkSync(filepath); } catch { /* ignore */ }
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
  const dir = sessionsDir(cwd);
  if (!fs.existsSync(dir)) return 0;

  const ttlMs = parseDurationToMs(ttlOverride ?? loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
  const now = Date.now();
  let removed = 0;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const session = CurrentSessionStateSchema.parse(
        loadVersionedJsonFile<CurrentSessionState>('current_session', path.join(dir, file)).document
      );
      if (now - Date.parse(session.last_seen_at) > ttlMs) {
        fs.unlinkSync(path.join(dir, file));
        removed++;
      }
    } catch {
      // Remove unparseable files too
      try { fs.unlinkSync(path.join(dir, file)); removed++; } catch { /* ignore */ }
    }
  }
  return removed;
}

// --- Internal helpers ---

function sessionsDir(cwd?: string): string {
  return path.join(memoryDir(cwd), SESSIONS_DIR);
}

function sessionFilePath(sessionId: string, cwd?: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

function resolveCurrentUser(): string | undefined {
  return process.env.USER || process.env.USERNAME || os.userInfo().username || undefined;
}

function resolveCurrentAgentName(): string | undefined {
  return process.env.BRAINCLAW_AGENT_NAME || process.env.CLAUDE_CODE_VERSION ? 'claude-code' : undefined;
}

function loadConfigSafe(cwd?: string): { implicit_session_ttl?: string } | undefined {
  try { return loadConfig(cwd); } catch { return undefined; }
}

function resolveImplicitSession(
  cwd: string | undefined,
  options: Required<Pick<SessionResolutionOptions, 'agentName' | 'agentId' | 'hostId'>> & SessionResolutionOptions,
): CurrentSessionState {
  const current = loadCurrentSession(cwd);
  const persistImplicit = options.persistImplicit ?? true;
  const ttlMs = parseDurationToMs(loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
  const now = new Date();
  const currentUser = resolveCurrentUser();

  if (
    current
    && current.agent === options.agentName
    && current.agent_id === options.agentId
    && current.host_id === options.hostId
    && (!current.user || !currentUser || current.user === currentUser)
    && now.getTime() - Date.parse(current.last_seen_at) <= ttlMs
  ) {
    const refreshed: CurrentSessionState = {
      ...current,
      last_seen_at: now.toISOString(),
      user: current.user || currentUser,
      pid: process.pid,
    };
    if (persistImplicit) {
      saveCurrentSession(refreshed, cwd);
    }
    return refreshed;
  }

  const created: CurrentSessionState = {
    session_id: options.preferredSessionId ?? generateImplicitSessionId(),
    started_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    agent: options.agentName,
    agent_id: options.agentId,
    host_id: options.hostId,
    user: currentUser,
    pid: process.pid,
  };
  if (persistImplicit) {
    saveCurrentSession(created, cwd);
  }
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
