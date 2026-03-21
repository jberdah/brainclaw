import { loadState, persistState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { nowISO } from '../core/ids.js';

export function runCompleteStep(planId: string, stepId: string): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState();
  const plan = state.plan_items.find((p) => p.id === planId || p.short_label === planId);
  if (!plan) {
    console.error(`Error: Plan '${planId}' not found.`);
    process.exit(1);
  }

  const step = (plan.steps ?? []).find((s) => s.id === stepId);
  if (!step) {
    console.error(`Error: Step '${stepId}' not found in plan '${planId}'.`);
    process.exit(1);
  }

  step.status = 'done';
  step.updated_at = nowISO();
  plan.updated_at = nowISO();

  persistState(state);

  const total = plan.steps!.length;
  const done = plan.steps!.filter((s) => s.status === 'done').length;
  console.log(`✔ Step completed: [${step.id}] ${step.text}`);
  console.log(`  Plan [${plan.id}] progress: ${done}/${total} steps done`);
  if (done === total) {
    console.log(`  All steps done — consider: brainclaw update-plan ${plan.id} --status done`);
  }
}
