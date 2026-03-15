import { loadState, saveState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import { runListPlans } from './list-plans.js';
import type { PlanItem, Priority } from '../core/schema.js';

export interface PlanOptions {
  priority?: Priority;
  assignee?: string;
  project?: string;
  tag?: string[];
  path?: string[];
  author?: string;
  dependsOn?: string[];
}

// Known plan subcommands that should not be accepted as plan text
const PLAN_SUBCOMMAND_ALIASES = new Set(['list', 'ls']);
const PLAN_SUBCOMMAND_ERRORS = new Set(['update']);

export function runPlan(text: string, options: PlanOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const normalized = text.trim().toLowerCase();
  if (PLAN_SUBCOMMAND_ALIASES.has(normalized)) {
    // 'brainclaw plan list' → forward to list-plans
    runListPlans({});
    return;
  }
  if (PLAN_SUBCOMMAND_ERRORS.has(normalized)) {
    console.error(`Error: '${text}' looks like a subcommand, not a plan description.`);
    console.error(`  To update a plan, use: brainclaw update-plan <id> --status <status>`);
    process.exit(1);
  }

  validateCliInput(text, options.tag);

  const config = loadConfig();
  const warnings = scanText(text, config);
  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error('Blocked: strict redaction is enabled. Entry not added.');
      process.exit(1);
    }
  }

  const state = loadState();
  const { id, short_label } = generateIdWithLabel('plan_items');
  const timestamp = nowISO();

  const entry: PlanItem = {
    id,
    short_label,
    text,
    created_at: timestamp,
    updated_at: timestamp,
    author: options.author ?? resolveCurrentAgentName(),
    status: 'todo',
    priority: options.priority ?? 'medium',
    assignee: options.assignee,
    project: options.project,
    tags: options.tag ?? [],
    related_paths: options.path,
    depends_on: options.dependsOn ?? [],
  };

  state.plan_items.push(entry);
  saveState(state);
  writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));

  console.log(`✔ Plan item added: [${id}] ${text}`);
}

