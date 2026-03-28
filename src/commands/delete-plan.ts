import { requireInitialized } from '../core/guards.js';
import { deletePlan } from '../core/operations/plan.js';

export interface DeletePlanOptions {
  cwd?: string;
}

export function runDeletePlan(id: string, options: DeletePlanOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  requireInitialized(cwd);

  try {
    const result = deletePlan(id, cwd);
    console.log(`✔ Plan item deleted: [${result.id}] ${result.text}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
