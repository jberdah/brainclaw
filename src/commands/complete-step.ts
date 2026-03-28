import { requireInitialized } from '../core/guards.js';
import { completeStep } from '../core/operations/plan.js';

export function runCompleteStep(planId: string, stepId: string): void {
  requireInitialized(process.cwd());

  try {
    const result = completeStep({ planId, stepId });

    console.log(`✔ Step completed: [${result.stepId}]`);
    console.log(`  Plan [${result.planId}] progress: ${result.doneSteps}/${result.totalSteps} steps done`);
    if (result.planAutoCompleted) {
      console.log(`  All steps done — plan auto-completed.`);
    } else if (result.doneSteps === result.totalSteps) {
      console.log(`  All steps done — consider: brainclaw update-plan ${result.planId} --status done`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
