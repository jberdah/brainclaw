import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAiAgent } from './ai-agent-detection.js';
import { requireRegisteredAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { assertSafeSessionId, findSessionAnchorRoot, isSafeSessionId, isSessionSnapshotRecordFilename, memoryDir } from './io.js';
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
  // pln#672 review P1: ONE validated resolution for the env session id. This
  // used to re-read the variables raw, so an unsafe value bypassed the
  // boundary here and reached startSession's snapshot write — the traversal
  // stayed exploitable through a second writer (reproduced by the reviewer).
  const value = resolveExplicitSessionId(env);
  if (value) {
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
  const currentUser = resolveCurrentUser();
  const currentAgent = resolveCurrentAgentName();
  const explicitSessionId = resolveExplicitSessionId();
  const ttlMs = parseDurationToMs(loadConfigSafe(cwd)?.implicit_session_ttl ?? '4h');
  const now = Date.now();

  if (explicitSessionId) {
    const explicit = loadSessionById(explicitSessionId, cwd);
    return explicit && isSessionAlive(explicit, ttlMs, now) ? explicit : undefined;
  }

  // 1. Look in the sessions read-chain (workspace anchor first, then the
  // pre-anchor legacy location — pln#648) for the session owned by this
  // process. Multiple parallel agents can have the same agent name/user in
  // one repo; a live different PID is a different agent instance, not our
  // session. Pidless legacy candidates are deduped by id: during relocation a
  // record can transiently exist in both locations, and a duplicate must not
  // inflate the candidate count.
  if (currentAgent) {
    const currentHostId = resolveCurrentHostId();
    const legacyPidlessCandidates = new Map<string, CurrentSessionState>();

    for (const dir of sessionsDirs(cwd)) {
      if (!fs.existsSync(dir)) continue;
      for (const file of listCurrentSessionFiles(dir)) {
        try {
          const session = loadSessionFile(path.join(dir, file));
          // Strict match: agent name must match, user must match (when both are known)
          if (session.agent !== currentAgent) continue;
          const userMatch = !session.user || !currentUser || session.user === currentUser;
          if (!userMatch || !isSessionAlive(session, ttlMs, now)) continue;

          if (session.pid === process.pid) {
            return session;
          }

          // Legacy pidless adoption, HOST-GUARDED (pln#648 anchoring follow-up):
          // anchoring parks every session of the workspace at one directory, so
          // the historical weak adoption — agent name + user only — would now
          // see records it never saw before, including another instance's
          // stale intent (the exact hijack the P1-1/P1-2 review pins forbid on
          // the resolver's added probes). A pidless record is only adoptable
          // when it was written by THIS host; foreign-instance records need
          // strong identity (named id or pid) everywhere.
          if (
            session.pid === undefined
            && (!session.host_id || session.host_id === currentHostId)
            && !legacyPidlessCandidates.has(session.session_id)
          ) {
            legacyPidlessCandidates.set(session.session_id, session);
          }
        } catch {
          // skip invalid session files
        }
      }
    }

    if (legacyPidlessCandidates.size === 1) {
      return [...legacyPidlessCandidates.values()][0];
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
  // A READ answers "no such record" rather than throwing: an unsafe id
  // (traversal — pln#672) or the reserved '.snapshot' alias (pln#670) simply
  // cannot name a current_session record. The throwing guard stays in
  // sessionFilePathIn for the write paths.
  if (!isSafeSessionId(sessionId) || !isCurrentSessionFilename(sessionId)) return undefined;
  // pln#648 read-chain: anchor first, then the pre-anchor legacy location. A
  // bad record in one location must not mask a good one in the other.
  for (const dir of sessionsDirs(cwd)) {
    const filepath = sessionFilePathIn(dir, sessionId);
    if (!fs.existsSync(filepath)) continue;
    try {
      const migration = loadVersionedJsonFile<CurrentSessionState>('current_session', filepath);
      const session = {
        ...CurrentSessionStateSchema.parse(migration.document),
        schema_version: migration.metadata.currentVersion,
      };
      // The filename is only an index, never an identity (codex review): do not
      // adopt a record whose payload names a different session.
      if (session.session_id === sessionId) return session;
    } catch {
      // fall through to the next location
    }
  }
  return undefined;
}

/**
 * Load ALL sessions (active + stale) from the sessions/ directory.
 */
export function loadAllSessions(cwd?: string): CurrentSessionState[] {
  // pln#648 read-chain: anchored records win over a transient pre-anchor copy
  // of the same session (dedup by id, anchor scanned first).
  const seen = new Set<string>();
  const sessions: CurrentSessionState[] = [];
  for (const dir of sessionsDirs(cwd)) {
    if (!fs.existsSync(dir)) continue;
    for (const file of listCurrentSessionFiles(dir)) {
      try {
        const migration = loadVersionedJsonFile<CurrentSessionState>('current_session', path.join(dir, file));
        const session = {
          ...CurrentSessionStateSchema.parse(migration.document),
          schema_version: migration.metadata.currentVersion,
        };
        if (seen.has(session.session_id)) continue;
        seen.add(session.session_id);
        sessions.push(session);
      } catch {
        // skip invalid
      }
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
  // sessionFilePath throws on a '.snapshot' alias id — a write must never
  // construct a snapshot filename (codex review P1).
  const filepath = sessionFilePath(session.session_id, cwd);
  // A plain `<id>.json` can still hold a pre-split snapshot (the old
  // 'read'-mode write bug parked snapshots in session directories). Only
  // overwrite THIS path when its record proves to be this exact
  // current_session entry (codex review, made path-local by pln#648: the
  // proof must be about the file being replaced, not about any location).
  if (fs.existsSync(filepath) && !isProvenCurrentSessionAt(filepath, session.session_id)) {
    throw new Error(`Refusing to overwrite non-current_session record at '${filepath}'`);
  }
  saveVersionedJsonFile('current_session', filepath, CurrentSessionStateSchema.parse(session));

  // pln#648 relocation: a pre-anchor copy of the SAME session under the
  // effective cwd would linger until TTL decay — remove it once the anchored
  // write has landed, on positive proof only. Best effort: the read-chain and
  // the GC cover any leftover. legacySessionsDir normalizes exactly like the
  // anchor (codex review P1): a relative cwd must never make the SAME
  // directory compare unequal — the unlink below would delete the record
  // this function just wrote.
  const legacyDir = legacySessionsDir(cwd);
  if (legacyDir !== dir) {
    try {
      const legacyPath = sessionFilePathIn(legacyDir, session.session_id);
      if (fs.existsSync(legacyPath) && isProvenCurrentSessionAt(legacyPath, session.session_id)) {
        fs.unlinkSync(legacyPath);
      }
    } catch { /* best effort */ }
  }
}

/**
 * Clear a session. If sessionId is provided, only clear that specific session.
 */
export function clearCurrentSession(cwd?: string, sessionId?: string): void {
  // A filename is never enough authority to delete a record (codex review P1):
  // the '.snapshot' alias id throws in sessionFilePathIn (caught → no-op), and
  // a file is only unlinked when it PROVES to be this exact current_session
  // record — never a pre-split snapshot parked under a plain `<id>.json`.
  // pln#648: the record can live at the anchor OR at the pre-anchor legacy
  // location — clear wherever it proves.
  const unlinkProven = (id: string): void => {
    for (const dir of sessionsDirs(cwd)) {
      try {
        const filepath = sessionFilePathIn(dir, id);
        if (fs.existsSync(filepath) && isProvenCurrentSessionAt(filepath, id)) {
          fs.unlinkSync(filepath);
        }
      } catch { /* ignore */ }
    }
  };

  if (sessionId) {
    unlinkProven(sessionId);
    return;
  }

  // Clear the session for the current agent+user
  const session = loadCurrentSession(cwd);
  if (session) {
    unlinkProven(session.session_id);
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

  // pln#648: sweep the whole read-chain — pre-anchor legacy records are
  // exactly what this GC must decay.
  for (const dir of sessionsDirs(cwd)) {
    if (!fs.existsSync(dir)) continue;

    for (const file of listCurrentSessionFiles(dir)) {
      const filepath = path.join(dir, file);
      try {
        // POSITIVE proof before deletion (codex review): a bare `<id>.json` in
        // this directory can still be a pre-split snapshot (old 'read'-mode
        // write bug). Only a record carrying the current_session discriminant
        // may be collected; anything unidentifiable is preserved, never deleted.
        const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as { last_seen_at?: unknown };
        if (typeof raw.last_seen_at !== 'string') continue;
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
        // An unidentifiable record is not proven stale current_session state —
        // preserving it beats risking the deletion of a legacy snapshot.
      }
    }
  }
  return removed;
}

// --- Internal helpers ---

/**
 * pln#648 (a) — the session record must live at a STABLE, workspace-unique
 * location. Anchored on the effective cwd, the record landed under the store
 * of the project being LEFT at session-start, and every switch moved the
 * truth out of the resolver's reach (the reproduced P0: status said api,
 * writes went to web). The anchor is the outermost .brainclaw/ above cwd —
 * a pure filesystem answer, independent of active-project state, so every
 * probe of the same workspace derives the SAME directory.
 */
function sessionAnchorCwd(cwd?: string): string {
  // path.resolve BEFORE anchoring (codex review P1): the anchor and the legacy
  // location below are compared for equality — a relative cwd ('.') must not
  // make the SAME directory look like two, or the relocation would unlink the
  // record it just wrote. Role-aware walk: the nearest declared workspace wins,
  // so sibling workspaces under a parent store stay isolated (review P1 #2).
  const base = path.resolve(cwd ?? process.cwd());
  return findSessionAnchorRoot(base) ?? base;
}

/** The write + primary read location for current_session records. */
function sessionsDir(cwd?: string): string {
  return path.join(memoryDir(sessionAnchorCwd(cwd)), SESSIONS_DIR);
}

/** The pre-anchor legacy location, NORMALIZED the same way as the anchor. */
function legacySessionsDir(cwd?: string): string {
  return path.join(memoryDir(path.resolve(cwd ?? process.cwd())), SESSIONS_DIR);
}

/**
 * Read-chain (pln#648 migration): anchor first, then the pre-anchor location
 * under the effective cwd where existing records still live. Sessions expire
 * within the implicit TTL (4h), so the legacy probe decays naturally — no
 * rewrite migration; saveCurrentSession relocates its own record on the next
 * heartbeat and the GC sweeps both. Deduped when both resolve to the same
 * directory (single-project stores — the common case).
 */
function sessionsDirs(cwd?: string): string[] {
  const anchored = sessionsDir(cwd);
  const legacy = legacySessionsDir(cwd);
  return anchored === legacy ? [anchored] : [anchored, legacy];
}

/**
 * Positive proof that the file at `filepath` is THE current_session record for
 * `sessionId` (pln#670 discipline: a filename is never authority to delete or
 * overwrite — a plain `<id>.json` can be a pre-split snapshot).
 */
function isProvenCurrentSessionAt(filepath: string, sessionId: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as { last_seen_at?: unknown; session_id?: unknown };
    return typeof raw.last_seen_at === 'string' && raw.session_id === sessionId;
  } catch {
    return false;
  }
}

/**
 * pln#670 — current_session scanners must be type-strict: session_snapshot
 * records use the `<id>.snapshot.json` suffix and can share a directory with
 * current_session records. Without this exclusion, gcStaleSessions would
 * delete a stray snapshot as "unparseable" and loadCurrentSession could adopt
 * one as a session candidate.
 */
function listCurrentSessionFiles(dir: string): string[] {
  // Case-insensitive on purpose (codex review P1): Windows filesystems match
  // names case-insensitively, so `X.SNAPSHOT.json` IS the snapshot path a
  // lower-case probe resolves — excluding only the exact-case suffix would let
  // gcStaleSessions delete it as an unparseable current_session.
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json') && !isSessionSnapshotRecordFilename(f));
}

/** True when `<sessionId>.json` cannot collide with a session_snapshot filename. */
function isCurrentSessionFilename(sessionId: string): boolean {
  return !isSessionSnapshotRecordFilename(`${sessionId}.json`);
}

function sessionFilePathIn(dir: string, sessionId: string): string {
  // pln#672 — PATH SAFETY first: the id is env-controlled and becomes a
  // filename, so a traversal ('../../evil') must never build a path. This is
  // the choke point for save / load / clear alike.
  assertSafeSessionId(sessionId);
  // pln#670 review fix (codex P1): a session id ending in ".snapshot" would
  // produce `<base>.snapshot.json` — the snapshot filename of session <base>
  // in a shared directory. Refuse the alias instead of silently colliding
  // across record types; readers treat the throw as "no such record".
  if (!isCurrentSessionFilename(sessionId)) {
    throw new Error(`session id '${sessionId}' is reserved for session_snapshot records — the '.snapshot' suffix would collide across record types`);
  }
  return path.join(dir, `${sessionId}.json`);
}

function sessionFilePath(sessionId: string, cwd?: string): string {
  return sessionFilePathIn(sessionsDir(cwd), sessionId);
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
  const named = env.BRAINCLAW_SESSION_ID?.trim()
    || env.OPENCLAW_SESSION_ID?.trim()
    || env.CLAUDE_SESSION_ID?.trim()
    || env.COPILOT_SESSION_ID?.trim()
    || undefined;
  // pln#672 — this value becomes a FILENAME (`<id>.json`). An id that cannot
  // safely do so is IGNORED, not honoured: falling back to the implicit
  // session is safe, while using it walks out of the store (reproduced on
  // disk with '../../../ESCAPED'). Refusing to run at all would be worse —
  // a stale exported variable would break every command in the shell — so
  // the boundary drops the value here and the filename builders below refuse
  // loudly for any other caller. The drop is NOT silent: session
  // establishment surfaces it (see describeIgnoredSessionIdEnv).
  return named && isSafeSessionId(named) ? named : undefined;
}

/**
 * Name the env variable whose session id was DROPPED as unsafe, if any
 * (pln#672 review — the availability-first fallback must not silently change
 * the agent's identity: continuing under an implicit session while the caller
 * believes it resumed the supplied one is exactly the kind of silent
 * divergence this project refuses).
 *
 * Returns the VARIABLE NAME and a non-sensitive reason only — never the raw
 * value, which is attacker-influenced and would land in logs.
 */
export function describeIgnoredSessionIdEnv(
  env: NodeJS.ProcessEnv = process.env,
): { variable: string; length: number } | undefined {
  for (const variable of ['BRAINCLAW_SESSION_ID', 'OPENCLAW_SESSION_ID', 'CLAUDE_SESSION_ID', 'COPILOT_SESSION_ID']) {
    const raw = env[variable]?.trim();
    if (!raw) continue;
    // The first variable that carries a value decides — same precedence as
    // resolveExplicitSessionId, so the report names the one actually used.
    return isSafeSessionId(raw) ? undefined : { variable, length: raw.length };
  }
  return undefined;
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
