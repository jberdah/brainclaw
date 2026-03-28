import { requireInitialized } from '../core/guards.js';
import { validateCliInput } from '../core/input-validation.js';
import { addStep } from '../core/operations/plan.js';

export interface AddStepOptions {
  assignee?: string;
}

export function runAddStep(planId: string, text: string, options: AddStepOptions = {}): void {
  requireInitialized(process.cwd());

  validateCliInput(text);

  try {
    const result = addStep({ planId, text, assignee: options.assignee });

    console.log(`✔ Step added: [${result.stepId}] ${text}`);
    console.log(`  Plan [${result.planId}] progress: ${result.doneSteps}/${result.totalSteps} steps done`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
