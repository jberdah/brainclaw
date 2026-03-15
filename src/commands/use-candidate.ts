import { memoryExists } from '../core/io.js';
import { addCandidateUse } from '../core/candidates.js';
import { loadConfig } from '../core/config.js';

export interface UseCandidateOptions {
  by?: string;
  context?: string;
}

export function runUseCandidate(id: string, options: UseCandidateOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const actor = options.by ?? process.env.USER ?? process.env.USERNAME ?? 'unknown';
  const context = options.context;
  if (!context) {
    console.error('Error: --context is required.');
    process.exit(1);
  }

  try {
    const { candidate, added } = addCandidateUse(id, actor, context);
    const config = loadConfig().reflective_memory;
    const starThreshold = config?.promotion_stars_threshold ?? 3;
    const usesThreshold = config?.promotion_uses_threshold ?? 2;
    const recommendation = (candidate.star_count >= starThreshold || candidate.usage_count >= usesThreshold)
      ? ' Promotion is now recommended.'
      : '';

    if (!added) {
      console.log(`✔ Candidate [${id}] was already marked used by ${actor} in '${context}' (${candidate.usage_count} use(s))`);
      return;
    }

    console.log(`✔ Candidate [${id}] used by ${actor} in '${context}' (${candidate.usage_count}/${usesThreshold} uses)${recommendation}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}