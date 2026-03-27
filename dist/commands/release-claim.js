import { memoryExists } from '../core/io.js';
import { mutate } from '../core/mutation-pipeline.js';
import { loadClaim, listClaims, releaseClaim } from '../core/claims.js';
import { rebuildProjectMd } from '../core/markdown.js';
import { loadState, mutateState } from '../core/state.js';
export function runReleaseClaim(id, options = {}) {
    if (!memoryExists(options.cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    try {
        let claim = loadClaim(id, options.cwd);
        mutate({ cwd: options.cwd }, () => {
            const existing = loadClaim(id, options.cwd);
            claim = releaseClaim(id, options.cwd);
            if (existing.plan_id) {
                const updated = mutateState((state) => {
                    const plan = state.plan_items.find((item) => item.id === existing.plan_id);
                    if (!plan) {
                        return false;
                    }
                    const otherActiveClaims = listClaims(options.cwd).filter((item) => item.status === 'active' && item.plan_id === existing.plan_id);
                    if (options.planStatus) {
                        plan.status = options.planStatus;
                    }
                    else if (otherActiveClaims.length === 0 && plan.status === 'in_progress') {
                        plan.status = 'todo';
                    }
                    if (otherActiveClaims.length === 0 && plan.assignee === existing.agent) {
                        plan.assignee = undefined;
                    }
                    plan.updated_at = new Date().toISOString();
                    return true;
                }, options.cwd, { writeProjectMarkdown: false });
                if (updated) {
                    const state = loadState(options.cwd);
                    rebuildProjectMd(state, options.cwd);
                }
            }
        });
        console.log(`✔ Claim [${id}] released (was: ${claim.agent} → ${claim.scope})`);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}
//# sourceMappingURL=release-claim.js.map