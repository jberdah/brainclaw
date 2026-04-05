import { loadState, saveState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { mutate } from '../core/mutation-pipeline.js';
import { rebuildProjectMd } from '../core/markdown.js';
import { deleteRuntimeNote, listRuntimeNotes } from '../core/runtime.js';
import { expireStaleActiveClaims } from '../core/claims.js';
import { archiveStalePlansAndHandoffs } from '../core/archival.js';
import { rotateAuditLogIfNeeded } from '../core/audit.js';
import { analyzeMemory, applyCompaction, formatReport } from '../core/memory-compactor.js';

export interface PruneOptions {
  expired?: boolean;
  archive?: boolean;
  semantic?: boolean;
  dryRun?: boolean;
}

export function runPrune(options: PruneOptions = {}): void {
  const cwd = process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Project memory not initialized. Run `brainclaw init` first.');
    process.exit(1);
  }

  // Semantic compaction mode
  if (options.semantic) {
    const state = loadState(cwd);
    const report = analyzeMemory(state, { cwd });

    if (options.dryRun || options.dryRun === undefined && !options.semantic) {
      console.log(formatReport(report));
      return;
    }

    if (report.archivableCount === 0) {
      console.log('No compaction opportunities found.');
      return;
    }

    // --semantic without --dry-run: apply
    console.log(formatReport(report));
    console.log('');
    const result = applyCompaction(report, { cwd });
    console.log(`✔ Compaction applied: ${result.archivedCount} items archived (${result.mergedClusters} clusters merged, ${result.staleArchived} stale items).`);
    return;
  }

  // Original prune logic
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

  // Archive and rotate outside the mutation lock (they manage their own IO)
  let archiveMsg = '';
  if (options.archive) {
    const archiveResults = archiveStalePlansAndHandoffs(cwd);
    if (archiveResults.length > 0) {
      const parts = archiveResults.map(r => `${r.archived} ${r.entity}`);
      archiveMsg = `, archived ${parts.join(' + ')} to cold storage`;
    }
  }
  const rotated = rotateAuditLogIfNeeded(cwd);
  const rotateMsg = rotated ? ', rotated audit.log' : '';

  if (options.expired) {
    console.log(`✔ Pruned ${prunedCount} expired constraints, ${expiredNotesCount} expired runtime notes, ${expiredClaimsCount} expired claims${archiveMsg}${rotateMsg}.`);
  } else {
    console.log(`✔ Pruned ${prunedCount} expired constraints, ${expiredClaimsCount} expired claims${archiveMsg}${rotateMsg}.`);
  }
}
