import { memoryExists } from '../core/io.js';
import { memoryPath, writeFileAtomic } from '../core/io.js';
import { loadClaim, listClaims, releaseClaim } from '../core/claims.js';
import { generateMarkdown } from '../core/markdown.js';
import { loadState, saveState } from '../core/state.js';

export interface ReleaseClaimOptions {
  planStatus?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'dropped';
}

export function runReleaseClaim(id: string, options: ReleaseClaimOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
    const existing = loadClaim(id);
    const claim = releaseClaim(id);
    if (existing.plan_id) {
      const state = loadState();
      const plan = state.plan_items.find((item) => item.id === existing.plan_id);
      if (plan) {
        const otherActiveClaims = listClaims().filter((item) => item.status === 'active' && item.plan_id === existing.plan_id);
        if (options.planStatus) {
          plan.status = options.planStatus;
        } else if (otherActiveClaims.length === 0 && plan.status === 'in_progress') {
          plan.status = 'todo';
        }
        if (otherActiveClaims.length === 0 && plan.assignee === existing.agent) {
          plan.assignee = undefined;
        }
        plan.updated_at = new Date().toISOString();
        saveState(state);
        writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));
      }
    }
    console.log(`✔ Claim [${id}] released (was: ${claim.agent} → ${claim.scope})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
