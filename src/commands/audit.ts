import { readAuditLog } from '../core/audit.js';
import { memoryExists } from '../core/io.js';
import type { AuditAction } from '../core/audit.js';

export interface AuditCommandOptions {
  since?: string;
  actor?: string;
  action?: string;
  json?: boolean;
  limit?: number;
}

export function runAuditCommand(options: AuditCommandOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const entries = readAuditLog({
    since: options.since,
    actor: options.actor,
    action: options.action as AuditAction | undefined,
  });

  const limited = options.limit ? entries.slice(-options.limit) : entries;

  if (options.json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }

  if (limited.length === 0) {
    console.log('No audit entries found.');
    return;
  }

  console.log(`Audit log — ${limited.length} entries:`);
  console.log('');
  for (const entry of limited) {
    const parts = [entry.timestamp, `[${entry.actor}]`, entry.action];
    if (entry.item_id) parts.push(`→ ${entry.item_id}`);
    if (entry.item_type) parts.push(`(${entry.item_type})`);
    if (entry.reason) parts.push(`| ${entry.reason}`);
    console.log(parts.join(' '));
  }
}
