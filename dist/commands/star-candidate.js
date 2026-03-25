import { memoryExists } from '../core/io.js';
import { addCandidateStar } from '../core/candidates.js';
import { loadConfig } from '../core/config.js';
export function runStarCandidate(id, options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const actor = options.by ?? process.env.USER ?? process.env.USERNAME ?? 'unknown';
    try {
        const { candidate, added } = addCandidateStar(id, actor);
        const threshold = loadConfig().reflective_memory?.promotion_stars_threshold ?? 3;
        if (!added) {
            console.log(`✔ Candidate [${id}] was already starred by ${actor} (${candidate.star_count} star(s))`);
            return;
        }
        const recommendation = candidate.star_count >= threshold
            ? ' Promotion is now recommended.'
            : '';
        console.log(`✔ Candidate [${id}] starred by ${actor} (${candidate.star_count}/${threshold})${recommendation}`);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}
//# sourceMappingURL=star-candidate.js.map