import { loadState, saveState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import { runListPlans } from './list-plans.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import type { PlanItem, Priority } from '../core/schema.js';

export interface PlanOptions {
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

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const normalized = text.trim().toLowerCase();
  if (PLAN_SUBCOMMAND_ALIASES.has(normalized)) {
    runListPlans({});
    return;
  }
  if (PLAN_SUBCOMMAND_ERRORS.has(normalized)) {
    console.error(`Error: '${text}' looks like a subcommand, not a plan description.`);
    console.error(`  To update a plan, use: brainclaw update-plan <id> --status <status>`);
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

  const state = loadState(cwd);
  const { id, short_label } = generateIdWithLabel('plan_items');
  const timestamp = nowISO();

  const entry: PlanItem = {
    id,
    short_label,
    text,
    created_at: timestamp,
    updated_at: timestamp,
    author: options.author ?? resolveCurrentAgentName(cwd),
    status: 'todo',
    priority: options.priority ?? 'medium',
    assignee: options.assignee,
    project: options.project,
    tags: options.tag ?? [],
    related_paths: options.path,
    depends_on: options.dependsOn ?? [],
    estimated_effort: estimatedEffort,
  };

  state.plan_items.push(entry);
  saveState(state, cwd);
  writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));

  const storeLabel = options.store && options.store !== 'local' ? ` [store:${options.store}]` : '';
  console.log(`✔ Plan item added: [${id}] ${text}${storeLabel}`);
}

