import { memoryExists } from '../core/io.js';
import { loadCandidate, archiveCandidate } from '../core/candidates.js';
import { nowISO } from '../core/ids.js';

export function runReject(id: string, reason?: string, by?: string): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let candidate;
  try {
    candidate = loadCandidate(id);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  if (candidate.status !== 'pending') {
    console.error(`Error: Candidate '${id}' is already ${candidate.status}.`);
    process.exit(1);
  }

  const actor = by ?? process.env.USER ?? process.env.USERNAME ?? 'unknown';
  candidate.status = 'rejected';
  candidate.resolved_at = nowISO();
  candidate.resolved_by = actor;
  if (reason) {
    candidate.resolution_reason = reason;
  }

  archiveCandidate(candidate, 'rejected');
  console.log(`✔ Candidate [${id}] rejected and archived.`);
}
