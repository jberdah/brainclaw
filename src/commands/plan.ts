import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { requireInitialized } from '../core/guards.js';
import { validateCliInput } from '../core/input-validation.js';
import { runListPlans } from './list-plans.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import { createPlan } from '../core/operations/plan.js';
import type { PlanType, Priority } from '../core/schema.js';

export interface PlanOptions {
  type?: PlanType;
  priority?: Priority;
  assignee?: string;
  project?: string;
  tag?: string[];
  path?: string[];
  author?: string;
  dependsOn?: string[];
  estimate?: string | number;
  cwd?: string;
  store?: StoreTarget;
}

// Known plan subcommands that should not be accepted as plan text
const PLAN_SUBCOMMAND_ALIASES = new Set(['list', 'ls']);
const PLAN_SUBCOMMAND_ERRORS = new Set(['update']);

export function runPlan(text: string, options: PlanOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  requireInitialized(cwd);

  const normalized = text.trim().toLowerCase();
  if (PLAN_SUBCOMMAND_ALIASES.has(normalized)) {
    runListPlans({});
    return;
  }
  if (PLAN_SUBCOMMAND_ERRORS.has(normalized)) {
    console.error(`Error: '${text}' looks like a subcommand, not a plan description.`);
    console.error('  To update a plan, use: brainclaw plan update <id> --status <status>');
    process.exit(1);
  }

  validateCliInput(text, options.tag);

  const config = loadConfig(cwd);
  const warnings = scanText(text, config);
  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error('Blocked: strict redaction is enabled. Entry not added.');
      process.exit(1);
    }
  }

  // Validate and normalise --estimate: must be a positive integer (minutes)
  let estimatedEffort: number | undefined;
  if (options.estimate !== undefined) {
    const n = typeof options.estimate === 'number' ? options.estimate : parseInt(String(options.estimate), 10);
    if (!Number.isInteger(n) || n <= 0) {
      console.error('Error: --estimate must be a positive integer representing minutes (e.g. --estimate 30)');
      process.exit(1);
    }
    estimatedEffort = n;
  }

  const result = createPlan({
    text,
    author: options.author ?? resolveCurrentAgentName(cwd),
    type: options.type,
    priority: options.priority,
    assignee: options.assignee,
    project: options.project,
    tags: options.tag,
    relatedPaths: options.path,
    dependsOn: options.dependsOn,
    estimatedEffort,
  }, cwd);

  const storeLabel = options.store && options.store !== 'local' ? ` [store:${options.store}]` : '';
  console.log(`✔ Plan item added: [${result.id}] ${text}${storeLabel}`);
}
