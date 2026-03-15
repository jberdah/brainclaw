import { memoryExists } from '../core/io.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { buildContext } from '../core/context.js';
import { listRuntimeNotes, saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { createCandidateFromInput } from './reflect.js';
import { nowISO } from '../core/ids.js';
import { appendAuditEntry } from '../core/audit.js';
import { loadSessionSnapshot } from './session-start.js';

export interface SessionEndOptions {
  session?: string;
  summary?: string;
  agent?: string;
  autoReflect?: boolean;
  json?: boolean;
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

export function runSessionEnd(options: SessionEndOptions = {}): void {
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

  const sessionId = options.session ?? actor.session_id;
  if (!sessionId) {
    console.error('Error: no session ID provided. Use --session <id> or set BRAINCLAW_SESSION_ID.');
    process.exit(1);
  }

  // Get session notes for summary
  const agentNotes = listRuntimeNotes(actor.agent);
  const sessionNotes = agentNotes.filter(n => n.session_id === sessionId);

  // Compute context diff
  const snapshot = loadSessionSnapshot(sessionId);
  let contextDiff: string | undefined;
  if (snapshot?.initial_context_hash) {
    try {
      const currentCtx = buildContext({ target: snapshot.context_target, agent: actor.agent });
      const currentHash = createHash(JSON.stringify(currentCtx.selected));
      if (currentHash !== snapshot.initial_context_hash) {
        contextDiff = `Context changed since session start (${snapshot.initial_context_hash} → ${currentHash})`;
      } else {
        contextDiff = 'Context unchanged since session start';
      }
    } catch { /* non-fatal */ }
  }

  const summaryText = options.summary
    ? options.summary
    : `Session ended — ${sessionNotes.length} runtime note(s) created`;

  // Write session_end runtime note
  const noteId = generateRuntimeNoteId();
  saveRuntimeNote({
    id: noteId,
    agent: actor.agent,
    agent_id: actor.agent_id,
    project_id: actor.project_id,
    session_id: sessionId,
    text: summaryText + (contextDiff ? `\n${contextDiff}` : ''),
    created_at: nowISO(),
    tags: ['session'],
    visibility: 'shared',
    note_type: 'session_end',
  });

  appendAuditEntry({ action: 'session_end', actor: actor.agent, actor_id: actor.agent_id, item_id: sessionId, item_type: 'session' });

  // Auto-reflect: generate candidates from session notes
  let candidatesCreated = 0;
  if (options.autoReflect && sessionNotes.length > 0) {
    for (const note of sessionNotes) {
      if (note.note_type === 'observation' || !note.note_type) {
        try {
          createCandidateFromInput(note.text, 'decision', {
            tag: note.tags,
            author: note.agent,
            authorId: note.agent_id,
            projectId: note.project_id,
            sessionId: note.session_id,
          }, false, false);
          candidatesCreated++;
        } catch { /* skip */ }
      }
    }
  }

  const result = {
    session_id: sessionId,
    agent: actor.agent,
    notes_in_session: sessionNotes.length,
    candidates_created: candidatesCreated,
    context_diff: contextDiff,
    summary: summaryText,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`✔ Session ended: ${sessionId} (${actor.agent})`);
  console.log(`  Runtime notes in session: ${sessionNotes.length}`);
  if (options.autoReflect) {
    console.log(`  Candidates created from auto-reflect: ${candidatesCreated}`);
  }
  if (contextDiff) {
    console.log(`  ${contextDiff}`);
  }
}
