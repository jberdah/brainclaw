import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { listArchivedCandidates, deleteArchivedCandidate } from '../core/candidates.js';

export interface PruneOptions {
  days?: number;
  dryRun?: boolean;
}

export function runPruneCandidates(options: PruneOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig();
  const maxDays = options.days ?? config.reflective_memory?.prune_rejected_after_days ?? 30;
  const cutoff = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000).toISOString();

  const rejected = listArchivedCandidates('rejected');
  const toPrune = rejected.filter(c => {
    const date = c.resolved_at ?? c.created_at;
    return date < cutoff;
  });

  if (toPrune.length === 0) {
    console.log(`No rejected candidates older than ${maxDays} days to prune.`);
    return;
  }

  if (options.dryRun) {
    console.log(`Would prune ${toPrune.length} rejected candidate(s):`);
    for (const c of toPrune) {
      console.log(`  [${c.id}] ${c.text}`);
    }
    return;
  }

  let pruned = 0;
  for (const c of toPrune) {
    if (deleteArchivedCandidate(c.id, 'rejected')) {
      pruned++;
    }
  }

  console.log(`✔ Pruned ${pruned} rejected candidate(s) older than ${maxDays} days.`);
}
