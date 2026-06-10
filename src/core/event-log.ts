import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './io.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';

const EVENT_LOG_FILE = 'events.jsonl';
const CURSORS_DIR = '.cursors';

// --- Event schema ---

export type EventAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'accept'
  | 'reject'
  | 'claim'
  | 'release_claim'
  | 'session_start'
  | 'session_end'
  | 'rollback'
  | 'upgrade'
  // Assignment lifecycle (Agent SDK runtime protocol)
  | 'assignment_created'
  | 'assignment_offered'
  | 'assignment_accepted'
  | 'assignment_started'
  | 'assignment_progress'
  | 'assignment_completed'
  | 'assignment_cancelled'
  | 'assignment_failed'
  | 'assignment_blocked'
  | 'assignment_timed_out'
  | 'assignment_expired'
  | 'assignment_retrying'
  | 'assignment_rerouted'
  | 'run_created'
  | 'run_launching'
  | 'run_waiting_input'
  | 'run_running'
  | 'run_blocked'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled'
  | 'run_timed_out'
  | 'run_interrupted';

export type EventItemType =
  | 'constraint'
  | 'decision'
  | 'trap'
  | 'handoff'
  | 'plan'
  | 'sequence'
  | 'claim'
  | 'candidate'
  | 'runtime_note'
  | 'instruction'
  | 'session'
  | 'state'
  | 'assignment'
  | 'agent_run';

export interface MemoryEvent {
  ts: string;
  agent: string;
  agent_id?: string;
  /**
   * Session that emitted this event (pln#562 step 4). Enables instance-level
   * self-exclusion: two live instances of the SAME agent name see each
   * other's events instead of being mutually invisible.
   */
  session_id?: string;
  /** OS user who triggered this event. */
  user?: string;
  action: EventAction;
  item_type: EventItemType;
  item_id?: string;
  summary?: string;
}

// --- Writer ---

export function appendEvent(event: Partial<MemoryEvent> & { action: EventAction; item_type: EventItemType }, cwd?: string): void {
  try {
    const full: MemoryEvent = {
      ts: event.ts ?? nowISO(),
      agent: event.agent ?? 'unknown',
      agent_id: event.agent_id,
      session_id: event.session_id ?? (process.env.BRAINCLAW_SESSION_ID?.trim() || undefined),
      user: event.user ?? process.env.USER ?? process.env.USERNAME,
      action: event.action,
      item_type: event.item_type,
      item_id: event.item_id,
      summary: event.summary,
    };
    const line = JSON.stringify(Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined)));
    const logPath = eventLogPath(cwd);
    fs.appendFileSync(logPath, line + '\n', 'utf-8');
  } catch (err) {
    logger.debug('Failed to write event log entry:', err);
  }
}

// --- Reader ---

export function readAllEvents(cwd?: string): MemoryEvent[] {
  const logPath = eventLogPath(cwd);
  if (!fs.existsSync(logPath)) return [];

  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  const events: MemoryEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as MemoryEvent);
    } catch {
      // skip malformed
    }
  }
  return events;
}

// --- Cursor-based reader ---

export interface AgentCursor {
  offset: number;
  last_read: string;
}

/**
 * Instance-aware reader handle (pln#562 step 4). Cursors are keyed by
 * session_id when available — two live instances of the same agent name each
 * track their own read position instead of consuming each other's events.
 * A bare string reader keeps the legacy name-keyed behavior.
 */
export interface EventLogReader {
  agent: string;
  session_id?: string;
}

function normalizeReader(reader: string | EventLogReader): EventLogReader {
  return typeof reader === 'string' ? { agent: reader } : reader;
}

function cursorsDir(cwd?: string): string {
  return path.join(memoryDir(cwd), CURSORS_DIR);
}

/** Cursor files are keyed by session_id when present, else by agent name. */
function cursorKey(reader: EventLogReader): string {
  return reader.session_id?.trim() || reader.agent;
}

