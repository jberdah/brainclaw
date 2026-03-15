import { buildOperationalIdentity } from '../core/identity.js';
import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { getAgentTrustLevel } from '../core/agent-registry.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { loadState } from '../core/state.js';
import { nowISO } from '../core/ids.js';
import type { OperationalIdentity } from '../core/identity.js';
import { createCandidateFromInput } from './reflect.js';
import { suggestCandidateTypes } from './reflect-runtime-note.js';
import type { CandidateType, MemoryVisibility, RuntimeNote } from '../core/schema.js';

export interface RuntimeNoteOptions {
  agent?: string;
  tag?: string[];
  project?: string;
  plan?: string;
  visibility?: MemoryVisibility;
  host?: string;
  ttl?: string;
  autoReflect?: boolean;
  cwd?: string;
  sessionId?: string;
}

export interface RuntimeNoteCommandResult {
  noteId: string;
  agent: string;
  sessionId?: string;
  scopeInfo: string;
  expiresAt?: string;
  autoReflectAttempted: boolean;
  detectedType?: CandidateType;
  candidateId?: string;
  promotedItemId?: string;
  skipReason?: string;
}

export function runRuntimeNote(text: string, options: RuntimeNoteOptions): RuntimeNoteCommandResult {
  return createRuntimeNote(text, options, true);
}

export function createRuntimeNote(
  text: string,
  options: RuntimeNoteOptions,
  printSuccess: boolean = false,
): RuntimeNoteCommandResult {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let actor: OperationalIdentity;
  try {
    actor = buildOperationalIdentity(options.agent, options.cwd, {
      sessionId: options.sessionId,
    });
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const state = loadState(options.cwd);
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

  saveRuntimeNote(note, options.cwd);
  const result = maybeAutoReflectRuntimeNote(note, options);
  const scopeInfo = visibility === 'shared' ? 'shared' : `${visibility}:${hostId}`;
  const ttlInfo = expiresAt ? ` (expires ${expiresAt})` : '';
  if (printSuccess) {
    console.log(`✔ Runtime note added: [${id}] (${actor.agent}, ${scopeInfo}) ${text}${ttlInfo}`);
    if (result.autoReflectAttempted) {
      if (result.promotedItemId) {
        console.log(`  Auto-reflect: promoted ${result.detectedType} via candidate [${result.candidateId}] -> [${result.promotedItemId}]`);
      } else if (result.candidateId) {
        console.log(`  Auto-reflect: created pending ${result.detectedType} candidate [${result.candidateId}]`);
      } else if (result.skipReason) {
        console.log(`  Auto-reflect skipped: ${result.skipReason}`);
      }
    }
  }
  return {
    noteId: id,
    agent: actor.agent,
    sessionId: actor.session_id,
    scopeInfo,
    expiresAt,
    ...result,
  };
}

function maybeAutoReflectRuntimeNote(note: RuntimeNote, options: RuntimeNoteOptions): Omit<RuntimeNoteCommandResult, 'noteId' | 'agent' | 'sessionId' | 'scopeInfo' | 'expiresAt'> {
  const config = loadConfig(options.cwd);
  const trustLevel = getAgentTrustLevel(note.agent_id ?? note.agent, options.cwd);
  const autoReflectRequested = Boolean(options.autoReflect)
    || (config.auto_reflect_notes === true && (trustLevel === 'trusted' || trustLevel === 'curator'));

  if (!autoReflectRequested) {
    return { autoReflectAttempted: false };
  }
  if (trustLevel === 'observer') {
    return { autoReflectAttempted: true, skipReason: 'observer_not_allowed' };
  }

  const suggestions = suggestCandidateTypes(note.text, note.tags);
  const detected = suggestions.find((entry) => entry.type !== 'handoff');
  if (!detected || detected.score < 4) {
    return { autoReflectAttempted: true, skipReason: 'low_confidence' };
  }

  const creation = createCandidateFromInput(note.text, detected.type, {
    tag: note.tags,
    author: note.agent,
    authorId: note.agent_id,
    projectId: note.project_id,
    hostId: note.host_id,
    sessionId: note.session_id,
    source: `runtime-note:${note.agent}:${note.id}`,
    cwd: options.cwd,
  }, false);

  return {
    autoReflectAttempted: true,
    detectedType: detected.type,
    candidateId: creation.candidateId,
    promotedItemId: creation.promotedItemId,
  };
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
