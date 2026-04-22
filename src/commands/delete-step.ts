import { requireInitialized } from '../core/guards.js';
import { deleteStep } from '../core/operations/plan.js';

export function runDeleteStep(planId: string, stepId: string): void {
  requireInitialized(process.cwd());

  try {
    const result = deleteStep({ planId, stepId });

    console.log(`✔ Step deleted: [${result.stepId}]`);
    console.log(`  Plan [${result.planId}]: ${result.totalSteps} step(s) remaining (${result.doneSteps} done)`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