function cursorPath(key: string, cwd?: string): string {
  return path.join(cursorsDir(cwd), `${key}.json`);
}

function loadCursor(reader: EventLogReader, cwd?: string): AgentCursor {
  const fp = cursorPath(cursorKey(reader), cwd);
  if (fs.existsSync(fp)) {
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as AgentCursor;
    } catch {
      return { offset: 0, last_read: '' };
    }
  }
  // name→instance migration: a session-keyed cursor that does not exist yet
  // seeds from the legacy name-keyed cursor, so an upgraded instance does not
  // replay the whole log. Cursors are caches — worst case is a re-read.
  if (reader.session_id?.trim()) {
    const legacy = cursorPath(reader.agent, cwd);
    if (fs.existsSync(legacy)) {
      try {
        return JSON.parse(fs.readFileSync(legacy, 'utf-8')) as AgentCursor;
      } catch { /* fall through to fresh cursor */ }
    }
  }
  return { offset: 0, last_read: '' };
}

function saveCursor(reader: EventLogReader, cursor: AgentCursor, cwd?: string): void {
  const dir = cursorsDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cursorPath(cursorKey(reader), cwd), JSON.stringify(cursor), 'utf-8');
}

/**
 * Read events unseen by this reader since their last read.
 * Updates the cursor after reading.
 *
 * Self-exclusion is by SESSION when both sides carry one (pln#562 step 4):
 * an instance skips only its own events, not those of a same-named sibling.
 * Events or readers without session info fall back to name exclusion.
 */
export function readUnseenEvents(reader: string | EventLogReader, cwd?: string): MemoryEvent[] {
  const effectiveReader = normalizeReader(reader);
  const logPath = eventLogPath(cwd);
  if (!fs.existsSync(logPath)) return [];

  const cursor = loadCursor(effectiveReader, cwd);
  const stat = fs.statSync(logPath);

  if (stat.size <= cursor.offset) return [];

  // Read from offset
  const fd = fs.openSync(logPath, 'r');
  const buffer = Buffer.alloc(stat.size - cursor.offset);
  fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
  fs.closeSync(fd);

  const newContent = buffer.toString('utf-8');
  const lines = newContent.split('\n').filter(Boolean);
  const events: MemoryEvent[] = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as MemoryEvent;
      const isSelf = effectiveReader.session_id && evt.session_id
        ? evt.session_id === effectiveReader.session_id
        : evt.agent === effectiveReader.agent;
      if (!isSelf) {
        events.push(evt);
      }
    } catch {
      // skip
    }
  }

  // Update cursor
  saveCursor(effectiveReader, { offset: stat.size, last_read: nowISO() }, cwd);

  return events;
}

/**
 * Build a compact notification summary from unseen events.
 */
export function buildNotificationSummary(events: MemoryEvent[]): Record<string, number> | undefined {
  if (events.length === 0) return undefined;

  const summary: Record<string, number> = {};
  for (const evt of events) {
    const key = `${evt.action}:${evt.item_type}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

// --- Rotation ---

const MAX_EVENT_LOG_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Check if the event log needs rotation. Returns true if rotated.
 */
export function rotateEventLogIfNeeded(cwd?: string): boolean {
  const logPath = eventLogPath(cwd);
  if (!fs.existsSync(logPath)) return false;

  const stat = fs.statSync(logPath);
  if (stat.size < MAX_EVENT_LOG_BYTES) return false;

  try {
    const archiveName = `events.${Date.now()}.jsonl`;
    const archivePath = path.join(memoryDir(cwd), archiveName);
    fs.renameSync(logPath, archivePath);

    // Reset all cursors
    const dir = cursorsDir(cwd);
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(dir, file));
      }
    }

    return true;
  } catch (err) {
    logger.debug('Failed to rotate event log:', err);
    return false;
  }
}

// --- Helpers ---

function eventLogPath(cwd?: string): string {
  return path.join(memoryDir(cwd), EVENT_LOG_FILE);
}
