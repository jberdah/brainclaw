import fs from 'node:fs';
import path from 'node:path';
import { memoryExists, memoryDir } from '../core/io.js';
import { buildOperationalIdentity } from '../core/identity.js';
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
}

export function runSessionStart(options: SessionStartOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let actor;
  try {
    actor = buildOperationalIdentity(options.agent);
  } catch (e: unknown) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // Capture initial context snapshot
  let initialContextHash: string | undefined;
  try {
    const ctx = buildContext({ target: options.context, agent: actor.agent });
    initialContextHash = createHash(JSON.stringify(ctx.selected));
  } catch { /* non-fatal */ }

  const snapshot: SessionSnapshot = {
    session_id: actor.session_id ?? generateId('sessions'),
    agent: actor.agent,
    agent_id: actor.agent_id,
    started_at: nowISO(),
    context_target: options.context,
    initial_context_hash: initialContextHash,
  };

  // Persist snapshot
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionSnapshotPath(snapshot.session_id), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');

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
  });

  appendAuditEntry({ action: 'session_start', actor: actor.agent, actor_id: actor.agent_id, item_id: snapshot.session_id, item_type: 'session' });

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(`✔ Session started: ${snapshot.session_id} (${actor.agent})`);
  if (options.context) console.log(`  Context target: ${options.context}`);
}

export function loadSessionSnapshot(sessionId: string, cwd?: string): SessionSnapshot | undefined {
  const p = sessionSnapshotPath(sessionId, cwd);
  if (!fs.existsSync(p)) return undefined;
  try {
    return SessionSnapshotSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch {
    return undefined;
  }
}
