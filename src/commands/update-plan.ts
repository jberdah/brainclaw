import { loadState, saveState } from '../core/state.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { generateMarkdown } from '../core/markdown.js';
import { nowISO } from '../core/ids.js';
import type { PlanStatus, Priority } from '../core/schema.js';

export interface UpdatePlanOptions {
  status?: PlanStatus;
  assignee?: string;
  project?: string;
  priority?: Priority;
}

export function runUpdatePlan(id: string, options: UpdatePlanOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState();
  const plan = state.plan_items.find((item) => item.id === id);
  if (!plan) {
    console.error(`Error: Plan item '${id}' not found.`);
    process.exit(1);
  }

  if (options.status) plan.status = options.status;
  if (options.assignee !== undefined) plan.assignee = options.assignee;
  if (options.project !== undefined) plan.project = options.project;
  if (options.priority) plan.priority = options.priority;
  plan.updated_at = nowISO();

  saveState(state);
  writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));

  console.log(`✔ Plan item updated: [${plan.id}] ${plan.text}`);
}