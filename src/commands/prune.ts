import fs from 'node:fs';
import path from 'node:path';
import { loadState, persistState } from '../core/state.js';
import { memoryExists, resolveEntityDir } from '../core/io.js';
import { mutate } from '../core/mutation-pipeline.js';
import { rebuildProjectMd } from '../core/markdown.js';
import { deleteRuntimeNote, listRuntimeNotes } from '../core/runtime.js';
import { expireStaleActiveClaims, isClaimExpired, listClaims } from '../core/claims.js';
import { archiveStalePlansAndHandoffs } from '../core/archival.js';
import { rotateAuditLogIfNeeded } from '../core/audit.js';
import { analyzeMemory, analyzeAndApply, formatReport } from '../core/memory-compactor.js';

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
    if (options.dryRun) {
      // Dry-run: read-only analysis, no lock needed
      const state = loadState(cwd);
      const report = analyzeMemory(state, { cwd });
      console.log(formatReport(report));
      return;
    }

    // Apply: analyze + apply atomically under a single mutation lock
    const { report, result } = analyzeAndApply({ cwd });

    if (report.archivableCount === 0) {
      console.log('No compaction opportunities found.');
      return;
    }

    console.log(formatReport(report));
    console.log('');
    console.log(`✔ Compaction applied: ${result.archivedCount} items archived (${result.mergedClusters} clusters merged, ${result.staleArchived} stale items).`);
    return;
  }

  // Original prune logic
  const now = new Date().toISOString();
  if (options.dryRun) {
    previewPrune(cwd, now, options);
    return;
  }

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
    // deleteMissing: this RMW is atomic (loadState above runs under the same
    // mutate() lock), so removing pruned files here cannot clobber concurrent writes.
    persistState(state, cwd, { writeProjectMarkdown: false, deleteMissing: true });
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

function previewPrune(cwd: string, now: string, options: PruneOptions): void {
  const state = loadState(cwd);
  const expiredConstraints = state.active_constraints.filter((c) => c.status === 'expired' || (c.status === 'active' && c.expires_at && c.expires_at < now));
  const expiredClaims = listClaims(cwd).filter((claim) => claim.status === 'active' && isClaimExpired(claim));
  const expiredNotes = options.expired
    ? listRuntimeNotes(undefined, cwd).filter((note) => note.expires_at && note.expires_at < now)
    : [];
  const archivePreview = options.archive ? previewArchive(cwd) : [];

  console.log('Dry run: no files will be changed.');
  console.log(`Would prune ${expiredConstraints.length} expired constraints.`);
  for (const constraint of expiredConstraints) {
    console.log(`  - constraint ${constraint.id}: ${constraint.text.slice(0, 80)}`);
  }
  console.log(`Would release ${expiredClaims.length} expired claims.`);
  for (const claim of expiredClaims) {
    console.log(`  - claim ${claim.id}: ${claim.scope}`);
  }
  if (options.expired) {
    console.log(`Would delete ${expiredNotes.length} expired runtime notes.`);
    for (const note of expiredNotes) {
      console.log(`  - runtime note ${note.id}: ${note.agent}`);
    }
  }
  if (options.archive) {
    const total = archivePreview.reduce((sum, item) => sum + item.ids.length, 0);
    console.log(`Would archive ${total} stale plans/handoffs.`);
    for (const item of archivePreview) {
      for (const id of item.ids) {
        console.log(`  - ${item.entity} ${id}`);
      }
    }
  }
}

function previewArchive(cwd: string): Array<{ entity: string; ids: string[] }> {
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return [
    {
      entity: 'plans',
      ids: listArchiveEligibleIds(cwd, 'plans', cutoff, (item) => item.status === 'done' || item.status === 'dropped'),
    },
    {
      entity: 'handoffs',
      ids: listArchiveEligibleIds(cwd, 'handoffs', cutoff, (item) => item.status === 'closed'),
    },
  ].filter((entry) => entry.ids.length > 0);
}

function listArchiveEligibleIds(
  cwd: string,
  entity: string,
  cutoffDate: string,
  isEligible: (item: Record<string, unknown>) => boolean,
): string[] {
  const dir = resolveEntityDir(entity, cwd, 'read');
  if (!fs.existsSync(dir)) return [];
  const ids: string[] = [];
  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json') && entry !== 'archive.json')) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as Record<string, unknown>;
      const date = (item.completed_at ?? item.updated_at ?? item.created_at) as string | undefined;
      if (!isEligible(item)) continue;
      if (date && date > cutoffDate) continue;
      ids.push(typeof item.id === 'string' ? item.id : path.basename(file, '.json'));
    } catch { /* ignore malformed files in preview */ }
  }
  return ids;
}
