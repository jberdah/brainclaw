import { memoryExists } from '../core/io.js';
import { buildOperationalIdentity, clearCurrentSession } from '../core/identity.js';
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
  cwd?: string;
}

export interface SessionEndResult {
  session_id: string;
  agent: string;
  notes_in_session: number;
  candidates_created: number;
  context_diff?: string;
  summary: string;
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
  try {
    const result = endSession(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`✔ Session ended: ${result.session_id} (${result.agent})`);
    console.log(`  Runtime notes in session: ${result.notes_in_session}`);
    if (options.autoReflect) {
      console.log(`  Candidates created from auto-reflect: ${result.candidates_created}`);
    }
    if (result.context_diff) {
      console.log(`  ${result.context_diff}`);
    }
  } catch (e: unknown) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function endSession(options: SessionEndOptions = {}): SessionEndResult {
  if (!memoryExists(options.cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const actor = buildOperationalIdentity(options.agent, options.cwd);

  const sessionId = options.session ?? actor.session_id;
  if (!sessionId) {
    throw new Error('no session ID provided. Use --session <id> or set BRAINCLAW_SESSION_ID.');
  }

  // Get session notes for summary
  const agentNotes = listRuntimeNotes(actor.agent, options.cwd);
  const sessionNotes = agentNotes.filter(n => n.session_id === sessionId);

  // Compute context diff
  const snapshot = loadSessionSnapshot(sessionId, options.cwd);
  let contextDiff: string | undefined;
  if (snapshot?.initial_context_hash) {
    try {
      const currentCtx = buildContext({ target: snapshot.context_target, agent: actor.agent, cwd: options.cwd });
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
  }, options.cwd);

  appendAuditEntry({ action: 'session_end', actor: actor.agent, actor_id: actor.agent_id, item_id: sessionId, item_type: 'session' }, options.cwd);
  clearCurrentSession(options.cwd, sessionId);

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
            cwd: options.cwd,
          }, false, false);
          candidatesCreated++;
        } catch { /* skip */ }
      }
    }
  }

  const result: SessionEndResult = {
    session_id: sessionId,
    agent: actor.agent,
    notes_in_session: sessionNotes.length,
    candidates_created: candidatesCreated,
    context_diff: contextDiff,
    summary: summaryText,
  };
  return result;
}
