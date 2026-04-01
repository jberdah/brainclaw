import { runPlan, type PlanOptions } from './plan.js';
import { runListPlans } from './list-plans.js';
import { runUpdatePlan, type UpdatePlanOptions } from './update-plan.js';
import { runDeletePlan } from './delete-plan.js';
import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';

interface PlanResourceOptions extends PlanOptions, UpdatePlanOptions {
  json?: boolean;
  all?: boolean;
  recursive?: boolean;
}

const KNOWN_SUBCOMMANDS = new Set(['create', 'list', 'ls', 'update', 'delete', 'show', 'get']);

export function runPlanResource(subcommand: string, args: string[], options: PlanResourceOptions = {}): void {
  const normalized = subcommand.trim().toLowerCase();

  if (normalized === 'create') {
    const text = args.join(' ').trim();
    if (!text) {
      console.error('Error: plan create requires <text>');
      process.exit(1);
    }
    runPlan(text, options);
    return;
  }

  if (normalized === 'list' || normalized === 'ls') {
    runListPlans({
      json: options.json,
      status: options.status,
      type: options.type,
      assignee: options.assignee,
      project: options.project,
      all: options.all,
      recursive: options.recursive,
    });
    return;
  }

  if (normalized === 'show' || normalized === 'get') {
    const id = args[0];
    if (!id) {
      console.error(`Error: plan ${normalized} requires <id>.`);
      console.error(`  Usage: brainclaw plan ${normalized} <id>`);
      process.exit(1);
    }
    runShowPlan(id, options);
    return;
  }

  if (normalized === 'update') {
    const id = args[0];
    if (!id) {
      console.error('Error: plan update requires <id>.');
      console.error('  Usage: brainclaw plan update <id> --status <status>');
      process.exit(1);
    }
    runUpdatePlan(id, {
      status: options.status,
      assignee: options.assignee,
      project: options.project,
      priority: options.priority,
      actualEffort: options.actualEffort,
      cwd: options.cwd,
    });
    return;
  }

  if (normalized === 'delete') {
    const id = args[0];
    if (!id) {
      console.error('Error: plan delete requires <id>.');
      console.error('  Usage: brainclaw plan delete <id>');
      process.exit(1);
    }
    runDeletePlan(id, { cwd: options.cwd });
    return;
  }

  // Reject known-looking subcommands to prevent accidental plan creation
  if (normalized.startsWith('pln_') || KNOWN_SUBCOMMANDS.has(normalized)) {
    console.error(`Error: unknown plan subcommand "${subcommand}".`);
    console.error('  Available: create, list, show, get, update, delete');
    process.exit(1);
  }

  // Compatibility path: `brainclaw plan "text"` still creates a plan.
  const legacyText = [subcommand, ...args].join(' ').trim();
  if (!legacyText) {
    console.error('Error: missing plan subcommand or description.');
    process.exit(1);
  }
  runPlan(legacyText, options);
}

function runShowPlan(id: string, options: PlanResourceOptions): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
  const state = loadState(options.cwd);
  const plan = state.plan_items.find(p => p.id === id);
  if (!plan) {
    console.error(`Error: plan not found: ${id}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`Plan: ${plan.id}`);
  console.log(`  Text:     ${plan.text}`);
  console.log(`  Status:   ${plan.status}`);
  if (plan.type) console.log(`  Type:     ${plan.type}`);
  if (plan.priority) console.log(`  Priority: ${plan.priority}`);
  if (plan.assignee) console.log(`  Assignee: ${plan.assignee}`);
  if (plan.project) console.log(`  Project:  ${plan.project}`);
  if (plan.estimated_effort) console.log(`  Estimate: ${plan.estimated_effort}min`);
  if (plan.actual_effort) console.log(`  Actual:   ${plan.actual_effort}`);
  if (plan.tags && plan.tags.length > 0) console.log(`  Tags:     ${plan.tags.join(', ')}`);
  console.log(`  Created:  ${plan.created_at}`);
  if (plan.updated_at) console.log(`  Updated:  ${plan.updated_at}`);
  if (plan.steps && plan.steps.length > 0) {
    console.log('  Steps:');
    for (const step of plan.steps) {
      const check = step.status === 'done' ? '✔' : '○';
      console.log(`    ${check} ${step.text}`);
    }
  }
}
