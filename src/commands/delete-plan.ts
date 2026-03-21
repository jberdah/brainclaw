import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';

export interface DeletePlanOptions {
  cwd?: string;
}

export function runDeletePlan(id: string, options: DeletePlanOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState(options.cwd);
  const index = state.plan_items.findIndex((item) => item.id === id || item.short_label === id);
  if (index < 0) {
    console.error(`Error: Plan item '${id}' not found.`);
    process.exit(1);
  }

  const [plan] = state.plan_items.splice(index, 1);
  persistState(state, options.cwd);

  console.log(`✔ Plan item deleted: [${plan.id}] ${plan.text}`);
}
