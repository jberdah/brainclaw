import { buildOperationalIdentity } from '../core/identity.js';
import { memoryExists } from '../core/io.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { loadState } from '../core/state.js';
import { nowISO } from '../core/ids.js';
import type { OperationalIdentity } from '../core/identity.js';
import type { MemoryVisibility, RuntimeNote } from '../core/schema.js';

export interface RuntimeNoteOptions {
  agent?: string;
  tag?: string[];
  project?: string;
  plan?: string;
  visibility?: MemoryVisibility;
  host?: string;
  ttl?: string;
}

export function runRuntimeNote(text: string, options: RuntimeNoteOptions): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let actor: OperationalIdentity;
  try {
    actor = buildOperationalIdentity(options.agent);
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const state = loadState();
  const plan = options.plan ? state.plan_items.find((item) => item.id === options.plan) : undefined;
  if (options.plan && !plan) {
    console.error(`Error: Plan item '${options.plan}' not found.`);
    process.exit(1);
  }

  const id = generateRuntimeNoteId();
  const visibility = options.visibility ?? 'shared';
  const hostId = options.host ?? actor.host_id;
  const expiresAt = options.ttl ? parseTtl(options.ttl) : undefined;
  const note: RuntimeNote = {
    id,
    agent: actor.agent,
    agent_id: actor.agent_id,
    project_id: actor.project_id,
    session_id: actor.session_id,
    text,
    created_at: nowISO(),
    project: options.project ?? plan?.project,
    plan_id: options.plan,
    tags: options.tag ?? [],
    visibility,
    host_id: hostId,
    expires_at: expiresAt,
    note_type: 'observation',
  };

  saveRuntimeNote(note);
  const scopeInfo = visibility === 'shared' ? 'shared' : `${visibility}:${hostId}`;
  const ttlInfo = expiresAt ? ` (expires ${expiresAt})` : '';
  console.log(`✔ Runtime note added: [${id}] (${actor.agent}, ${scopeInfo}) ${text}${ttlInfo}`);
}

/** Parse a TTL string like "30m", "2h", "7d" and return an ISO expiry timestamp. */
function parseTtl(ttl: string): string | undefined {
  const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
  if (!match) return undefined;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'm' ? value * 60_000
    : unit === 'h' ? value * 3_600_000
    : value * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}
