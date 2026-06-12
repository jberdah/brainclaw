import { requireInitialized } from '../core/guards.js';
import { updateStep } from '../core/operations/plan.js';
import type { PlanStepStatus } from '../core/schema.js';

export interface UpdateStepCliOptions {
  status?: string;
  text?: string;
  assign?: string;
  estimate?: number | string;
  actualEffort?: string;
}

export function runUpdateStep(planId: string, stepId: string, options: UpdateStepCliOptions): void {
  requireInitialized(process.cwd());

  const validStatuses = ['todo', 'in_progress', 'testing', 'done', 'blocked'];
  if (options.status && !validStatuses.includes(options.status)) {
    console.error(`Error: Invalid status '${options.status}'. Valid: ${validStatuses.join(', ')}`);
    process.exit(1);
  }

  try {
    const result = updateStep({
      planId,
      stepId,
      status: options.status as PlanStepStatus | undefined,
      text: options.text,
      assignee: options.assign,
      estimatedEffort: options.estimate,
      actualEffort: options.actualEffort,
    });

    const changes: string[] = [];
    if (options.status) changes.push(`status=${options.status}`);
    if (options.text) changes.push('text updated');
    if (options.assign !== undefined) changes.push(`assignee=${options.assign || 'unassigned'}`);
    if (options.estimate !== undefined) changes.push(`estimate=${options.estimate}`);
    if (options.actualEffort !== undefined) changes.push(`actual=${options.actualEffort}`);
    console.log(`✔ Step updated: [${result.stepId}] ${changes.join(', ')}`);
    console.log(`  Plan [${result.planId}] progress: ${result.doneSteps}/${result.totalSteps} steps done`);
    if (result.planAutoCompleted) {
      console.log(`  All steps done — plan auto-completed.`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
