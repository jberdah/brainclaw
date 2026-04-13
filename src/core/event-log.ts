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

function cursorsDir(cwd?: string): string {
  return path.join(memoryDir(cwd), CURSORS_DIR);
}

function cursorPath(agent: string, cwd?: string): string {
  return path.join(cursorsDir(cwd), `${agent}.json`);
}

function loadCursor(agent: string, cwd?: string): AgentCursor {
  const fp = cursorPath(agent, cwd);
  if (!fs.existsSync(fp)) return { offset: 0, last_read: '' };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as AgentCursor;
  } catch {
    return { offset: 0, last_read: '' };
  }
}

function saveCursor(agent: string, cursor: AgentCursor, cwd?: string): void {
  const dir = cursorsDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(cursorPath(agent, cwd), JSON.stringify(cursor), 'utf-8');
}

/**
 * Read events unseen by this agent since their last read.
 * Updates the cursor after reading.
 */
export function readUnseenEvents(agent: string, cwd?: string): MemoryEvent[] {
  const logPath = eventLogPath(cwd);
  if (!fs.existsSync(logPath)) return [];

  const cursor = loadCursor(agent, cwd);
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
      // Exclude events from self
      if (evt.agent !== agent) {
        events.push(evt);
      }
    } catch {
      // skip
    }
  }

  // Update cursor
  saveCursor(agent, { offset: stat.size, last_read: nowISO() }, cwd);

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
