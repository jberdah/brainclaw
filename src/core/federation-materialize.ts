/**
 * Materialize incoming federation signals into local memory entities.
 *
 * Used by session-start for both local cross-project signals (Phase 0,
 * pulled from linked-project inboxes) and cloud signals (Phase 1, pulled
 * from app.brainclaw.dev). Returns true when the signal produced a stored
 * entity, false when it was skipped (unknown type or invalid payload).
 *
 * @module
 */
import type { FederationMessage } from './federation-message.js';
import { CandidateSchema, HandoffSchema, RuntimeNoteSchema } from './schema.js';
import { saveCandidate, generateCandidateIdWithLabel } from './candidates.js';
import { saveRuntimeNote, generateRuntimeNoteId } from './runtime.js';
import { generateIdWithLabel, nowISO } from './ids.js';
import { mutateState } from './state.js';

export function materializeFederationSignal(
  signal: FederationMessage,
  cwd?: string,
): boolean {
  const origin = `remote:${signal.from.project_name}:${signal.from.agent_name}`;

  if (signal.type === 'candidate') {
    const parsed = CandidateSchema.safeParse(signal.payload);
    if (!parsed.success) return false;
    const { id, short_label } = generateCandidateIdWithLabel(cwd);
    saveCandidate({
      ...parsed.data,
      id,
      short_label,
      created_at: nowISO(),
      source: undefined, // remote signal — treated as 'human' (legacy default)
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
      status: 'pending',
    }, cwd);
    return true;
  }

  if (signal.type === 'handoff') {
    const parsed = HandoffSchema.safeParse(signal.payload);
    if (!parsed.success) return false;
    const { id, short_label } = generateIdWithLabel('open_handoffs', cwd);
    mutateState((state) => {
      state.open_handoffs.push({
        ...parsed.data,
        id,
        short_label,
        created_at: nowISO(),
        tags: [...(parsed.data.tags ?? []), origin],
      });
    }, cwd);
    return true;
  }

  if (signal.type === 'runtime_note') {
    const parsed = RuntimeNoteSchema.safeParse(signal.payload);
    if (!parsed.success) return false;
    saveRuntimeNote({
      ...parsed.data,
      id: generateRuntimeNoteId(),
      created_at: nowISO(),
      tags: [...(parsed.data.tags ?? []), origin],
    }, cwd);
    return true;
  }

  return false;
}
