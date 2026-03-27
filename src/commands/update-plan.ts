import { mutateState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { nowISO } from '../core/ids.js';
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
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
    const plan = mutateState((state) => {
      const plan = state.plan_items.find((item) => item.id === id);
      if (!plan) {
        throw new Error(`Plan item '${id}' not found.`);
      }

      const timestamp = nowISO();
      if (options.status) {
        plan.status = options.status;
        if (options.status === 'in_progress' && !plan.started_at) plan.started_at = timestamp;
        if (options.status === 'done' && !plan.completed_at) plan.completed_at = timestamp;
      }
      if (options.assignee !== undefined) plan.assignee = options.assignee;
      if (options.project !== undefined) plan.project = options.project;
      if (options.priority) plan.priority = options.priority;
      if (options.actualEffort) plan.actual_effort = options.actualEffort;
      plan.updated_at = timestamp;
      return { id: plan.id, text: plan.text };
    }, options.cwd);

    console.log(`✔ Plan item updated: [${plan.id}] ${plan.text}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
