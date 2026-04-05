import { requireInitialized } from '../core/guards.js';
import { updatePlan } from '../core/operations/plan.js';
import type { PlanStatus, Priority } from '../core/schema.js';

export interface UpdatePlanOptions {
  status?: PlanStatus;
  assignee?: string;
  project?: string;
  priority?: Priority;
  actualEffort?: string;
  cwd?: string;
}

export function runUpdatePlan(id: string, options: UpdatePlanOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  requireInitialized(cwd);

  if (id.startsWith('stp_')) {
    console.error(`Error: '${id}' looks like a step ID, not a plan ID.`);
    console.error('  Use: brainclaw complete-step <planId> <stepId>');
    console.error('  Inspect the parent plan with: brainclaw plan show <planId>');
    process.exit(1);
  }

  try {
    const result = updatePlan({
      id,
      status: options.status,
      assignee: options.assignee,
      priority: options.priority,
      actualEffort: options.actualEffort,
    }, cwd);

    console.log(`✔ Plan item updated: [${result.id}] ${result.text}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
