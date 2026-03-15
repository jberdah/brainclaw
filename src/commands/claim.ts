import { buildOperationalIdentity } from '../core/identity.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { saveClaim, generateClaimId, listClaims } from '../core/claims.js';
import { generateMarkdown } from '../core/markdown.js';
import { loadState, saveState } from '../core/state.js';
import { nowISO } from '../core/ids.js';
import type { OperationalIdentity } from '../core/identity.js';
import type { Claim } from '../core/schema.js';

export interface ClaimOptions {
  agent?: string;
  scope: string;
  project?: string;
  plan?: string;
}

export function runClaim(description: string, options: ClaimOptions): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let actor: OperationalIdentity;
  try {
    actor = buildOperationalIdentity(options.agent);
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Check for overlapping active claims on the same scope
  const existing = listClaims().filter(c => c.status === 'active' && c.scope === options.scope);
  if (existing.length > 0) {
    console.warn(`⚠ Active claim(s) already exist for scope "${options.scope}":`);
    for (const c of existing) {
      console.warn(`  [${c.id}] by ${c.agent}: ${c.description}`);
    }
    console.warn('  Proceeding anyway (advisory only).');
  }

  const state = loadState();
  const plan = options.plan ? state.plan_items.find((item) => item.id === options.plan) : undefined;
  if (options.plan && !plan) {
    console.error(`Error: Plan item '${options.plan}' not found.`);
    process.exit(1);
  }

  const id = generateClaimId();
  const claim: Claim = {
    id,
    agent: actor.agent,
    agent_id: actor.agent_id,
    project_id: actor.project_id,
    host_id: actor.host_id,
    session_id: actor.session_id,
    scope: options.scope,
    description,
    created_at: nowISO(),
    project: options.project ?? plan?.project,
    plan_id: options.plan,
    status: 'active',
  };

  if (plan) {
    if (!plan.assignee) {
      plan.assignee = actor.agent;
    }
    if (plan.status === 'todo') {
      plan.status = 'in_progress';
    }
    plan.updated_at = nowISO();
    saveState(state);
    writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));
  }

  saveClaim(claim);
  const planInfo = claim.plan_id ? ` [plan ${claim.plan_id}]` : '';
  console.log(`✔ Claim created: [${id}] ${actor.agent} → ${options.scope}: ${description}${planInfo}`);
}
