import { memoryExists } from '../core/io.js';
import { loadCandidate, listCandidates } from '../core/candidates.js';

export interface ShowCandidateOptions {
  related?: boolean;
}

export function runShowCandidate(id: string, options: ShowCandidateOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
    const candidate = loadCandidate(id);
    if (!options.related) {
      console.log(JSON.stringify(candidate, null, 2));
      return;
    }

    // Find related candidates by shared tags or related_paths
    const allPending = listCandidates('pending').filter(c => c.id !== id);
    const cTags = new Set(candidate.tags ?? []);
    const cPaths = new Set(candidate.related_paths ?? []);

    const related = allPending.filter(c => {
      const sharedTag = (c.tags ?? []).some(t => cTags.has(t));
      const sharedPath = (c.related_paths ?? []).some(p => cPaths.has(p));
      return sharedTag || sharedPath;
    });

    console.log(JSON.stringify({ ...candidate, related_candidates: related }, null, 2));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

