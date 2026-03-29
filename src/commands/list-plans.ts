import path from 'node:path';
import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import type { PlanItem, PlanStatus, PlanType } from '../core/schema.js';
import { scanNestedBrainclawProjects } from '../core/workspace-projects.js';

export interface ListPlansOptions {
  json?: boolean;
  status?: PlanStatus;
  type?: PlanType;
  assignee?: string;
  project?: string;
  all?: boolean;
  recursive?: boolean;
  cwd?: string;
}

export interface DescendantPlanGroup {
  path: string;
  relative_path: string;
  project_name?: string;
  plans: PlanItem[];
}

function filterPlans(plans: PlanItem[], options: ListPlansOptions): PlanItem[] {
  let filtered = plans;
  if (!options.all) {
    filtered = filtered.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  }
  if (options.status) {
    filtered = filtered.filter((plan) => plan.status === options.status);
  }
  if (options.type) {
    filtered = filtered.filter((plan) => plan.type === options.type);
  }
  if (options.assignee) {
    const target = options.assignee.toLowerCase();
    filtered = filtered.filter((plan) => plan.assignee?.toLowerCase() === target);
  }
  if (options.project) {
    const project = options.project.toLowerCase();
    filtered = filtered.filter((plan) => plan.project?.toLowerCase() === project);
  }
  return filtered;
}

function formatPlan(plan: PlanItem): string {
  const meta: string[] = [plan.type ?? 'feat', plan.status, plan.priority];
  if (plan.assignee) meta.push(`assignee ${plan.assignee}`);
  if (plan.project) meta.push(`project ${plan.project}`);
  if (plan.depends_on.length > 0) meta.push(`depends_on ${plan.depends_on.join(',')}`);
  const tags = plan.tags.length ? ` [${plan.tags.join(', ')}]` : '';
  return `  [${plan.id}] ${plan.text} (${meta.join(' · ')})${tags}`;
}

export function scanDescendantPlans(cwd: string, options: ListPlansOptions): DescendantPlanGroup[] {
  const resolvedCwd = path.resolve(cwd ?? process.cwd());
  const descendants = scanNestedBrainclawProjects(resolvedCwd);
  const groups: DescendantPlanGroup[] = [];
  for (const project of descendants) {
    try {
      const plans = filterPlans(loadState(project.path).plan_items, options);
      if (plans.length > 0) {
        groups.push({
          path: project.path,
          relative_path: path.relative(resolvedCwd, project.path),
          project_name: project.project_name,
          plans,
        });
      }
    } catch { /* skip unreadable project */ }
  }
  return groups;
}

export function runListPlans(options: ListPlansOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const localPlans = filterPlans(loadState(options.cwd).plan_items, options);

  if (options.recursive) {
    const cwd = options.cwd ?? process.cwd();
    const descendantGroups = scanDescendantPlans(cwd, options);
    const totalDescendantPlans = descendantGroups.reduce((sum, g) => sum + g.plans.length, 0);

    if (options.json) {
      console.log(JSON.stringify({
        local: localPlans,
        descendants: descendantGroups,
        total: localPlans.length + totalDescendantPlans,
      }, null, 2));
      return;
    }

    // Local plans
    console.log(`── local (${localPlans.length} plans) ──`);
    if (localPlans.length === 0) {
      console.log('  (none)');
    } else {
      for (const plan of localPlans) console.log(formatPlan(plan));
    }

    // Descendant plans
    for (const group of descendantGroups) {
      const label = group.project_name ?? group.relative_path;
      console.log(`\n── ${label} (${group.plans.length} plans) ──`);
      for (const plan of group.plans) console.log(formatPlan(plan));
    }

    if (localPlans.length === 0 && totalDescendantPlans === 0) {
      console.log('\nNo plan items found locally or in descendants.');
    }
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(localPlans, null, 2));
    return;
  }

  if (localPlans.length === 0) {
    // Check descendants for signal
    const cwd = options.cwd ?? process.cwd();
    const descendantGroups = scanDescendantPlans(cwd, options);
    const totalDescendantPlans = descendantGroups.reduce((sum, g) => sum + g.plans.length, 0);
    console.log('No plan items found.');
    if (totalDescendantPlans > 0) {
      console.log(`ℹ ${totalDescendantPlans} plan(s) found in ${descendantGroups.length} descendant project(s) (use --recursive to see all)`);
    }
    return;
  }

  console.log(`${localPlans.length} plan item(s):`);
  console.log('');
  for (const plan of localPlans) console.log(formatPlan(plan));
}
