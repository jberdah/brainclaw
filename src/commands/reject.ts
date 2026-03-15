import { memoryExists } from '../core/io.js';
import { loadCandidate, archiveCandidate } from '../core/candidates.js';
import { nowISO } from '../core/ids.js';

export interface RejectResult {
  candidate_id: string;
  actor: string;
}

export function runReject(id: string, reason?: string, by?: string, cwd?: string): void {
  try {
    rejectCandidate(id, reason, by, cwd);
    console.log(`✔ Candidate [${id}] rejected and archived.`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

export function rejectCandidate(id: string, reason?: string, by?: string, cwd?: string): RejectResult {
  if (!memoryExists(cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const candidate = loadCandidate(id, cwd);

  if (candidate.status !== 'pending') {
    throw new Error(`Candidate '${id}' is already ${candidate.status}.`);
  }

  const actor = by ?? process.env.USER ?? process.env.USERNAME ?? 'unknown';
  candidate.status = 'rejected';
  candidate.resolved_at = nowISO();
  candidate.resolved_by = actor;
  if (reason) {
    candidate.resolution_reason = reason;
  }

  archiveCandidate(candidate, 'rejected', cwd);
  return { candidate_id: id, actor };
}
