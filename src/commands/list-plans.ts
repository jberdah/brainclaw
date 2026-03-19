import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import type { PlanStatus, PlanType } from '../core/schema.js';

export interface ListPlansOptions {
  json?: boolean;
  status?: PlanStatus;
  type?: PlanType;
  assignee?: string;
  project?: string;
  all?: boolean;
}

export function runListPlans(options: ListPlansOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let plans = loadState().plan_items;

  if (!options.all) {
    plans = plans.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  }
  if (options.status) {
    plans = plans.filter((plan) => plan.status === options.status);
  }
  if (options.type) {
    plans = plans.filter((plan) => plan.type === options.type);
  }
  if (options.assignee) {
    const target = options.assignee.toLowerCase();
    plans = plans.filter((plan) => plan.assignee?.toLowerCase() === target);
  }
  if (options.project) {
    const project = options.project.toLowerCase();
    plans = plans.filter((plan) => plan.project?.toLowerCase() === project);
  }

  if (options.json) {
    console.log(JSON.stringify(plans, null, 2));
    return;
  }

  if (plans.length === 0) {
    console.log('No plan items found.');
    return;
  }

  console.log(`${plans.length} plan item(s):`);
  console.log('');
  for (const plan of plans) {
    const meta: string[] = [plan.type ?? 'feat', plan.status, plan.priority];
    if (plan.assignee) meta.push(`assignee ${plan.assignee}`);
    if (plan.project) meta.push(`project ${plan.project}`);
    if (plan.depends_on.length > 0) meta.push(`depends_on ${plan.depends_on.join(',')}`);
    const tags = plan.tags.length ? ` [${plan.tags.join(', ')}]` : '';
    console.log(`  [${plan.id}] ${plan.text} (${meta.join(' · ')})${tags}`);
  }
}