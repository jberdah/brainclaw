import { loadState, saveState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { deleteRuntimeNote, listRuntimeNotes } from '../core/runtime.js';

export interface PruneOptions {
  expired?: boolean;
}

export function runPrune(options: PruneOptions = {}): void {
  const cwd = process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Project memory not initialized. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState(cwd);
  const now = new Date().toISOString();

  const originalLength = state.active_constraints.length;
  
  // Transition expired constraints to "expired"
  for (const c of state.active_constraints) {
    if (c.status === 'active' && c.expires_at && c.expires_at < now) {
      c.status = 'expired';
    }
  }

  // Filter out constraints that have been expired for a while to keep memory clean
  // For the MVP, we just remove them if they are expired
  state.active_constraints = state.active_constraints.filter(c => c.status !== 'expired');
  
  const prunedCount = originalLength - state.active_constraints.length;

  saveState(state, cwd);

  let expiredNotesCount = 0;
  if (options.expired) {
    // Prune expired runtime notes
    const notes = listRuntimeNotes(undefined, cwd);
    for (const note of notes) {
      if (note.expires_at && note.expires_at < now) {
        try {
          if (deleteRuntimeNote(note, cwd)) {
            expiredNotesCount++;
          }
        } catch { /* ignore */ }
      }
    }
  }

  if (options.expired) {
    console.log(`✔ Pruned ${prunedCount} expired constraints and ${expiredNotesCount} expired runtime notes.`);
  } else {
    console.log(`✔ Pruned ${prunedCount} expired constraints.`);
  }
}
