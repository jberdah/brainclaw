import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';
import { appendEvent } from './event-log.js';
import type { EventAction, EventItemType } from './event-log.js';

const AUDIT_LOG_FILE = 'audit.log';
const MAX_AUDIT_LOG_BYTES = 10 * 1024 * 1024; // 10MB

/** Map audit actions to event-log actions (subset that overlaps) */
const AUDIT_TO_EVENT_ACTION: Partial<Record<AuditAction, EventAction>> = {
  create: 'create',
  update: 'update',
  delete: 'delete',
  accept: 'accept',
  reject: 'reject',
  claim: 'claim',
  release_claim: 'release_claim',
  session_start: 'session_start',
  session_end: 'session_end',
  rollback: 'rollback',
  promote_direct: 'create',
  trust_change: 'update',
};

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'accept'
  | 'reject'
  | 'claim'
  | 'release_claim'
  | 'trust_change'
  | 'session_start'
  | 'session_end'
  | 'promote_direct'
  | 'rollback'
  | 'agent_spawned'
  | 'spawn_failed'
  | 'move';

export interface AuditEntry {
  timestamp: string;
  actor_id?: string;
  actor: string;
  action: AuditAction;
  item_id?: string;
  item_type?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  /** Scope for claim/release_claim actions (file path or directory). */
  scope?: string;
  /** Session ID active when this entry was created. */
  session_id?: string;
  /** Host ID where this entry was created. */
  host_id?: string;
  /** Session ID of the agent instance that performed the action (for multi-instance tracing).
   *  Distinct from session_id which is the MCP caller's session — actor_session is the spawned instance. */
  actor_session?: string;
}

function auditLogPath(cwd?: string): string {
  return path.join(memoryDir(cwd), AUDIT_LOG_FILE);
}

export function appendAuditEntry(entry: Partial<AuditEntry> & { action: AuditAction; actor: string }, cwd?: string): void {
  try {
    mutate({ cwd }, () => {
      rotateAuditLogIfNeeded(cwd);
      const full: AuditEntry = {
        timestamp: nowISO(),
        actor: entry.actor,
        action: entry.action,
        item_id: entry.item_id,
        item_type: entry.item_type,
        before: entry.before,
        after: entry.after,
        actor_id: entry.actor_id,
        reason: entry.reason,
        scope: entry.scope,
        session_id: entry.session_id,
        host_id: entry.host_id,
        actor_session: entry.actor_session,
      };
      const line = JSON.stringify(Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined)));
      fs.appendFileSync(auditLogPath(cwd), line + '\n', 'utf-8');

      const eventAction = AUDIT_TO_EVENT_ACTION[entry.action];
      if (eventAction) {
        appendEvent({
          action: eventAction,
          item_type: (entry.item_type as EventItemType) ?? 'state',
          item_id: entry.item_id,
          agent: entry.actor,
          agent_id: entry.actor_id,
        }, cwd);
      }
    });
  } catch (err) {
    logger.debug('Failed to write audit log entry:', err);
  }
}

export function readAuditLog(options: { since?: string; actor?: string; action?: AuditAction; itemId?: string } = {}, cwd?: string): AuditEntry[] {
  const logPath = auditLogPath(cwd);
  if (!fs.existsSync(logPath)) return [];

  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  let entries: AuditEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch (err) {
      logger.debug('Skipping malformed audit log entry:', err);
    }
  }

  if (options.since) {
    entries = entries.filter(e => e.timestamp >= options.since!);
  }
  if (options.actor) {
    const a = options.actor.toLowerCase();
    entries = entries.filter(e => e.actor.toLowerCase() === a || e.actor_id?.toLowerCase() === a);
  }
  if (options.action) {
    entries = entries.filter(e => e.action === options.action);
  }
  if (options.itemId) {
    entries = entries.filter(e => e.item_id === options.itemId);
  }

  return entries;
}

/**
 * Rotate audit.log if it exceeds MAX_AUDIT_LOG_BYTES.
 * Archives to audit.{timestamp}.log in the same directory.
 */
export function rotateAuditLogIfNeeded(cwd?: string): boolean {
  const logPath = auditLogPath(cwd);
  if (!fs.existsSync(logPath)) return false;

  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_AUDIT_LOG_BYTES) return false;

    const archiveName = `audit.${Date.now()}.log`;
    const archivePath = path.join(memoryDir(cwd), archiveName);
    fs.renameSync(logPath, archivePath);
    return true;
  } catch (err) {
    logger.debug('Failed to rotate audit log:', err);
    return false;
  }
}
