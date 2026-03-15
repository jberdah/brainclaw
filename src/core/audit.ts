import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './io.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';

const AUDIT_LOG_FILE = 'audit.log';

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
}

function auditLogPath(cwd?: string): string {
  return path.join(memoryDir(cwd), AUDIT_LOG_FILE);
}

export function appendAuditEntry(entry: Partial<AuditEntry> & { action: AuditAction; actor: string }, cwd?: string): void {
  try {
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
    };
    // Remove undefined fields for compactness
    const line = JSON.stringify(Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined)));
    fs.appendFileSync(auditLogPath(cwd), line + '\n', 'utf-8');
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
