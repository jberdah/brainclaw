import { loadState, saveState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { mutate } from '../core/mutation-pipeline.js';
import { rebuildProjectMd } from '../core/markdown.js';
import { deleteRuntimeNote, listRuntimeNotes } from '../core/runtime.js';
import { expireStaleActiveClaims } from '../core/claims.js';

export interface PruneOptions {
  expired?: boolean;
}

export function runPrune(options: PruneOptions = {}): void {
  const cwd = process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Project memory not initialized. Run `brainclaw init` first.');
    process.exit(1);
  }

  const now = new Date().toISOString();
  let prunedCount = 0;
  let expiredClaimsCount = 0;
  let expiredNotesCount = 0;

  mutate({ cwd }, () => {
    const state = loadState(cwd);
    const originalLength = state.active_constraints.length;

    for (const c of state.active_constraints) {
      if (c.status === 'active' && c.expires_at && c.expires_at < now) {
        c.status = 'expired';
      }
    }

    state.active_constraints = state.active_constraints.filter(c => c.status !== 'expired');
    prunedCount = originalLength - state.active_constraints.length;
    saveState(state, cwd);
    expiredClaimsCount = expireStaleActiveClaims(cwd);

    if (options.expired) {
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

    rebuildProjectMd(loadState(cwd), cwd);
  });

  if (options.expired) {
    console.log(`✔ Pruned ${prunedCount} expired constraints, ${expiredNotesCount} expired runtime notes, ${expiredClaimsCount} expired claims.`);
  } else {
    console.log(`✔ Pruned ${prunedCount} expired constraints, ${expiredClaimsCount} expired claims.`);
  }
}
