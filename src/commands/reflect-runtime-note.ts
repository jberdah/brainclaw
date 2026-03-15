import { memoryExists } from '../core/io.js';
import { findRuntimeNoteById } from '../core/runtime.js';
import { createCandidateFromInput, type ReflectOptions } from './reflect.js';
import type { CandidateType } from '../core/schema.js';

export interface ReflectRuntimeNoteOptions extends ReflectOptions {
  type?: CandidateType;
  host?: string;
  allHosts?: boolean;
  json?: boolean;
  suggest?: boolean;
}

export function runReflectRuntimeNote(id: string, text: string | undefined, options: ReflectRuntimeNoteOptions): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const note = findRuntimeNoteById(id, {
    hostId: options.host,
    includeAllHosts: options.allHosts,
  });

  if (!note) {
    console.error(`Error: runtime note '${id}' not found in visible runtime memory.`);
    process.exit(1);
  }

  const suggestions = suggestCandidateTypes(note.text, note.tags);
  if (!options.type || options.suggest) {
    if (options.json) {
      console.log(JSON.stringify({ runtime_note: note, suggestions }, null, 2));
    } else {
      console.log(`Promotion suggestions for runtime note [${note.id}] (${note.visibility}${note.host_id ? `:${note.host_id}` : ''}):`);
      for (const suggestion of suggestions) {
        console.log(`  - ${suggestion.type} (${suggestion.score}) ${suggestion.reason}`);
      }
      if (!options.type) {
        return;
      }
      console.log('');
    }
  }

  if (!options.type) {
    return;
  }

  const candidateText = text?.trim() || note.text;
  const mergedTags = uniqueTags([...(note.tags ?? []), ...(options.tag ?? [])]);
  const reflectOptions: ReflectOptions = {
    ...options,
    tag: mergedTags,
    author: options.author ?? note.agent,
    authorId: note.agent_id,
    projectId: note.project_id,
    hostId: note.host_id,
    sessionId: note.session_id,
    source: options.source ?? `runtime-note:${note.agent}:${note.id}`,
  };

  createCandidateFromInput(candidateText, options.type, reflectOptions);
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => tag.trim().length > 0))];
}

function suggestCandidateTypes(text: string, tags: string[]): Array<{ type: CandidateType; score: number; reason: string }> {
  const haystack = `${text.toLowerCase()} ${tags.join(' ').toLowerCase()}`;
  const suggestions: Array<{ type: CandidateType; score: number; reason: string }> = [];

  let trapScore = 1;
  if (/(error|fail|flaky|broken|missing|workaround|retry|blocked|not on path|requires)/.test(haystack)) {
    trapScore += 3;
  }
  suggestions.push({ type: 'trap', score: trapScore, reason: 'Operational friction, workaround, or failure mode' });

  let constraintScore = 1;
  if (/(must|required|cannot|blocked|frozen|until|only)/.test(haystack)) {
    constraintScore += 3;
  }
  suggestions.push({ type: 'constraint', score: constraintScore, reason: 'Active limitation or operating boundary' });

  let decisionScore = 1;
  if (/(use |prefer|standard|go through|convention|policy)/.test(haystack)) {
    decisionScore += 3;
  }
  suggestions.push({ type: 'decision', score: decisionScore, reason: 'Reusable convention, policy, or chosen approach' });

  suggestions.push({ type: 'handoff', score: 1, reason: 'Use only if the note should become an explicit transfer of work' });

  return suggestions.sort((a, b) => b.score - a.score);
}