import fs from 'node:fs';
import path from 'node:path';
import { memoryExists, memoryDir } from '../core/io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from '../core/migration.js';
import { buildOperationalIdentity, saveCurrentSession } from '../core/identity.js';
import { buildContext } from '../core/context.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { nowISO, generateId } from '../core/ids.js';
import { appendAuditEntry } from '../core/audit.js';
import { SessionSnapshotSchema, type SessionSnapshot } from '../core/schema.js';

const SESSIONS_DIR = 'sessions';

function sessionsDir(cwd?: string): string {
  return path.join(memoryDir(cwd), SESSIONS_DIR);
}

function sessionSnapshotPath(sessionId: string, cwd?: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

function createHash(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const chr = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface SessionStartOptions {
  agent?: string;
  context?: string;
  json?: boolean;
  cwd?: string;
}

export interface SessionStartResult extends SessionSnapshot {
  context_target?: string;
}

export function runSessionStart(options: SessionStartOptions = {}): void {
  try {
    const snapshot = startSession(options);
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    console.log(`✔ Session started: ${snapshot.session_id} (${snapshot.agent})`);
    if (options.context) console.log(`  Context target: ${options.context}`);
  } catch (e: unknown) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function startSession(options: SessionStartOptions = {}): SessionStartResult {
  if (!memoryExists(options.cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const actor = buildOperationalIdentity(options.agent, options.cwd);

  // Capture initial context snapshot
  let initialContextHash: string | undefined;
  try {
    const ctx = buildContext({ target: options.context, agent: actor.agent, cwd: options.cwd });
    initialContextHash = createHash(JSON.stringify(ctx.selected));
  } catch { /* non-fatal */ }

  const snapshot: SessionSnapshot = {
    schema_version: 2,
    session_id: actor.session_id ?? generateId('sessions'),
    agent: actor.agent,
    agent_id: actor.agent_id,
    started_at: nowISO(),
    context_target: options.context,
    initial_context_hash: initialContextHash,
  };

  // Persist snapshot
  const dir = sessionsDir(options.cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  saveVersionedJsonFile('session_snapshot', sessionSnapshotPath(snapshot.session_id, options.cwd), SessionSnapshotSchema.parse(snapshot));
  saveCurrentSession({
    schema_version: 2,
    session_id: snapshot.session_id,
    started_at: snapshot.started_at,
    last_seen_at: snapshot.started_at,
    agent: actor.agent,
    agent_id: actor.agent_id,
    host_id: actor.host_id,
  }, options.cwd);

  // Write session_start runtime note
  const noteId = generateRuntimeNoteId();
  saveRuntimeNote({
    id: noteId,
    agent: actor.agent,
    agent_id: actor.agent_id,
    project_id: actor.project_id,
    session_id: snapshot.session_id,
    text: `Session started${options.context ? ` — context: ${options.context}` : ''}`,
    created_at: nowISO(),
    tags: ['session'],
    visibility: 'shared',
    note_type: 'session_start',
  }, options.cwd);

  appendAuditEntry({ action: 'session_start', actor: actor.agent, actor_id: actor.agent_id, item_id: snapshot.session_id, item_type: 'session' }, options.cwd);
  return snapshot;
}

export function loadSessionSnapshot(sessionId: string, cwd?: string): SessionSnapshot | undefined {
  const p = sessionSnapshotPath(sessionId, cwd);
  if (!fs.existsSync(p)) return undefined;
  try {
    return SessionSnapshotSchema.parse(loadVersionedJsonFile<SessionSnapshot>('session_snapshot', p).document);
  } catch {
    return undefined;
  }
}
