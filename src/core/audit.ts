import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';
import { appendEvent } from './event-log.js';
import type { EventAction, EventItemType } from './event-log.js';

const AUDIT_LOG_FILE = 'audit.log';

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
  | 'rollback';

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
}

function auditLogPath(cwd?: string): string {
  return path.join(memoryDir(cwd), AUDIT_LOG_FILE);
}

export function appendAuditEntry(entry: Partial<AuditEntry> & { action: AuditAction; actor: string }, cwd?: string): void {
  try {
    mutate({ cwd }, () => {
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
